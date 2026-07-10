#!/usr/bin/env python3
from __future__ import annotations

import json
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parent
PROGRESS = ROOT / "2026-07-10-cross-platform-environment-release-implementation.progress.json"
ALLOWED_STATUSES = {"pending", "in_progress", "done", "blocked", "failed"}


def fail(message: str, code: int = 2) -> int:
    print(message, file=sys.stderr)
    return code


def main() -> int:
    if not PROGRESS.exists():
        return fail(f"missing progress file: {PROGRESS}")

    try:
        data = json.loads(PROGRESS.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        return fail(f"invalid progress file: {exc}")

    tasks = data.get("tasks")
    if not isinstance(tasks, dict) or not tasks:
        return fail("progress tasks must be a non-empty object")

    declared_total = data.get("total_tasks")
    if declared_total != len(tasks):
        return fail(
            f"total_tasks mismatch: declared {declared_total!r}, actual {len(tasks)}"
        )

    invalid_statuses: list[str] = []
    unknown_dependencies: list[str] = []
    premature_done: list[str] = []
    done: list[str] = []
    pending: list[str] = []

    for task_id, task in sorted(tasks.items()):
        if not isinstance(task, dict):
            return fail(f"task {task_id} must be an object")

        status = task.get("status")
        if status not in ALLOWED_STATUSES:
            invalid_statuses.append(f"{task_id}={status!r}")
            continue

        dependencies = task.get("depends_on", [])
        if not isinstance(dependencies, list):
            return fail(f"task {task_id} depends_on must be an array")

        missing = [dep for dep in dependencies if dep not in tasks]
        unknown_dependencies.extend(f"{task_id}->{dep}" for dep in missing)

        if status == "done":
            incomplete = [
                dep
                for dep in dependencies
                if dep in tasks and tasks[dep].get("status") != "done"
            ]
            if incomplete:
                premature_done.append(f"{task_id} before {','.join(incomplete)}")
            done.append(task_id)
        else:
            pending.append(task_id)

    if invalid_statuses:
        return fail("invalid statuses: " + ", ".join(invalid_statuses))
    if unknown_dependencies:
        return fail("unknown dependencies: " + ", ".join(unknown_dependencies))
    if premature_done:
        return fail("dependency violations: " + "; ".join(premature_done))

    declared_completed = data.get("completed")
    if declared_completed != len(done):
        return fail(
            f"completed mismatch: declared {declared_completed!r}, actual {len(done)}"
        )

    plan_id = data.get("plan_id", "unknown plan")
    print(f"{len(done)}/{len(tasks)} tasks complete for {plan_id}")

    if pending:
        print("pending: " + ", ".join(pending))
        return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
