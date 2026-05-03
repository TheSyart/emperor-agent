from __future__ import annotations
import re
from pathlib import Path

import yaml


class SkillsLoader:
    def __init__(self, skills_dir: Path):
        self.skills_dir = skills_dir
        self.skills: dict[str, dict] = {}
        self._load_all()

    def _load_all(self) -> None:
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
            desc = skill["meta"].get("description", "No description")
            tags = skill["meta"].get("tags", "")
            line = f"- **{name}**: {desc}"
            if tags:
                line += f" [{tags}]"
            lines.append(line)
        return "\n".join(lines) if lines else ""