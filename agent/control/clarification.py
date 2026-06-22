from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

_IMPLEMENT_PLAN_RE = re.compile(r"please\s+implement\s+this\s+plan|#\s*(summary|key changes|test plan)", re.I)
_CONTROL_RESUME_RE = re.compile(r"^\[CONTROL:(ASK_ANSWERED|PLAN_APPROVED|PLAN_COMMENT|INTERACTION_CANCELLED)\]")
_EXPLICIT_AUTONOMY_RE = re.compile(r"(不用问|不要问|直接做|按你判断|自行决定|你决定|无需确认)")
_BROAD_SCOPE_RE = re.compile(
    r"("
    r"工程化|架构|重构|重新设计|设计.*机制|"
    r"解决以上问题|找到问题作出修改|通读项目|仔细阅读|审计.*修改|"
    r"从头到尾|全链路|全项目|整体.*(优化|完善|改造|提升)|"
    r"(项目|系统|机制|工作流|提示词|agent|Agent).*(优化|完善|改造|评估|审计)|"
    r"(优化|完善|改造|评估|审计).*(项目|系统|机制|工作流|提示词|agent|Agent)"
    r")"
)
_HIGH_IMPACT_RE = re.compile(r"(提交|推送|发布|部署|删除|清空|重置|覆盖|迁移|密钥|权限|付款|成本|生产)")
_LOW_RISK_RE = re.compile(r"(改错别字|修拼写|解释|说明|查看|查询|列出|读一下|review|审查)")


@dataclass
class ClarificationAssessment:
    required: bool = False
    reason: str = ""
    categories: list[str] = field(default_factory=list)
    questions: list[dict[str, Any]] = field(default_factory=list)

    def prompt(self) -> str:
        if not self.required:
            return ""
        lines = [
            "# Ask Guard",
            "当前用户任务存在会影响实现路径的高影响歧义。你可以先使用只读工具理解项目，但在进行写入、派遣子代理、Agent Team 写操作或给出最终答复前，必须调用 `ask_user`。",
            f"触发原因：{self.reason}",
            "推荐问题已经由策略层给出；如你要提问，请直接围绕这些问题调用 `ask_user`，不要用普通文字询问。",
        ]
        return "\n".join(lines)


class ClarificationPolicy:
    """Deterministic guardrails for when the agent must ask before acting."""

    def assess(self, history: list[dict[str, Any]]) -> ClarificationAssessment:
        latest = _latest_user_text(history)
        if not latest:
            return ClarificationAssessment()
        lowered = latest.lower()
        if _CONTROL_RESUME_RE.search(latest) or _IMPLEMENT_PLAN_RE.search(latest):
            return ClarificationAssessment()

        categories: list[str] = []
        if _BROAD_SCOPE_RE.search(latest):
            categories.append("scope")
        if _HIGH_IMPACT_RE.search(latest):
            categories.append("risk")
        if "ui" in lowered or "界面" in latest or "前端" in latest or "视觉" in latest:
            categories.append("ui")

        if not categories:
            return ClarificationAssessment()
        if _LOW_RISK_RE.search(latest) and "risk" not in categories:
            return ClarificationAssessment()
        if _EXPLICIT_AUTONOMY_RE.search(latest) and "risk" not in categories:
            return ClarificationAssessment()
        if _looks_decision_complete(latest):
            return ClarificationAssessment()

        questions = _questions_for(categories)
        reason = "、".join(dict.fromkeys(categories))
        return ClarificationAssessment(required=True, reason=reason, categories=categories, questions=questions)


def _latest_user_text(history: list[dict[str, Any]]) -> str:
    for message in reversed(history):
        if message.get("role") != "user":
            continue
        content = message.get("content")
        if isinstance(content, str):
            return content.strip()
        if isinstance(content, list):
            parts = []
            for item in content:
                if isinstance(item, dict) and item.get("type") == "text":
                    parts.append(str(item.get("text") or ""))
            return "\n".join(parts).strip()
        return str(content or "").strip()
    return ""


def _looks_decision_complete(text: str) -> bool:
    headings = len(re.findall(r"(?m)^#{1,3}\s+", text))
    bullets = len(re.findall(r"(?m)^\s*[-*]\s+", text))
    has_tests = bool(re.search(r"(测试|验收|test plan|tests?)", text, re.I))
    has_interfaces = bool(re.search(r"(api|接口|types?|schema|public interfaces?)", text, re.I))
    return len(text) > 500 and (headings >= 2 or bullets >= 5) and (has_tests or has_interfaces)


def _questions_for(categories: list[str]) -> list[dict[str, Any]]:
    questions = [
        {
            "id": "scope",
            "header": "范围",
            "question": "这次任务的实施边界优先按哪种方式推进？",
            "options": [
                {"label": "完整工程化", "description": "按长期可维护方案处理模块、测试与文档。"},
                {"label": "最小修复", "description": "只修当前可见问题，尽量少动结构。"},
                {"label": "先出方案", "description": "先产出更详细计划，确认后再实施。"},
            ],
        }
    ]
    if "ui" in categories:
        questions.append({
            "id": "ui_priority",
            "header": "前端",
            "question": "涉及界面时，视觉与交互优先级如何取舍？",
            "options": [
                {"label": "产品级体验", "description": "按正式功能页标准打磨布局、状态和响应式。"},
                {"label": "保持现状", "description": "只接入必要状态，不做明显视觉调整。"},
            ],
        })
    if "risk" in categories:
        questions.append({
            "id": "risk_boundary",
            "header": "风险",
            "question": "涉及提交、删除、发布或其他高影响操作时，应该如何控制风险？",
            "options": [
                {"label": "先确认再执行", "description": "列出将影响的对象，得到确认后再继续。"},
                {"label": "按安全默认", "description": "只执行可恢复或低风险部分，高风险操作跳过。"},
            ],
        })
    return questions[:3]
