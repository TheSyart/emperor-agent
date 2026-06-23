from __future__ import annotations

from agent.control.models import ControlMode
from agent.control.plan_policy import PlanDecisionPolicy


def test_plan_decision_requires_plan_for_high_impact_requests() -> None:
    policy = PlanDecisionPolicy()

    decision = policy.assess(
        "重构认证架构，涉及权限模型、数据库迁移和部署流程，验收标准还不明确",
        mode=ControlMode.ASK_BEFORE_EDIT.value,
        has_pending=False,
    )

    assert decision.behavior == "required"
    assert "architecture" in decision.signals
    assert "migration" in decision.signals
    assert "deployment" in decision.signals


def test_plan_decision_recommends_plan_for_feature_scale_work() -> None:
    policy = PlanDecisionPolicy()

    decision = policy.assess(
        "给设置页增加暗色模式开关，需要改 UI、状态管理和测试",
        mode=ControlMode.ASK_BEFORE_EDIT.value,
        has_pending=False,
    )

    assert decision.behavior == "recommended"
    assert "feature" in decision.signals
    assert "multi_step" in decision.signals


def test_plan_decision_proceeds_for_small_or_already_planned_work() -> None:
    policy = PlanDecisionPolicy()

    typo = policy.assess(
        "修复 README 里的一个错别字",
        mode=ControlMode.ASK_BEFORE_EDIT.value,
        has_pending=False,
    )
    provided_plan = policy.assess(
        "PLEASE IMPLEMENT THIS PLAN:\n\n1. 修改 agent/foo.py\n2. 运行 pytest",
        mode=ControlMode.ASK_BEFORE_EDIT.value,
        has_pending=False,
    )

    assert typo.behavior == "proceed"
    assert provided_plan.behavior == "proceed"


def test_plan_decision_proceeds_when_plan_mode_or_pending_interaction_exists() -> None:
    policy = PlanDecisionPolicy()

    in_plan = policy.assess(
        "重构权限系统",
        mode=ControlMode.PLAN.value,
        has_pending=False,
    )
    pending = policy.assess(
        "重构权限系统",
        mode=ControlMode.ASK_BEFORE_EDIT.value,
        has_pending=True,
    )

    assert in_plan.behavior == "proceed"
    assert pending.behavior == "proceed"
