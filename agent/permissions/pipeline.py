from __future__ import annotations

from typing import Any

from .models import (
    PermissionDecision,
    PermissionMode,
    PermissionTraceEntry,
    RiskLevel,
    ToolPermissionProfile,
)
from .resolvers import is_high_risk_command, is_sensitive_path, resolve_tool_profile


class PermissionPipeline:
    """Argument-aware permission decision pipeline for tool execution."""

    def assess(
        self,
        tool_name: str,
        arguments: dict[str, Any] | None,
        mode: str,
        *,
        registry=None,
    ) -> PermissionDecision:
        args = arguments or {}
        normalized_mode = _normalize_mode(mode)
        profile = resolve_tool_profile(tool_name, args, registry=registry)
        trace = [_trace("mode.resolve", "matched", normalized_mode)]

        if tool_name == "ask_user":
            trace.append(_trace("control.ask_user", "allow", "ask_user is always available"))
            return _allow(profile, "control.ask_user", trace)

        if tool_name == "propose_plan" and normalized_mode != PermissionMode.PLAN.value:
            trace.append(_trace("control.propose_plan", "deny", "propose_plan is only available in Plan mode"))
            return _deny(
                profile,
                "control.propose_plan",
                "propose_plan is only available in Plan mode.",
                trace,
            )

        if normalized_mode == PermissionMode.AUTO.value:
            trace.append(_trace("mode.auto", "allow", "policy approval disabled for auto mode"))
            return _allow(profile, "mode.auto", trace)

        if normalized_mode == PermissionMode.PLAN.value:
            return self._assess_plan(profile, trace)

        if normalized_mode == PermissionMode.ASK_BEFORE_EDIT.value:
            return self._assess_ask_before_edit(profile, trace)

        trace.append(_trace("mode.unknown", "deny", normalized_mode))
        return _deny(profile, "mode.unknown", f"unknown permission mode: {mode}", trace)

    def is_tool_exposed(self, tool_name: str, mode: str, *, registry=None) -> bool:
        normalized_mode = _normalize_mode(mode)
        if tool_name == "ask_user":
            return True
        if tool_name == "propose_plan":
            return normalized_mode == PermissionMode.PLAN.value
        if normalized_mode != PermissionMode.PLAN.value:
            return True
        if tool_name == "scheduler":
            return True
        if tool_name == "dispatch_subagent":
            tool = registry.get(tool_name) if registry is not None else None
            return bool(getattr(tool, "supports_plan_readonly_exploration", False))
        profile = resolve_tool_profile(tool_name, {}, registry=registry)
        return profile.read_only

    def _assess_plan(
        self,
        profile: ToolPermissionProfile,
        trace: list[PermissionTraceEntry],
    ) -> PermissionDecision:
        if profile.name == "propose_plan":
            trace.append(_trace("plan.control", "allow", "propose_plan submits the PlanCard"))
            return _allow(profile, "plan.control", trace)

        if profile.name == "scheduler":
            if profile.scheduler_action == "list":
                trace.append(_trace("plan.scheduler.list", "allow", "read-only scheduler inspection"))
                return _allow(profile, "plan.scheduler.list", trace)
            trace.append(_trace("plan.scheduler.mutation", "deny", profile.scheduler_action or "<missing action>"))
            return _deny(
                profile,
                "plan.scheduler.mutation",
                "Plan mode only allows scheduler(action='list'); durable job changes require an approved plan.",
                trace,
            )

        if profile.read_only:
            trace.append(_trace("plan.read_only", "allow", "tool profile is read-only"))
            return _allow(profile, "plan.read_only", trace)

        trace.append(_trace("plan.write_block", "deny", "tool profile is not read-only"))
        return _deny(
            profile,
            "plan.write_block",
            "Plan mode only allows read-only tools plus ask_user/propose_plan.",
            trace,
        )

    def _assess_ask_before_edit(
        self,
        profile: ToolPermissionProfile,
        trace: list[PermissionTraceEntry],
    ) -> PermissionDecision:
        if profile.name == "run_command" and is_high_risk_command(profile.command):
            trace.append(_trace("ask.high_risk_command", "approval", profile.command[:160]))
            return _approval(
                profile,
                "ask.high_risk_command",
                f"high-impact shell command: {profile.command[:160]}",
                trace,
            )

        if profile.name in {"spawn_teammate", "broadcast", "shutdown_teammate"}:
            trace.append(_trace("ask.team_roster", "approval", profile.name))
            return _approval(
                profile,
                "ask.team_roster",
                "Agent Team roster or broadcast operation can affect persistent teammates.",
                trace,
            )

        if profile.name == "send_message" and bool(profile.arguments.get("wake", True)):
            trace.append(_trace("ask.team_wake", "approval", "wake=true"))
            return _approval(
                profile,
                "ask.team_wake",
                "waking a teammate can run tools in a persistent teammate context.",
                trace,
            )

        if profile.name == "scheduler":
            return self._assess_scheduler_in_ask_mode(profile, trace)

        if profile.name in {"write_file", "edit_file"} and is_sensitive_path(profile.path):
            trace.append(_trace("ask.sensitive_path", "approval", profile.path or ""))
            return _approval(
                profile,
                "ask.sensitive_path",
                f"sensitive or runtime path: {profile.path}",
                trace,
            )

        if profile.name == "edit_file" and bool(profile.arguments.get("replace_all")):
            trace.append(_trace("ask.bulk_replace", "approval", str(profile.path or "")))
            return _approval(
                profile,
                "ask.bulk_replace",
                f"bulk replace requested in {profile.path}",
                trace,
                risk=RiskLevel.MEDIUM.value,
            )

        trace.append(_trace("ask.default_allow", "allow", "no approval rule matched"))
        return _allow(profile, "ask.default_allow", trace)

    def _assess_scheduler_in_ask_mode(
        self,
        profile: ToolPermissionProfile,
        trace: list[PermissionTraceEntry],
    ) -> PermissionDecision:
        action = profile.scheduler_action
        if action == "list":
            trace.append(_trace("ask.scheduler.list", "allow", "read-only scheduler inspection"))
            return _allow(profile, "ask.scheduler.list", trace)
        if action in {"add", "update", "remove", "pause", "resume", "run"}:
            trace.append(_trace("ask.scheduler.mutation", "approval", action))
            return _approval(
                profile,
                "ask.scheduler.mutation",
                "scheduler jobs persist and may run later outside the current user turn.",
                trace,
                risk=RiskLevel.HIGH.value if action in {"add", "update", "remove", "run"} else RiskLevel.MEDIUM.value,
            )
        trace.append(_trace("ask.scheduler.default", "allow", action or "<missing action>"))
        return _allow(profile, "ask.scheduler.default", trace)


