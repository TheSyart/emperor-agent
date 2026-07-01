#!/usr/bin/env python3
from __future__ import annotations

import json
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parent
PROGRESS = ROOT / "progress.json"


def main() -> int:
    if not PROGRESS.exists():
        print(f"missing progress file: {PROGRESS}", file=sys.stderr)
        return 2

    data = json.loads(PROGRESS.read_text(encoding="utf-8"))
    tasks = data.get("tasks", {})
    pending = [
        task_id
        for task_id, task in sorted(tasks.items())
        if task.get("status") != "done"
    ]

    total = int(data.get("total_tasks", len(tasks)))
    completed = total - len(pending)
    print(f"{completed}/{total} tasks complete")

    if pending:
        print("pending: " + ", ".join(pending))
        return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
