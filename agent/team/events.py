from __future__ import annotations

from typing import Any

from .models import TeamMember, TeamMessage


def member_update(member: TeamMember) -> dict[str, Any]:
    return {"event": "team_member_update", "member": member.to_dict()}


def message_event(message: TeamMessage) -> dict[str, Any]:
    return {"event": "team_message", "message": message.to_dict()}


def run_start(*, parent_id: str | None, member: TeamMember, purpose: str) -> dict[str, Any]:
    return {
        "event": "team_run_start",
        "parent_id": parent_id,
        "teammate": member.name,
        "role": member.role,
        "agent_type": member.agent_type,
        "purpose": purpose,
    }


def run_delta(*, parent_id: str | None, member: TeamMember, delta: str) -> dict[str, Any]:
    return {
        "event": "team_run_delta",
        "parent_id": parent_id,
        "teammate": member.name,
        "delta": delta,
    }


def run_tool_call(
    *,
    parent_id: str | None,
    member: TeamMember,
    id: str | None,
    name: str,
    arguments: dict[str, Any] | None,
) -> dict[str, Any]:
    return {
        "event": "team_run_tool_call",
        "parent_id": parent_id,
        "teammate": member.name,
        "id": id,
        "name": name,
        "arguments": arguments or {},
    }


def run_tool_result(
    *,
    parent_id: str | None,
    member: TeamMember,
    id: str | None,
    name: str | None,
    summary: str,
) -> dict[str, Any]:
    return {
        "event": "team_run_tool_result",
        "parent_id": parent_id,
        "teammate": member.name,
        "id": id,
        "name": name,
        "summary": summary,
    }


def run_tool_error(
    *,
    parent_id: str | None,
    member: TeamMember,
    id: str | None,
    name: str | None,
    message: str,
) -> dict[str, Any]:
    return {
        "event": "team_run_tool_error",
        "parent_id": parent_id,
        "teammate": member.name,
        "id": id,
        "name": name,
        "message": message,
    }


def run_done(*, parent_id: str | None, member: TeamMember, summary: str) -> dict[str, Any]:
    return {
        "event": "team_run_done",
        "parent_id": parent_id,
        "teammate": member.name,
        "summary": summary,
    }


def run_error(*, parent_id: str | None, member: TeamMember, message: str) -> dict[str, Any]:
    return {
        "event": "team_run_error",
        "parent_id": parent_id,
        "teammate": member.name,
        "message": message,
    }
