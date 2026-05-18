from __future__ import annotations

import re
from typing import Any


_SKILL_NAME_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,80}$")
_MAX_REQUESTED_SKILLS = 5


class SkillRequestError(ValueError):
    pass


def parse_requested_skills(raw: Any, available: set[str]) -> list[str]:
    if raw in (None, ""):
        return []
    if not isinstance(raw, list):
        raise SkillRequestError("requested_skills must be a list")

    names: list[str] = []
    seen: set[str] = set()
    lookup = {name.lower(): name for name in available}
    for item in raw:
        if not isinstance(item, dict):
            raise SkillRequestError("requested_skills items must be objects")
        name = str(item.get("name") or "").strip()
        source = str(item.get("source") or "").strip()
        if source != "slash":
            raise SkillRequestError("requested_skills source must be 'slash'")
        if not _SKILL_NAME_RE.match(name):
            raise SkillRequestError(f"Invalid skill name: {name}")
        canonical = lookup.get(name.lower())
        if canonical is None:
            raise SkillRequestError(f"Unknown skill: {name}")
        if canonical in seen:
            continue
        names.append(canonical)
        seen.add(canonical)
        if len(names) > _MAX_REQUESTED_SKILLS:
            raise SkillRequestError(f"At most {_MAX_REQUESTED_SKILLS} skills can be requested")
    return names


def build_requested_skills_block(skills_loader: Any, skill_names: list[str]) -> str:
    if not skill_names:
        return ""
    parts = [
        "<requested_skills>",
        "用户通过斜杠命令显式要求本轮使用以下 Skill。请把它们视为已加载上下文，必须按这些 Skill 的约束处理本轮任务；不要要求用户再次提供 Skill 内容。",
    ]
    for name in skill_names:
        content = skills_loader.get_content(name)
        if content.startswith("Error:"):
            raise SkillRequestError(content)
        parts.append(content)
    parts.append("</requested_skills>")
    return "\n\n".join(parts)


def inject_requested_skills(content: Any, skill_block: str) -> Any:
    if not skill_block:
        return content
    if isinstance(content, str):
        task = content.strip()
        if task:
            return f"{skill_block}\n\n<user_task>\n{task}\n</user_task>"
        return skill_block
    if isinstance(content, list):
        injected = [dict(item) if isinstance(item, dict) else item for item in content]
        for item in injected:
            if isinstance(item, dict) and item.get("type") == "text":
                item["text"] = f"{skill_block}\n\n{str(item.get('text') or '').strip()}".strip()
                return injected
        return [{"type": "text", "text": skill_block}, *injected]
    return content
