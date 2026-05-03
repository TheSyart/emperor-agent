from __future__ import annotations
from datetime import datetime
from pathlib import Path
from typing import TYPE_CHECKING

from jinja2 import Environment, FileSystemLoader, select_autoescape

from .skills import SkillsLoader

if TYPE_CHECKING:
    from .memory import MemoryStore


class ContextBuilder:
    _BOOTSTRAP_FILES = ["SOUL.md", "USER.md"]

    def __init__(
        self,
        docs_dir: Path,
        skills_loader: SkillsLoader,
        memory: MemoryStore | None = None,
    ):
        self.docs_dir = docs_dir
        self.skills = skills_loader
        self.memory = memory
        self._env = Environment(
            loader=FileSystemLoader(docs_dir / "agent"),
            autoescape=select_autoescape(enabled_extensions=("html",)),
        )

    def render_template(self, name: str, **kwargs) -> str:
        try:
            template = self._env.get_template(name)
            return template.render(**kwargs)
        except Exception:
            return ""

    def build_system_prompt(self) -> str:
        parts = []

        bootstrap = "\n\n".join(
            (self.docs_dir / name).read_text().strip()
            for name in self._BOOTSTRAP_FILES
            if (self.docs_dir / name).exists()
        )
        if bootstrap:
            parts.append(bootstrap)

        identity = self.render_template("identity.md", workspace=str(self.docs_dir.parent))
        if identity:
            parts.append(identity)

        if self.memory:
            memory = self.memory.read_memory().strip()
            if memory:
                parts.append(f"# Long-term Memory\n\n{memory}")

        always_skills = self.skills.get_always_skills()
        if always_skills:
            always_content = self.skills.load_skills_for_context(always_skills)
            if always_content:
                parts.append(f"# Active Skills\n\n{always_content}")

        skills_summary = self.skills.build_skills_summary(exclude=set(always_skills))
        if skills_summary:
            parts.append(
                self.render_template("skills_section.md", skills_summary=skills_summary)
            )

        return "\n\n---\n\n".join(parts)