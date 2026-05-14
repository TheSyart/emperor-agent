from __future__ import annotations

from typing import Any

from ..tools.base import Tool


_BOOLEAN = {"type": "boolean", "description": "是否立即唤醒目标队友执行"}


class _TeamTool(Tool):
    requires_runtime_context = True

    def __init__(self, manager, *, sender: str = "lead", actor: str = "lead",
                 allow_wake: bool = True):
        self.manager = manager
        self.sender = sender
        self.actor = actor
        self.allow_wake = allow_wake


class TeamSpawnTool(_TeamTool):
    name = "spawn_teammate"
    description = (
        "召入或唤回一个持久队友。队友会写入 .team/config.json，拥有独立 inbox 和 thread。"
        "可选 task 会立即写入队友 inbox 并唤醒执行一次。"
    )
    exclusive = True

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "队友名称，例如 alice"},
                "role": {"type": "string", "description": "队友角色，例如 coder/reviewer/researcher"},
                "task": {"type": ["string", "null"], "description": "初始任务；为空则只创建队友"},
                "agent_type": {"type": ["string", "null"], "description": "可选子代理身份覆盖"},
            },
            "required": ["name", "role"],
        }

    def execute(self, name: str, role: str, task: str | None = None,
                agent_type: str | None = None, emit=None, loop=None,
                parent_call_id=None) -> str:
        return self.manager.spawn_teammate(
            name=name,
            role=role,
            task=task,
            agent_type=agent_type,
            sender=self.sender,
            emit=emit,
            loop=loop,
            parent_call_id=parent_call_id,
        )


class TeamListTool(_TeamTool):
    name = "list_teammates"
    description = "列出当前 Agent Team 成员、状态、未读消息与最近回禀。"
    read_only = True
    requires_runtime_context = False

    @property
    def parameters(self) -> dict[str, Any]:
        return {"type": "object", "properties": {}, "required": []}

    def execute(self) -> str:
        return self.manager.list_teammates()


class TeamSendMessageTool(_TeamTool):
    name = "send_message"
    description = (
        "向 lead 或队友发送一条 Agent Team inbox 消息。Lead 调用时可 wake=true 立即唤醒目标队友；"
        "队友调用时只投递消息，不会递归唤醒其他队友。"
    )
    exclusive = True

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "to": {"type": "string", "description": "接收者：lead 或队友名称"},
                "content": {"type": "string", "description": "消息内容"},
                "wake": _BOOLEAN,
            },
            "required": ["to", "content"],
        }

    def execute(self, to: str, content: str, wake: bool = True, emit=None,
                loop=None, parent_call_id=None) -> str:
        return self.manager.send_message(
            to=to,
            content=content,
            sender=self.sender,
            wake=bool(wake and self.allow_wake),
            emit=emit,
            loop=loop,
            parent_call_id=parent_call_id,
        )


class TeamReadInboxTool(_TeamTool):
    name = "read_inbox"
    description = "读取当前 actor 的 Agent Team inbox。Lead 读 lead，队友读自己的 inbox。"
    exclusive = True
    requires_runtime_context = False

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "limit": {
                    "type": "integer",
                    "description": "最多读取多少条未读消息，默认 20；0 表示读取全部未读",
                    "minimum": 0,
                    "maximum": 100,
                },
                "mark_read": {
                    "type": "boolean",
                    "description": "是否把读取到的消息标记为已读，默认 true",
                },
            },
            "required": [],
        }

    def execute(self, limit: int = 20, mark_read: bool = True) -> str:
        return self.manager.read_inbox(actor=self.actor, limit=limit, mark_read=mark_read)


class TeamBroadcastTool(_TeamTool):
    name = "broadcast"
    description = "向多个队友广播消息；默认发给所有未 shutdown 队友，并可逐个唤醒执行。"
    exclusive = True

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "content": {"type": "string", "description": "广播内容"},
                "recipients": {
                    "type": ["array", "null"],
                    "description": "队友名称列表；为空则发给所有可用队友",
                    "items": {"type": "string"},
                },
                "wake": _BOOLEAN,
            },
            "required": ["content"],
        }

    def execute(self, content: str, recipients: list[str] | None = None,
                wake: bool = True, emit=None, loop=None, parent_call_id=None) -> str:
        return self.manager.broadcast(
            content=content,
            recipients=recipients,
            wake=wake,
            emit=emit,
            loop=loop,
            parent_call_id=parent_call_id,
        )


class TeamShutdownTool(_TeamTool):
    name = "shutdown_teammate"
    description = "关闭一个队友。记录保留，但该队友不再接受任务。"
    exclusive = True

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "队友名称"},
            },
            "required": ["name"],
        }

    def execute(self, name: str, emit=None, loop=None, parent_call_id=None) -> str:
        return self.manager.shutdown_teammate(name=name, emit=emit, loop=loop)
