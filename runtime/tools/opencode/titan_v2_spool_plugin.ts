import { appendFileSync, mkdirSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { dirname, join } from "node:path"
import type { Plugin } from "@opencode-ai/plugin"

const MCP_SERVER_URL = process.env.TITAN_MCP_SERVER_URL || "http://127.0.0.1:8000"

function defaultSpoolDir(): string {
  const titanHome = process.env.TITAN_HOME || join(process.env.HOME || "", ".titan")
  const agentName = (process.env.TITAN_AGENT_NAME || "opencode").trim() || "opencode"
  return process.env.TITAN_SPOOL_DIR || join(titanHome, "agents", agentName, "traces")
}

function normalizeEventType(eventType: string): string {
  if (eventType.startsWith("message.")) return "message"
  if (eventType.startsWith("tool.")) return "tool_call"
  if (eventType.startsWith("file.")) return "file_edit"
  if (eventType.startsWith("session.")) return "session"
  return eventType.replace(/\./g, "_")
}

function resolveSessionId(event: any): string {
  const candidates = [
    event?.session?.id,
    event?.context?.sessionId,
    event?.sessionID,
    event?.sessionId,
    event?.properties?.sessionID,
    event?.properties?.sessionId,
    event?.properties?.info?.sessionID,
    event?.properties?.info?.sessionId,
    event?.properties?.part?.sessionID,
    event?.properties?.part?.sessionId,
    event?.properties?.status?.sessionID,
    event?.properties?.status?.sessionId,
  ]

  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue
    const cleaned = candidate.trim()
    if (cleaned) return cleaned
  }

  return "default"
}

function writeSpoolEvent(sessionId: string, eventType: string, payload: any): void {
  const target = join(defaultSpoolDir(), `${sessionId}.jsonl`)
  mkdirSync(dirname(target), { recursive: true })
  const traceEvent = {
    session_id: sessionId,
    event_id: randomUUID(),
    event_type: eventType,
    ts: new Date().toISOString(),
    schema_version: "v1",
    payload,
  }
  appendFileSync(target, JSON.stringify(traceEvent) + "\n", { encoding: "utf-8" })
}

function compactText(value: any, limit = 1000): string {
  if (value === undefined || value === null) return ""
  const raw = typeof value === "string" ? value : JSON.stringify(value)
  const cleaned = raw.replace(/\s+/g, " ").trim()
  if (cleaned.length <= limit) return cleaned
  return `${cleaned.slice(0, limit - 3).trimEnd()}...`
}

function compactToolOutput(output: any): any {
  if (output === undefined || output === null) return undefined
  if (typeof output === "string") return { excerpt: compactText(output) }
  if (typeof output !== "object") return { excerpt: compactText(output) }

  return {
    title: compactText(output.title, 200) || undefined,
    metadata: output.metadata,
    error: compactText(output.error || output.stderr, 500) || undefined,
    excerpt: compactText(output.output || output.stdout || output.result || output, 1000),
  }
}

async function fetchMemoriesForContext(sessionId: string, query: string): Promise<string[]> {
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 3000)
    const response = await fetch(
      `${MCP_SERVER_URL}/api/retrieve?q=${encodeURIComponent(query)}&session_id=${encodeURIComponent(sessionId)}&top_k=5`,
      { signal: controller.signal }
    )
    clearTimeout(timeout)
    if (!response.ok) return []
    const data = await response.json() as { memories?: Array<{ text?: string }> }
    return (data.memories || []).map((m) => m.text || "").filter(Boolean)
  } catch {
    return []
  }
}

export const TitanV2SpoolPlugin: Plugin = async ({ directory, client }) => {
  return {
    "session.created": async ({ event }) => {
      try {
        const sessionId = resolveSessionId(event)
        writeSpoolEvent(sessionId, "session_created", {
          raw_type: event.type,
          session_id: sessionId,
        })
        await client.app.log({
          body: {
            service: "titan-v2-spool",
            level: "info",
            message: `Titan session started: ${sessionId}`,
          },
        })
      } catch (err) {
        console.error("[titan] session.created hook failed:", err)
      }
    },

    "session.idle": async ({ event }) => {
      try {
        const sessionId = resolveSessionId(event)
        writeSpoolEvent(sessionId, "session_idle", {
          raw_type: event.type,
          session_id: sessionId,
        })

        const memories = await fetchMemoriesForContext(
          sessionId,
          "current task context summary recent decisions"
        )

        if (memories.length > 0) {
          await client.app.log({
            body: {
              service: "titan-v2-spool",
              level: "info",
              message: `[Titan Memory] Context for next turn:\n${memories.slice(0, 3).join("\n---\n")}`,
            },
          })
        }
      } catch (err) {
        console.error("[titan] session.idle hook failed:", err)
      }
    },

    "session.compacted": async ({ event }) => {
      try {
        const sessionId = resolveSessionId(event)
        writeSpoolEvent(sessionId, "session_compacted", {
          raw_type: event.type,
          session_id: sessionId,
        })
      } catch (err) {
        console.error("[titan] session.compacted hook failed:", err)
      }
    },

    "tool.execute.after": async (input, output) => {
      try {
        const sessionId = input.sessionID || "default"

        const tracePayload = {
          raw_type: "tool.execute.after",
          session_id: sessionId,
          tool: input.tool,
          call_id: input.callID,
          args: input.args || {},
          output: compactToolOutput(output),
        }

        writeSpoolEvent(sessionId, "tool_execution", tracePayload)
      } catch (err) {
        console.error("[titan] tool.execute.after hook failed:", err)
      }
    },

    "message.updated": async ({ event }) => {
      try {
        const sessionId = resolveSessionId(event)
        const properties = event.properties || {}
        const info = properties.info || {}
        const part = properties.part || {}

        const role = info.role || part.role
        if (role !== "assistant") return

        const content = info.content || info.text || part.content || part.text || ""
        if (!content) return

        const messageId = info.id || part.id || randomUUID()

        writeSpoolEvent(sessionId, "assistant_message", {
          raw_type: event.type,
          session_id: sessionId,
          message_id: messageId,
          content,
        })
      } catch (err) {
        console.error("[titan] message.updated hook failed:", err)
      }
    },

    event: async ({ event }) => {
      try {
        const rawType = String(event?.type || "unknown")
        if (
          rawType === "session.diff" ||
          rawType === "message.part.delta" ||
          rawType === "message.part.updated" ||
          rawType === "message.updated" ||
          rawType.startsWith("session.") ||
          rawType.startsWith("tool.")
        ) {
          return
        }
        const sessionId = resolveSessionId(event)
        const eventType = normalizeEventType(rawType)
        writeSpoolEvent(sessionId, eventType, {
          raw_type: rawType,
          summary: compactText(event, 1000),
        })
      } catch (err) {
        console.error("[titan] event hook failed:", err)
      }
    },
  }
}
