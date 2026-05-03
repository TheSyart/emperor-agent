from __future__ import annotations
from pathlib import Path

from .spec import SubagentSpec


# 工具白名单写在代码里, 不放模板中 —— 安全设置不应被无意修改。
# 模板里只写身份/口吻/职责文案。
_BUILTIN_SPECS: dict[str, dict] = {
    "xiaohuangmen": {
        "description": (
            "通传小黄门。轻量只读, 适合短命令、快速确认、跑腿探路。"
            "若发现差事变复杂, 应回禀总管改派专职内官。"
        ),
        "tool_names": (
            "run_command", "read_file", "glob", "grep",
        ),
        "max_turns": 8,
    },
    "sili_suitang": {
        "description": (
            "司礼监随堂小太监。只读文书, 适合阅读代码、查阅文档、"
            "整理提纲、归纳结论。"
        ),
        "tool_names": (
            "load_skill", "read_file", "glob", "grep",
        ),
        "max_turns": 12,
    },
    "dongchang_tanshi": {
        "description": (
            "东厂探事小太监。只读查访, 适合抓网页、查资料、"
            "探索性搜索、比对外部线索。"
        ),
        "tool_names": (
            "run_command", "web_fetch", "load_skill",
            "read_file", "glob", "grep",
        ),
        "max_turns": 15,
    },
    "shangbao_dianbu": {
        "description": (
            "尚宝监典簿小太监。只读核验, 适合盘点文件、校对清单、"
            "检查遗漏、整理表册。"
        ),
        "tool_names": (
            "run_command", "read_file", "glob", "grep",
        ),
        "max_turns": 12,
    },
    "neiguan_yingzao": {
        "description": (
            "内官监营造小太监。可读写可执行命令, 适合修改文件、"
            "搭建工程、跑命令验收。"
        ),
        "tool_names": (
            "run_command", "web_fetch", "load_skill",
            "read_file", "write_file", "edit_file", "glob", "grep",
        ),
        "max_turns": 20,
    },
}

_ALIASES = {
    # 兼容旧版工程代码和历史 prompt 中的身份名。
    "researcher": "dongchang_tanshi",
    "general": "neiguan_yingzao",
}

_DEFAULT_PROMPT = (
    "你是奉总管之命专办一件差事的小太监。\n"
    "- 不必使用'奉天承运皇帝诏曰'前缀, 那是总管对皇上的礼数。\n"
    "- 用工具尽快把差事办妥, 最后用一段简短中文向总管回禀。\n"
    "- 只回禀结论与关键信息, 不要复述每一步细节。\n"
    "- 你不能再派遣其他小太监, 所有差事自己跑工具完成。"
)


class SubagentRegistry:
    """从 templates/subagents/{name}.md 读取 system prompt, 与代码内置的
    工具白名单 / max_turns 配置合并, 构造 SubagentSpec。

    若提供 skills_loader, 在子代理白名单含 load_skill 时, 把 skills 摘要
    注入到 system prompt 末尾, 让子代理知道有哪些技能可加载。"""

    def __init__(self, templates_dir: Path, skills_loader=None):
        self.templates_dir = Path(templates_dir)
        self._skills_loader = skills_loader
        self._specs: dict[str, SubagentSpec] = {}
        self._load_all()

    def _load_all(self) -> None:
        for name, cfg in _BUILTIN_SPECS.items():
            prompt_file = self.templates_dir / f"{name}.md"
            if prompt_file.exists():
                system_prompt = prompt_file.read_text().strip()
            else:
                system_prompt = _DEFAULT_PROMPT

            if self._skills_loader and "load_skill" in cfg["tool_names"]:
                summary = self._skills_loader.build_skills_summary()
                if summary:
                    system_prompt += (
                        "\n\n## 可加载的技能 (load_skill)\n\n"
                        f"{summary}\n\n"
                        "遇到对应专题时, 先调 load_skill 把技能内容拉进上下文。"
                    )

            self._specs[name] = SubagentSpec(
                name=name,
                description=cfg["description"],
                system_prompt=system_prompt,
                tool_names=tuple(cfg["tool_names"]),
                max_turns=cfg["max_turns"],
            )

    def resolve_name(self, name: str) -> str:
        return _ALIASES.get(name, name)

    def get(self, name: str) -> SubagentSpec | None:
        return self._specs.get(self.resolve_name(name))

    def names(self, *, include_aliases: bool = False) -> list[str]:
        names = set(self._specs.keys())
        if include_aliases:
            names.update(_ALIASES.keys())
        return sorted(names)

    def aliases(self) -> dict[str, str]:
        return dict(_ALIASES)

    def describe(self) -> str:
        """给主 agent 工具的 description 用 —— 列出所有可用 subagent。"""
        lines = [
            f"  - {spec.name}: {spec.description}"
            for spec in self._specs.values()
        ]
        if _ALIASES:
            alias_text = ", ".join(f"{k} -> {v}" for k, v in sorted(_ALIASES.items()))
            lines.append(f"  - 兼容别名: {alias_text}")
        return "\n".join(lines)
