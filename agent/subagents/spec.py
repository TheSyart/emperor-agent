from __future__ import annotations
from dataclasses import dataclass, field


@dataclass(frozen=True)
class SubagentSpec:
    """一种子代理身份的完整定义。

    `tool_names` 是工具白名单, **绝不应包含** `dispatch_subagent` (防递归)
    与 `update_todos` (todolist 是主 agent 的状态)。
    """
    name: str
    description: str
    system_prompt: str
    tool_names: tuple[str, ...] = field(default_factory=tuple)
    max_turns: int = 15
