#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parent
PROGRESS = ROOT / "2026-07-10-cross-platform-environment-release-implementation.progress.json"
ALLOWED_STATUSES = {"pending", "in_progress", "done", "blocked", "failed"}
REQUIRED_TASK_FIELDS = {
    "status",
    "title",
    "depends_on",
    "attempts",
    "started_at",
    "completed_at",
    "commit",
    "receipt",
    "notes",
}
REQUIRED_MILESTONE_FIELDS = {"title", "target_release", "required_tasks"}


def fail(message: str, code: int = 2) -> int:
    print(message, file=sys.stderr)
    return code


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Validate PLAN-EA-XPLAT-002 progress")
    parser.add_argument(
        "--milestone",
        help="validate one milestone instead of requiring every plan task to be done",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
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

    if data.get("schema_version") != 1:
        return fail("unsupported progress schema_version")
    if data.get("plan_id") != "PLAN-EA-XPLAT-002":
        return fail("unexpected plan_id")
    if data.get("plan_version") != "2.1":
        return fail("unexpected plan_version")

    milestones = data.get("milestones")
    if not isinstance(milestones, dict) or not milestones:
        return fail("progress milestones must be a non-empty object")

    for milestone_id, milestone in sorted(milestones.items()):
        if not isinstance(milestone, dict):
            return fail(f"milestone {milestone_id} must be an object")
        missing_fields = sorted(REQUIRED_MILESTONE_FIELDS - milestone.keys())
        if missing_fields:
            return fail(
                f"milestone {milestone_id} missing fields: {', '.join(missing_fields)}"
            )
        required_tasks = milestone.get("required_tasks")
        if not isinstance(required_tasks, list) or not required_tasks:
            return fail(f"milestone {milestone_id} required_tasks must be an array")
        unknown = [task_id for task_id in required_tasks if task_id not in tasks]
        if unknown:
            return fail(
                f"milestone {milestone_id} has unknown tasks: {', '.join(unknown)}"
            )

    invalid_statuses: list[str] = []
    unknown_dependencies: list[str] = []
    premature_done: list[str] = []
    done: list[str] = []
    pending: list[str] = []

    for task_id, task in sorted(tasks.items()):
        if not isinstance(task, dict):
            return fail(f"task {task_id} must be an object")

        missing_fields = sorted(REQUIRED_TASK_FIELDS - task.keys())
        if missing_fields:
            return fail(f"task {task_id} missing fields: {', '.join(missing_fields)}")

        status = task.get("status")
        if status not in ALLOWED_STATUSES:
            invalid_statuses.append(f"{task_id}={status!r}")
            continue

        dependencies = task.get("depends_on", [])
        if not isinstance(dependencies, list):
            return fail(f"task {task_id} depends_on must be an array")

        missing = [dep for dep in dependencies if dep not in tasks]
        unknown_dependencies.extend(f"{task_id}->{dep}" for dep in missing)

        attempts = task.get("attempts")
        if not isinstance(attempts, int) or isinstance(attempts, bool) or attempts < 0:
            return fail(f"task {task_id} attempts must be a non-negative integer")

        if status == "pending" and (
            task.get("started_at") is not None
            or task.get("completed_at") is not None
            or task.get("commit") is not None
            or task.get("receipt") is not None
        ):
            return fail(f"pending task {task_id} contains execution receipt fields")

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

    visiting: set[str] = set()
    visited: set[str] = set()

    def visit(task_id: str) -> None:
        if task_id in visiting:
            raise ValueError(task_id)
        if task_id in visited:
            return
        visiting.add(task_id)
        for dependency in tasks[task_id].get("depends_on", []):
            visit(dependency)
        visiting.remove(task_id)
        visited.add(task_id)

    try:
        for task_id in tasks:
            visit(task_id)
    except ValueError as exc:
        return fail(f"dependency cycle detected at {exc}")

    if premature_done:
        return fail("dependency violations: " + "; ".join(premature_done))

    declared_completed = data.get("completed")
    if declared_completed != len(done):
        return fail(
            f"completed mismatch: declared {declared_completed!r}, actual {len(done)}"
        )

    plan_id = data.get("plan_id", "unknown plan")
    print(f"{len(done)}/{len(tasks)} tasks complete for {plan_id}")

    if args.milestone:
        milestone = milestones.get(args.milestone)
        if milestone is None:
            return fail(f"unknown milestone: {args.milestone}")
        required_tasks = milestone["required_tasks"]
        incomplete = [
            task_id
            for task_id in required_tasks
            if tasks[task_id].get("status") != "done"
        ]
        print(
            f"milestone {args.milestone}: "
            f"{len(required_tasks) - len(incomplete)}/{len(required_tasks)} complete"
        )
        if incomplete:
            print("milestone pending: " + ", ".join(incomplete))
            return 1
        return 0

    if pending:
        print("pending: " + ", ".join(pending))
        return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
