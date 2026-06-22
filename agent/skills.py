from __future__ import annotations

import re
from pathlib import Path

import yaml


class SkillsLoader:
    def __init__(self, skills_dir: Path):
        self.skills_dir = skills_dir
        self.skills: dict[str, dict] = {}
        self.reload()

    def reload(self) -> None:
        self.skills = {}
        if not self.skills_dir.exists():
            return
        for f in sorted(self.skills_dir.rglob("SKILL.md")):
            text = f.read_text()
            meta, body = self._parse_frontmatter(text)
            name = meta.get("name", f.parent.name)
            self.skills[name] = {"meta": meta, "body": body, "path": str(f)}

    def _parse_frontmatter(self, text: str) -> tuple[dict, str]:
        match = re.match(r"^---\n(.*?)\n---\n(.*)", text, re.DOTALL)
        if not match:
            return {}, text
        try:
            meta = yaml.safe_load(match.group(1)) or {}
        except yaml.YAMLError:
            meta = {}
        return meta, match.group(2).strip()

    def get_content(self, name: str) -> str:
        skill = self.skills.get(name)
        if not skill:
            return f"Error: Unknown skill '{name}'. Available: {', '.join(self.skills.keys())}"
        return f'<skill name="{name}">\n{skill["body"]}\n</skill>'

    def get_always_skills(self) -> list[str]:
        always_skills = []
        for name, skill in self.skills.items():
            if skill["meta"].get("always", False):
                always_skills.append(name)
        return always_skills

    def load_skills_for_context(self, skill_names: list[str]) -> str:
        parts = []
        for name in skill_names:
            content = self.get_content(name)
            if not content.startswith("Error:"):
                parts.append(content)
        return "\n\n".join(parts) if parts else ""

    def build_skills_summary(self, exclude: set[str] | None = None) -> str:
        exclude = exclude or set()
        if not self.skills:
            return ""
        lines = []
        for name, skill in self.skills.items():
            if name in exclude:
                continue
            desc = _one_sentence(skill["meta"].get("description", "No description"))
            tags = _tags_text(skill["meta"].get("tags", ""))
            line = f"- **{name}**: {desc}"
            if tags:
                line += f" [{tags}]"
            lines.append(line)
        return "\n".join(lines) if lines else ""


def _one_sentence(value: object, *, limit: int = 180) -> str:
    text = " ".join(str(value or "No description").split())
    if not text:
        return "No description"
    match = re.search(r"^(.+?[。.!?！？])(?:\s|$)", text)
    if match:
        text = match.group(1).strip()
    if len(text) <= limit:
        return text
    return text[: limit - 3].rstrip() + "..."


def _tags_text(value: object) -> str:
    if isinstance(value, (list, tuple, set)):
        return ",".join(str(item).strip() for item in value if str(item).strip())
    return str(value or "").strip()
