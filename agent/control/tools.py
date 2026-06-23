from __future__ import annotations

import json
from typing import Any

from ..plans import PlanQualityError
from ..tools.base import Tool
from ..tools.schema import ArraySchema, ObjectSchema, StringSchema

CONTROL_PAUSE_PREFIX = "__CONTROL_PAUSE__:"


def make_pause_result(interaction: dict[str, Any]) -> str:
    return CONTROL_PAUSE_PREFIX + json.dumps({"interaction": interaction}, ensure_ascii=False)


def parse_pause_result(value: str) -> dict[str, Any] | None:
    if not isinstance(value, str) or not value.startswith(CONTROL_PAUSE_PREFIX):
        return None
    try:
        raw = json.loads(value[len(CONTROL_PAUSE_PREFIX):])
    except json.JSONDecodeError:
        return None
    interaction = raw.get("interaction") if isinstance(raw, dict) else None
    return interaction if isinstance(interaction, dict) else None


class AskUserTool(Tool):
    name = "ask_user"
    exclusive = True
    requires_runtime_context = True

    def __init__(self, manager):
        self.manager = manager

    @property
    def description(self) -> str:
        return (
            "向用户提出结构化澄清问题并暂停当前 turn。"
            "仅用于影响目标、范围、取舍或验收标准的重要不确定点；"
            "能通过读取项目或搜索确认的事实，不应询问用户。"
            "每次提出 1-3 个问题，每题 2-4 个互斥选项；用户也可自由补充。"
        )

    @property
    def parameters(self) -> dict:
        option = ObjectSchema(
            "可选答案",
            properties={
                "label": StringSchema("用户可选的短标签，建议 1-5 个词", min_length=1, max_length=80),
                "description": StringSchema("选择该项的影响或取舍，单句说明", max_length=240),
            },
            required=["label", "description"],
        )
        question = ObjectSchema(
            "一个澄清问题",
            properties={
                "id": StringSchema("稳定 snake_case/短 id，用于答案映射", min_length=1, max_length=64),
                "header": StringSchema("短标题，最多 12 个汉字或等长文本", min_length=1, max_length=24),
                "question": StringSchema("要问用户的问题，单句表达", min_length=1, max_length=400),
                "options": ArraySchema("2-4 个互斥选项", items=option, min_items=2, max_items=4),
            },
            required=["id", "header", "question", "options"],
        )
        return {
            "type": "object",
            "properties": {
                "questions": ArraySchema(
                    "1-3 个澄清问题",
                    items=question,
                    min_items=1,
                    max_items=3,
                ).to_json_schema(),
                "context": StringSchema(
                    "为什么需要提问的简短上下文，可为空",
                    max_length=1000,
                    nullable=True,
                ).to_json_schema(),
            },
            "required": ["questions"],
        }

    def execute(self, questions: list[dict[str, Any]], context: str | None = None, **kwargs: Any) -> str:
        interaction = self.manager.create_ask(
            questions=questions,
            context=context or "",
            parent_call_id=kwargs.get("parent_call_id"),
        )
        return make_pause_result(interaction.to_dict())


class ProposePlanTool(Tool):
    name = "propose_plan"
    exclusive = True
    requires_runtime_context = True

    def __init__(self, manager):
        self.manager = manager

    @property
    def description(self) -> str:
        return (
            "提交等待用户预览、评论或批准的计划，并暂停当前 turn。"
            "只在 Plan 模式中使用；计划必须完整、可执行、决策明确。"
        )

    @property
    def parameters(self) -> dict:
        step = ObjectSchema(
            "计划步骤",
            properties={
                "id": StringSchema("稳定步骤 id，如 step_1", min_length=1, max_length=64),
                "title": StringSchema("步骤标题", min_length=1, max_length=160),
                "description": StringSchema("步骤说明", max_length=1000, nullable=True),
                "files": ArraySchema(
                    "涉及文件",
                    items=StringSchema("文件路径", max_length=240),
                    max_items=30,
                ),
                "commands": ArraySchema(
                    "验证或执行命令",
                    items=StringSchema("命令", max_length=300),
                    max_items=12,
                ),
                "acceptance": ArraySchema(
                    "验收条件",
                    items=StringSchema("验收条件", max_length=300),
                    max_items=12,
                ),
                "discovery_refs": ArraySchema(
                    "引用的 PlanDiscovery id，用于证明该步骤基于只读探索事实",
                    items=StringSchema("discovery id", max_length=64),
                    max_items=12,
                ),
                "risk": StringSchema("风险级别", enum=["low", "medium", "high"], nullable=True),
                "risk_note": StringSchema("高风险步骤的风险说明", max_length=1000, nullable=True),
                "rollback": StringSchema("高风险步骤的回滚路径或降级方案", max_length=1000, nullable=True),
            },
            required=["id", "title"],
        )
        return {
            "type": "object",
            "properties": {
                "title": StringSchema("计划标题", min_length=1, max_length=160).to_json_schema(),
                "summary": StringSchema("计划摘要", min_length=1, max_length=1200).to_json_schema(),
                "plan_markdown": StringSchema("完整 Markdown 计划正文", min_length=1).to_json_schema(),
                "assumptions": ArraySchema(
                    "明确采用的假设，可为空数组",
                    items=StringSchema("单条假设", max_length=300),
                    max_items=12,
                ).to_json_schema(),
                "risk_level": StringSchema(
                    "风险级别",
                    enum=["low", "medium", "high"],
                ).to_json_schema(),
                "steps": ArraySchema(
                    "结构化执行步骤。每一步必须可验证；复杂项目至少 2 步。",
                    items=step,
                    max_items=30,
                ).to_json_schema(),
            },
            "required": ["title", "summary", "plan_markdown"],
        }

    def execute(
        self,
        title: str,
        summary: str,
        plan_markdown: str,
        assumptions: list[str] | None = None,
        risk_level: str = "medium",
        steps: list[dict[str, Any]] | None = None,
        **kwargs: Any,
    ) -> str:
        try:
            interaction = self.manager.create_plan(
                title=title,
                summary=summary,
                plan_markdown=plan_markdown,
                assumptions=assumptions or [],
                risk_level=risk_level,
                steps=steps or [],
                parent_call_id=kwargs.get("parent_call_id"),
                enforce_quality=True,
            )
        except PlanQualityError as exc:
            return str(exc)
        return make_pause_result(interaction.to_dict())
