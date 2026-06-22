from __future__ import annotations

from pathlib import Path

from agent.control import ControlManager
from agent.permissions import PermissionMode, PermissionPolicy
from agent.scheduler import SchedulerService, SchedulerStore, SchedulerTool
from agent.tools import ReadFileTool, ToolRegistry, WriteFileTool


def make_registry(root: Path) -> ToolRegistry:
    registry = ToolRegistry()
    registry.register(ReadFileTool(root))
    registry.register(WriteFileTool(root))
    registry.register(SchedulerTool(SchedulerService(SchedulerStore(root))))
    return registry


def test_plan_mode_allows_read_tools_and_control_tools(tmp_path: Path) -> None:
    policy = PermissionPolicy()
    registry = make_registry(tmp_path)

    assert policy.assess("read_file", {"path": "README.md"}, PermissionMode.PLAN.value, registry=registry).allowed
    assert policy.assess("ask_user", {}, PermissionMode.PLAN.value, registry=registry).allowed
    assert policy.assess("propose_plan", {}, PermissionMode.PLAN.value, registry=registry).allowed
    assert policy.assess("scheduler", {"action": "list"}, PermissionMode.PLAN.value, registry=registry).allowed

    denied = policy.assess("write_file", {"path": "README.md"}, PermissionMode.PLAN.value, registry=registry)
    scheduler_denied = policy.assess(
        "scheduler",
        {"action": "add", "message": "Run later", "every_seconds": 60},
        PermissionMode.PLAN.value,
        registry=registry,
    )
    assert not denied.allowed
    assert not denied.requires_approval
    assert not scheduler_denied.allowed
    assert "scheduler" in scheduler_denied.reason


def test_ask_before_edit_requires_approval_for_high_risk_command() -> None:
    policy = PermissionPolicy()
    decision = policy.assess(
        "run_command",
        {"command": "git push origin main"},
        PermissionMode.ASK_BEFORE_EDIT.value,
    )

    assert decision.requires_approval
    assert "high-impact shell command" in decision.reason


def test_ask_before_edit_allows_low_risk_tools(tmp_path: Path) -> None:
    policy = PermissionPolicy()

    read = policy.assess("read_file", {"path": "README.md"}, PermissionMode.ASK_BEFORE_EDIT.value)
    write = policy.assess("write_file", {"path": "notes/todo.md"}, PermissionMode.ASK_BEFORE_EDIT.value)

    assert read.allowed
    assert write.allowed


def test_ask_before_edit_requires_approval_for_scheduler_changes() -> None:
    policy = PermissionPolicy()

    list_decision = policy.assess(
        "scheduler",
        {"action": "list"},
        PermissionMode.ASK_BEFORE_EDIT.value,
    )
    add_decision = policy.assess(
        "scheduler",
        {"action": "add", "message": "Check tomorrow", "every_seconds": 3600},
        PermissionMode.ASK_BEFORE_EDIT.value,
    )

    assert list_decision.allowed
    assert add_decision.requires_approval
    assert "persist" in add_decision.reason


def test_ask_before_edit_requires_approval_for_sensitive_path() -> None:
    policy = PermissionPolicy()

    memory_decision = policy.assess(
        "write_file",
        {"path": "memory/history.jsonl"},
        PermissionMode.ASK_BEFORE_EDIT.value,
    )
    dist_decision = policy.assess(
        "write_file",
        {"path": "desktop/out/main/index.js"},
        PermissionMode.ASK_BEFORE_EDIT.value,
    )

    assert memory_decision.requires_approval
    assert "sensitive" in memory_decision.reason
    assert dist_decision.requires_approval


def test_auto_mode_does_not_require_policy_approval() -> None:
    policy = PermissionPolicy()
    decision = policy.assess(
        "run_command",
        {"command": "git push origin main"},
        PermissionMode.AUTO.value,
    )

    assert decision.allowed
    assert not decision.requires_approval


def test_permission_approval_grants_matching_tool_once(tmp_path: Path) -> None:
    manager = ControlManager(tmp_path)
    first = manager.assess_permission(
        "run_command",
        {"command": "git push origin main"},
        registry=None,
    )
    assert first.requires_approval

    marker = manager.permission_approval_result(first, parent_call_id="call_push")
    assert marker.startswith("__CONTROL_PAUSE__:")
    pending = manager.payload()["pending"]
    manager.answer(pending["id"], {"permission": {"choice": "允许", "freeform": ""}})

    allowed = manager.assess_permission(
        "run_command",
        {"command": "git push origin main"},
        registry=None,
    )
    repeated = manager.assess_permission(
        "run_command",
        {"command": "git push origin main"},
        registry=None,
    )

    assert allowed.allowed
    assert not allowed.requires_approval
    assert repeated.requires_approval


def test_permission_denial_blocks_matching_tool_once(tmp_path: Path) -> None:
    manager = ControlManager(tmp_path)
    first = manager.assess_permission(
        "run_command",
        {"command": "git push origin main"},
        registry=None,
    )
    manager.permission_approval_result(first, parent_call_id="call_push")
    pending = manager.payload()["pending"]
    manager.answer(pending["id"], {"permission": {"choice": "拒绝", "freeform": ""}})

    denied = manager.assess_permission(
        "run_command",
        {"command": "git push origin main"},
        registry=None,
    )

    assert not denied.allowed
    assert not denied.requires_approval
    assert "denied" in denied.reason
