from __future__ import annotations
import subprocess

from .base import Tool, tool_parameters
from .schema import StringSchema, tool_parameters_schema


@tool_parameters(tool_parameters_schema(
    command=StringSchema("要执行的 shell 命令"),
))
class RunCommand(Tool):
    name = "run_command"
    description = "在终端执行一条 shell 命令并返回输出"
    exclusive = True

    def execute(self, command: str) -> str:
        print(f"[执行命令]: {command}")
        result = subprocess.run(command, shell=True, capture_output=True, text=True)
        output = result.stdout or result.stderr
        print(f"[命令输出]: {output}")
        return output
