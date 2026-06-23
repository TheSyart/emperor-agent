from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from .models import ControlMode

PlanBehavior = Literal["required", "recommended", "proceed"]


@dataclass(frozen=True)
class PlanDecision:
    behavior: PlanBehavior
    reason: str
    signals: list[str]

    @property
    def triggers(self) -> list[str]:
        return list(self.signals)

    @property
    def suggested_questions(self) -> list[str]:
        if self.behavior == "proceed":
            return []
        if "unclear_acceptance" in self.signals:
            return ["What acceptance criteria or scope boundaries should be confirmed before implementation?"]
        if "architecture" in self.signals or "refactor" in self.signals:
            return ["Which implementation approach or migration boundary should be preferred?"]
        return ["What scope, success criteria, or tradeoffs should be clarified before implementation?"]

    @property
    def recommended_readonly_scopes(self) -> list[str]:
        scopes: list[str] = []
        signal_scopes = {
            "security": "Read authentication, authorization, and permission-related modules before proposing edits.",
            "architecture": "Map the affected architecture, composition roots, and existing extension points.",
            "migration": "Inspect schema, migration, and persistence code before choosing an approach.",
            "deployment": "Inspect deployment, release, scheduler, and environment configuration paths.",
            "destructive": "Search all delete, overwrite, cleanup, and persistence call sites before changing data paths.",
            "refactor": "Trace callers and public contracts before proposing a refactor.",
            "multi_module": "Search each affected module and identify shared interfaces before implementation.",
        }
        for signal in self.signals:
            scope = signal_scopes.get(signal)
            if scope:
                scopes.append(scope)
        if not scopes and self.behavior != "proceed":
            scopes.extend([
                "Search existing implementation patterns and related tests.",
                "Read the most relevant files before proposing edits.",
            ])
        elif "feature" in self.signals or "multi_step" in self.signals:
            scopes.extend([
                "Search existing implementation patterns and related tests.",
                "Read the most relevant files before proposing edits.",
            ])
        return _dedupe(scopes)

    def to_runtime_contract(self) -> dict[str, object]:
        return {
            "decision": self.behavior,
            "reason": self.reason,
            "triggers": self.triggers,
            "suggested_questions": self.suggested_questions,
            "recommended_readonly_scopes": self.recommended_readonly_scopes,
        }


class PlanDecisionPolicy:
    """Deterministic guard for deciding when project work should enter Plan mode."""

    def assess(self, user_message: str, *, mode: str, has_pending: bool) -> PlanDecision:
        text = _normalize(user_message)
        if mode == ControlMode.PLAN.value:
            return PlanDecision("proceed", "Plan mode is already active.", ["already_in_plan"])
        if has_pending:
            return PlanDecision("proceed", "Ask / Plan interaction is already pending.", ["pending_interaction"])
        if _has_provided_plan(text):
            return PlanDecision("proceed", "User provided an implementation plan.", ["user_provided_plan"])
        if _is_small_direct_work(text):
            return PlanDecision("proceed", "Request appears small and direct.", ["small_direct_work"])

        signals = _collect_signals(text)
        if _requires_plan(signals):
            return PlanDecision("required", "High-impact implementation should be planned before writing.", signals)
        if _recommends_plan(signals):
            return PlanDecision("recommended", "Multi-step implementation would benefit from a plan.", signals)
        return PlanDecision("proceed", "No planning guard signal matched.", signals)


def _normalize(text: str) -> str:
    return " ".join(str(text or "").strip().lower().split())


def _has_provided_plan(text: str) -> bool:
    markers = (
        "please implement this plan",
        "implement this plan",
        "执行这个计划",
        "按照这个计划",
        "实施这个计划",
        "## test plan",
        "## implementation",
    )
    return any(marker in text for marker in markers)


def _is_small_direct_work(text: str) -> bool:
    small_markers = (
        "typo",
        "错别字",
        "拼写",
        "readme",
        "注释",
        "console.log",
        "单行",
        "single-line",
    )
    if not any(marker in text for marker in small_markers):
        return False
    return not any(marker in text for marker in ("重构", "架构", "migration", "部署", "权限", "安全"))


def _collect_signals(text: str) -> list[str]:
    checks: list[tuple[str, tuple[str, ...]]] = [
        ("architecture", ("architecture", "architectural", "架构", "系统设计")),
        ("refactor", ("refactor", "restructure", "重构", "改造")),
        ("multi_module", ("multiple modules", "多模块", "跨模块", "全项目", "从头到尾")),
        ("deployment", ("deploy", "deployment", "release", "发布", "部署", "上线")),
        ("destructive", ("delete", "remove", "overwrite", "删除", "覆盖", "清空")),
        ("security", ("permission", "permissions", "security", "auth", "权限", "安全", "认证")),
        ("migration", ("migration", "migrate", "schema", "数据迁移", "迁移", "数据库迁移")),
        ("unclear_acceptance", ("unclear acceptance", "验收不明确", "需求不明确", "范围不清")),
        ("feature", ("feature", "implement", "add ", "新增", "增加", "实现", "添加")),
        ("multi_step", ("测试", "test", "多个步骤", "multi-step", "状态管理", "ui")),
    ]
    signals: list[str] = []
    for signal, markers in checks:
        if any(marker in text for marker in markers):
            signals.append(signal)
    if text.count("、") >= 2 or text.count(",") >= 2:
        signals.append("multi_step")
    return _dedupe(signals)


def _requires_plan(signals: list[str]) -> bool:
    hard = {"architecture", "deployment", "destructive", "security", "migration", "unclear_acceptance"}
    return any(signal in hard for signal in signals) or (
        "refactor" in signals and ("multi_module" in signals or "security" in signals)
    )


def _recommends_plan(signals: list[str]) -> bool:
    return "feature" in signals or "multi_step" in signals or "refactor" in signals or "multi_module" in signals


def _dedupe(items: list[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for item in items:
        if item in seen:
            continue
        seen.add(item)
        result.append(item)
    return result
