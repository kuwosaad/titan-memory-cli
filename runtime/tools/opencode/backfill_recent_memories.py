from __future__ import annotations

import argparse
from datetime import datetime, timedelta, timezone
from typing import Dict, List, Set

from app.save_pipeline import pipeline
from app.storage.memories import load_all_memories
from app.storage.traces import load_events_for_session, load_message_context


def _parse_iso(value: str) -> datetime | None:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def _seed_dedupe_state(session_id: str) -> tuple[Set[str], Set[str]]:
    event_ids: Set[str] = set()
    text_hashes: Set[str] = set()
    for memory in load_all_memories():
        if memory.get("session_id") != session_id:
            continue
        for event_id in memory.get("source_event_ids") or []:
            if isinstance(event_id, str) and event_id:
                event_ids.add(event_id)
        text = str(memory.get("text") or "").strip()
        if text:
            text_hashes.add(pipeline._memory_text_hash(text))
    return event_ids, text_hashes


def _filter_recent_events(events: List[Dict], days: int) -> List[Dict]:
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    result: List[Dict] = []
    for event in events:
        ts = _parse_iso(str(event.get("ts") or ""))
        if ts is None:
            continue
        if ts.astimezone(timezone.utc) >= cutoff:
            result.append(event)
    return result


def backfill_recent_memories(session_id: str, days: int) -> Dict[str, int]:
    events = _filter_recent_events(load_events_for_session(session_id), days)
    if not events:
        return {"events_scanned": 0, "prompt_candidates": 0, "stored_memories": 0, "fallback_memories": 0}

    existing_event_ids, existing_text_hashes = _seed_dedupe_state(session_id)
    role_by_message_id, parent_by_message_id, latest_text_by_message_id = load_message_context(session_id)
    turn = pipeline.get_next_trace_turn(session_id)
    recent_user_text = ""

    counts = {
        "events_scanned": len(events),
        "prompt_candidates": 0,
        "stored_memories": 0,
        "fallback_memories": 0,
        "skipped_existing_event_ids": 0,
    }

    for index, event in enumerate(events):
        message_id, role, parent_id = pipeline._extract_message_updated_metadata(event)
        if message_id and role:
            role_by_message_id[message_id] = role
            if parent_id:
                parent_by_message_id[message_id] = parent_id
            if role == "user":
                user_text_from_update = pipeline._extract_message_updated_text(event)
                if user_text_from_update:
                    latest_text_by_message_id[message_id] = user_text_from_update
                    recent_user_text = user_text_from_update

        message_id, text = pipeline._extract_message_part(event)
        if message_id and text and pipeline._is_latest_message_part_snapshot(events, index, message_id, text):
            latest_text_by_message_id[message_id] = text
            if role_by_message_id.get(message_id) == "user":
                recent_user_text = text

        prompt = pipeline._build_event_prompt(
            event,
            role_by_message_id=role_by_message_id,
            parent_by_message_id=parent_by_message_id,
            latest_text_by_message_id=latest_text_by_message_id,
            events=events,
            index=index,
            fallback_user_text=recent_user_text,
        )
        if prompt is None:
            continue

        event_id = str(event.get("event_id") or "")
        if event_id and event_id in existing_event_ids:
            counts["skipped_existing_event_ids"] += 1
            continue

        counts["prompt_candidates"] += 1
        outcome = pipeline.run_memory_pipeline_outcome(
            session_id=session_id,
            turn=turn,
            user_text=prompt["user_text"],
            assistant_text=prompt["assistant_text"],
            source_event_ids=[event_id] if event_id else None,
            fallback_enabled=True,
            existing_text_hashes=existing_text_hashes,
        )
        records = outcome["records"]
        if not records:
            continue

        counts["stored_memories"] += len(records)
        if outcome.get("fallback_used"):
            counts["fallback_memories"] += len(records)
        if event_id:
            existing_event_ids.add(event_id)
        turn += 1

    return counts


def main() -> None:
    parser = argparse.ArgumentParser(description="Backfill recent memories from existing event ledger.")
    parser.add_argument("--session", default="default", help="Session ID to backfill.")
    parser.add_argument("--days", type=int, default=7, help="Number of trailing days to reprocess.")
    args = parser.parse_args()

    result = backfill_recent_memories(session_id=args.session, days=args.days)
    print(result)


if __name__ == "__main__":
    main()
