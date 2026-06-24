from __future__ import annotations

import re
import time
from dataclasses import asdict, dataclass, field, replace

_TOOL_ERROR_HINT = "[Analyze the error above and try a different approach.]"
_VALID_REQUIREMENT_STATUSES = {"pending", "passed", "failed", "skipped"}


@dataclass(frozen=True)
class VerificationRequirement:
    id: str
    kind: str
    required: bool = True
    command: str = ""
    description: str = ""
    status: str = "pending"
    evidence_refs: list[str] = field(default_factory=list)
    reason: str = ""

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, raw: dict) -> VerificationRequirement:
        status = str(raw.get("status") or "pending").strip()
        if status not in _VALID_REQUIREMENT_STATUSES:
            status = "pending"
        return cls(
            id=str(raw.get("id") or raw.get("requirement_id") or "").strip(),
            kind=str(raw.get("kind") or "command").strip() or "command",
            required=bool(raw.get("required", True)),
            command=str(raw.get("command") or "").strip(),
            description=str(raw.get("description") or "").strip(),
            status=status,
            evidence_refs=[str(item) for item in raw.get("evidence_refs") or raw.get("evidenceRefs") or []],
            reason=str(raw.get("reason") or "").strip(),
        )


def requirements_for_step(step) -> list[VerificationRequirement]:
    explicit = [
        item if isinstance(item, VerificationRequirement) else VerificationRequirement.from_dict(item)
        for item in getattr(step, "verification", []) or []
        if isinstance(item, (VerificationRequirement, dict))
    ]
    commands = [str(item) for item in getattr(step, "commands", []) or [] if str(item or "").strip()]
    existing_commands = {_normalize_command(item.command) for item in explicit if item.command}
    legacy = [
        VerificationRequirement(
            id=f"cmd_{index}",
            kind="command",
            required=True,
            command=command,
            description=f"Run `{command}`",
        )
        for index, command in enumerate(commands, start=1)
        if _normalize_command(command) not in existing_commands
    ]
    evidence = [item for item in getattr(step, "evidence", []) or [] if isinstance(item, dict)]
    return [_apply_evidence(requirement, evidence) for requirement in [*explicit, *legacy]]


def _apply_evidence(
    requirement: VerificationRequirement,
    evidence: list[dict],
) -> VerificationRequirement:
    if requirement.status in {"passed", "failed", "skipped"}:
        return requirement
    matched = _matching_evidence(requirement, evidence)
    if matched is None:
        return requirement
    passed = matched.get("passed")
    if passed is True:
        return replace(requirement, status="passed", evidence_refs=_evidence_refs(matched))
    if passed is False:
        return replace(
            requirement,
            status="failed",
            evidence_refs=_evidence_refs(matched),
            reason=str(matched.get("summary") or matched.get("error") or requirement.reason).strip(),
        )
    return requirement


def _matching_evidence(requirement: VerificationRequirement, evidence: list[dict]) -> dict | None:
    for item in reversed(evidence):
        req_id = str(item.get("requirement_id") or item.get("verification_id") or "").strip()
        if req_id and req_id == requirement.id:
            return item
        if requirement.kind == "command" and requirement.command:
            if _normalize_command(str(item.get("command") or "")) == _normalize_command(requirement.command):
                return item
    return None


def _evidence_refs(evidence: dict) -> list[str]:
    refs: list[str] = []
    for key in ("tool_call_id", "task_id", "path", "command"):
        value = str(evidence.get(key) or "").strip()
        if value:
            refs.append(f"{key}:{value}" if key != "command" else value)
    return refs


def _normalize_command(command: str) -> str:
    return " ".join(str(command or "").split())


@dataclass(frozen=True)
class VerificationCommand:
    command: str
    cwd: str | None = None
    timeout_seconds: int = 300

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass(frozen=True)
class VerificationResult:
    command: str
    exit_code: int
    passed: bool
    summary: str
    stdout_tail: str
    stderr_tail: str
    checked_at: float

    @classmethod
    def from_completed(
        cls,
        command: VerificationCommand,
        *,
        exit_code: int,
        stdout: str,
        stderr: str,
    ) -> VerificationResult:
        output = (stdout or stderr or f"exit_code={exit_code}").strip()
        summary = output.splitlines()[-1][:500] if output else f"exit_code={exit_code}"
        return cls(
            command=command.command,
            exit_code=exit_code,
            passed=exit_code == 0,
            summary=summary,
            stdout_tail=stdout[-4000:],
            stderr_tail=stderr[-4000:],
            checked_at=time.time(),
        )

    @classmethod
    def from_tool_output(cls, command: VerificationCommand, content: str) -> VerificationResult:
        text = _strip_tool_error_hint(str(content or "").strip())
        failed: re.Match[str] | None = re.match(
            r"^Error: command exited with code (?P<code>\d+)\n?(?P<body>.*)$",
            text,
            re.DOTALL,
        )
        if failed is not None:
            return cls.from_completed(
                command,
                exit_code=int(failed.group("code")),
                stdout="",
                stderr=failed.group("body").strip(),
            )
        if text.startswith("Error: command timed out"):
            return cls.from_completed(command, exit_code=124, stdout="", stderr=text)
        if text.startswith("Error:"):
            return cls.from_completed(command, exit_code=1, stdout="", stderr=text)
        return cls.from_completed(command, exit_code=0, stdout=text, stderr="")

    def to_dict(self) -> dict:
        return asdict(self)


def _strip_tool_error_hint(text: str) -> str:
    lines = text.splitlines()
    if lines and lines[-1].strip() == _TOOL_ERROR_HINT:
        return "\n".join(lines[:-1]).strip()
    return text


@dataclass(frozen=True)
class VerificationReviewRequest:
    plan_id: str
    changed_files: list[str]
    commands: list[str]
    risk_signals: list[str]
    created_at: float
    reason: str = ""

    def to_dict(self) -> dict:
        return asdict(self)
