# W11 · MCP 外部工具（MCP）

依赖：W04　|　子系统映射：`agent/mcp/*`。TS 用官方 `@modelcontextprotocol/sdk`（一等公民，可大幅简化）。

### MIG-MCP-001 · MCP 配置

- **功能点**：读写 `mcp_config.json`、env 展开、server 配置。
- **源(Python)**：`agent/mcp/config.py`（`MCPConfig`/`ServerConfig`、`load_mcp_config`/`save_mcp_config`/`_expand_env`/`_deep_merge`）。
- **目标(TS)**：`packages/core/src/mcp/config.ts`。
- **依赖**：MIG-FND-002
- **设计**：transport=stdio|sse；`_expand_env` 环境变量插值。**磁盘兼容**：`mcp_config.json` schema 不变。
- **风险/复杂度**：S。
- **验证**：移植 mcp config 单测。**验收**：解析/env 展开一致。
- **状态**：todo · PR: —

### MIG-MCP-002 · MCP 连接（stdio / SSE）

- **功能点**：连接外部 server，子进程仅继承白名单 env。
- **源(Python)**：`agent/mcp/connection.py`（`MCPConnection`/`StdioConnection`/`SSEConnection`）。
- **目标(TS)**：`packages/core/src/mcp/connection.ts`（官方 SDK 的 StdioClientTransport/SSEClientTransport）。
- **依赖**：MIG-MCP-001
- **设计**：stdio 子进程仅继承 PATH/HOME/USER… 白名单，不泄 API key；单 server 失败不影响其他。
- **风险/复杂度**：M。
- **验证**：移植连接/env 白名单 单测（mock server）。**验收**：白名单/隔离一致。
- **状态**：todo · PR: —

### MIG-MCP-003 · MCPClient + ToolAdapter（发现 + 注册）

- **功能点**：发现工具，注册为 `mcp_{server}_{tool}`，统一调度，tool_overrides。
- **源(Python)**：`agent/mcp/client.py`（`MCPClient`）、`mcp/adapter.py`（`MCPToolAdapter`）。
- **目标(TS)**：`packages/core/src/mcp/client.ts`、`mcp/adapter.ts`。
- **依赖**：MIG-MCP-002、MIG-TOOL-003
- **设计**：发现工具→包成 Tool 注册到 registry（`mcp_` 前缀，排在 builtin 后）；`tool_overrides` 覆盖 read_only/exclusive。
- **风险/复杂度**：M。
- **验证**：移植 mcp client/adapter 单测（mock）。**验收**：注册名/调度/override 一致。
- **状态**：todo · PR: —
