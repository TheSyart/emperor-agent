import pytest

from agent.permissions.models import PermissionBehavior, PermissionDecision
from agent.permissions.pipeline import PermissionPipeline


class FakeTool:
    def __init__(self, read_only: bool) -> None:
        self.read_only = read_only


class FakeRegistry:
    def __init__(self, read_only: bool) -> None:
        self.tool = FakeTool(read_only)

    def get(self, name: str):
        return self.tool


@pytest.fixture
def fake_registry():
    return lambda read_only: FakeRegistry(read_only)


def test_behavior_ask_keeps_requires_approval_compatibility() -> None:
    decision = PermissionDecision.ask(
        tool_name="run_command",
        reason="high impact",
        arguments={"command": "git push"},
    )

    assert decision.behavior == PermissionBehavior.ASK.value
    assert decision.requires_approval is True
    assert decision.allowed is False


def test_pipeline_denies_plan_write_tool() -> None:
    pipeline = PermissionPipeline()

    decision = pipeline.assess("write_file", {"path": "a.txt"}, mode="plan", registry=None)

    assert decision.behavior == PermissionBehavior.DENY.value
    assert "Plan mode" in decision.reason


def test_pipeline_allows_read_tool_in_plan_mode(fake_registry) -> None:
    pipeline = PermissionPipeline()

    decision = pipeline.assess("read_file", {"path": "README.md"}, mode="plan", registry=fake_registry(read_only=True))

    assert decision.behavior == PermissionBehavior.ALLOW.value