def _normalize_mode(mode: str) -> str:
    if mode in {"", "normal", PermissionMode.ASK_BEFORE_EDIT.value}:
        return PermissionMode.ASK_BEFORE_EDIT.value
    return str(mode or "").strip()


def _trace(rule: str, outcome: str, detail: str = "") -> PermissionTraceEntry:
    return PermissionTraceEntry(rule=rule, outcome=outcome, detail=detail)


def _allow(
    profile: ToolPermissionProfile,
    rule: str,
    trace: list[PermissionTraceEntry],
) -> PermissionDecision:
    return PermissionDecision.allow(
        tool_name=profile.name,
        arguments=profile.arguments,
        rule=rule,
        trace=tuple(trace),
    )


def _deny(
    profile: ToolPermissionProfile,
    rule: str,
    reason: str,
    trace: list[PermissionTraceEntry],
) -> PermissionDecision:
    return PermissionDecision.deny(
        tool_name=profile.name,
        arguments=profile.arguments,
        reason=reason,
        rule=rule,
        trace=tuple(trace),
    )


def _approval(
    profile: ToolPermissionProfile,
    rule: str,
    reason: str,
    trace: list[PermissionTraceEntry],
    *,
    risk: str = RiskLevel.HIGH.value,
) -> PermissionDecision:
    return PermissionDecision.approval(
        tool_name=profile.name,
        arguments=profile.arguments,
        reason=reason,
        risk=risk,
        rule=rule,
        trace=tuple(trace),
    )
