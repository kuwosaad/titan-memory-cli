from __future__ import annotations

import os
import sys
from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parents[2]

if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from tools.opencode.install_plugin import install_opencode_plugin
from tools.cli.titan import configure_runtime_for_agent


def main() -> None:
    configure_runtime_for_agent(os.getenv("TITAN_AGENT_NAME", "opencode"))
    result = install_opencode_plugin(scope="project", root_dir=ROOT_DIR)
    print(f"[titan] Plugin {result['status']}: {result['target_path']}")
    os.environ.setdefault("TITAN_AUTO_INGEST_ENABLED", "1")
    os.environ.setdefault("TITAN_AUTO_INGEST_INTERVAL_SECONDS", "3")
    os.execv(sys.executable, [sys.executable, str(ROOT_DIR / "entrypoints" / "main.py")])


if __name__ == "__main__":
    main()
