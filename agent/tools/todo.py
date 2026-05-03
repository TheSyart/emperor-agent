from __future__ import annotations

from .base import Tool
from .schema import (
    ArraySchema,
    IntegerSchema,
    ObjectSchema,
    StringSchema,
    tool_parameters_schema,
)


_VALID_STATUS = ("pending", "in_progress", "completed")
_STATUS_ICON = {"pending": "[ ]", "in_progress": "[~]", "completed": "[x]"}


def _render(todos: list[dict]) -> str:
    if not todos:
        return "(当前无待办事项)"
    lines = []
    for t in todos:
        icon = _STATUS_ICON.get(t.get("status", "pending"), "[?]")
        lines.append(f"  {icon} {t.get('id')}. {t.get('content', '')}")
    return "\n".join(lines)


class TodoStore:
    """跨用户回合存活的待办列表。不进入 history, compactor 不会丢失。"""

    def __init__(self):
        self.todos: list[dict] = []

    def update(self, items: list[dict]) -> str:
        cleaned: list[dict] = []
        for i, t in enumerate(items, start=1):
            content = (t.get("content") or "").strip()
            if not content:
                continue
            status = t.get("status", "pending")
            if status not in _VALID_STATUS:
                status = "pending"
            cleaned.append({
                "id": t.get("id", i),
                "content": content,
                "status": status,
            })

        in_progress_count = sum(1 for t in cleaned if t["status"] == "in_progress")
        if in_progress_count > 1:
            return "Error: 同一时间只能有一个 in_progress 任务，请重新规划。"

        self.todos = cleaned
        print("\n[计划已更新]")
        print(_render(self.todos))
        print()

        completed = sum(1 for t in self.todos if t["status"] == "completed")
        pending = sum(1 for t in self.todos if t["status"] == "pending")
        summary = (
            f"todos updated: total={len(self.todos)}, completed={completed}, "
            f"in_progress={in_progress_count}, pending={pending}"
        )
        return summary + "\n\n当前列表：\n" + _render(self.todos)

    def render(self) -> str:
        return _render(self.todos)


class UpdateTodosTool(Tool):
    name = "update_todos"
    description = (
        "创建或更新当前差事的 todolist。"
        "传入完整的 todos 数组（每次都是全量覆盖，而非增量）。"
        "用于：拆解多步骤任务、推进任务状态（pending → in_progress → completed）。"
        "约束：同一时间至多一个任务为 in_progress。"
    )

    def __init__(self, store: TodoStore):
        self._store = store

    @property
    def parameters(self) -> dict:
        return tool_parameters_schema(
            todos=ArraySchema(
                "完整的 todo 列表，按执行顺序排列",
                items=ObjectSchema(
                    "单条待办",
                    properties={
                        "id": IntegerSchema("序号，从 1 开始"),
                        "content": StringSchema("这一步要做什么"),
                        "status": StringSchema(
                            "状态",
                            enum=list(_VALID_STATUS),
                        ),
                    },
                    required=["id", "content", "status"],
                ),
            ),
        )

    def execute(self, todos: list[dict]) -> str:
        return self._store.update(todos)
