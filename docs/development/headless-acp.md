# Headless ACP operator preview

> 文档状态：Active<br>
> 面向读者：源码维护者、ACP 客户端开发者、自动化操作者<br>
> 最后核验：2026-07-19<br>
> 事实源：`packages/core/src/acp/`、`packages/core/src/api/core-api.ts`、`scripts/build-acp.mjs`、`scripts/test-acp-bundle.mjs`

Emperor Agent 提供一个源码级、默认不随桌面安装包开放的 ACP V1 stdio 入口。它不是旧 Python CLI、HTTP server 或 WebSocket backend 的恢复，而是与 Electron host 并列地创建同一个 TypeScript `CoreApi`，复用同一套 Session、Agent loop、权限、workspace policy、模型配置、记忆和 `stateRoot`。

这一入口当前属于 operator preview：适合在本机由受信 ACP client 拉起，不是多人服务端，也没有远程监听端口。

## 启动

先在仓库根目录安装依赖，然后运行：

```bash
npm ci
npm run headless:acp -- --runtime-root "$PWD"
```

进程从 stdin 读取一行一条的 JSON-RPC 消息，只把 ACP NDJSON 写到 stdout。启动失败和诊断写到 stderr。默认 `runtimeRoot` 是启动命令的当前目录，也可以用 `EMPEROR_AGENT_ROOT` 或 `--runtime-root` 指定；私有数据仍使用默认 `~/.emperor-agent`、`EMPEROR_CONFIG_DIR`，或显式 `--state-root`：

```bash
EMPEROR_CONFIG_DIR=/absolute/private/state \
  npm run headless:acp -- --runtime-root /absolute/emperor-agent
```

模型调用读取该 `stateRoot` 中的 Emperor 模型配置。`initialize` 和创建/加载会话不要求立刻发起模型请求，但 `session/prompt` 没有可用模型时会按 Core 的正常失败语义返回错误。

## 当前协议面

实现使用官方 TypeScript SDK 的稳定 ACP V1 schema，并开放以下方法：

| 方向           | 方法             | 当前语义                                                                |
| -------------- | ---------------- | ----------------------------------------------------------------------- |
| client → agent | `initialize`     | 协商 V1；只声明已实现的 `loadSession` 与纯文本 prompt 能力              |
| client → agent | `session/new`    | 对既存绝对 `cwd` 做 canonical 校验，创建绑定该目录的 Emperor Build 会话 |
| client → agent | `session/load`   | 校验持久 workspace，并在响应前有序发送可见历史投影                      |
| client → agent | `session/prompt` | 把纯文本交给同一 `chat.submit` / mainline turn                          |
| client → agent | `session/cancel` | 取消该 session 当前 prompt，并向模型、工具、进程与 MCP 传播 signal      |
| agent → client | `session/update` | 投影可见文本、思考摘要、工具状态与 context usage                        |

`session/load` 只回放持久事件，不重放 Agent 副作用。实时 `session/update` 与终态响应共用同一有序发送队列；取消或连接关闭后，迟到事件被 terminal fence 丢弃。

## 明确限制

- 只接受 ACP `text` content。image、audio、resource 和 embedded context 当前全部拒绝，能力协商也不会宣称支持。
- 不接受 client 提供的 `mcpServers` 或 `additionalDirectories`。Emperor 自己已配置且通过信任解析的 MCP 仍按 Core 规则工作；客户端不能借 ACP 注入命令或额外根目录。
- 每个 session 同时只允许一个 prompt；不同 session 可以并行。单连接并行 prompt 总量有固定上限，不能由 wire payload 放宽。
- 请求正文、单条 NDJSON 和投影输出都有硬上限。超限或非法 UTF-8 / JSON 会关闭连接，防止无界缓冲。
- JSON-RPC 请求 ID 的精确重试共享同一结果和副作用；同一 method 与 ID 若改用不同参数会被拒绝。终态 ledger 有界，不是永久幂等存储。
- ACP 的工具状态没有 `cancelled` 枚举，因此 Emperor 的工具取消投影为 `failed`，并在 `_meta.emperor.terminalReason` 保留 `cancelled`。prompt 取消使用标准 `stopReason: "cancelled"`。
- 暂停等待 Ask / Plan 交互时返回 `stopReason: "refusal"`，并在 `_meta.emperor.interactionRequired` 标记需要回到当前支持交互的 Emperor 桌面入口处理。
- 当前没有 ACP client 文件系统、terminal、权限请求或会话模式切换能力，也没有桌面设置页中的启用开关。

## 开发与验证

ACP 代码按职责分为：

| 模块                | 责任                                                     |
| ------------------- | -------------------------------------------------------- |
| `node-transport.ts` | 有界 NDJSON、严格 UTF-8 / JSON、背压和 broken-pipe 传播  |
| `adapter.ts`        | ACP request、会话绑定、幂等 ledger、并发和取消           |
| `projector.ts`      | Core runtime event 到 ACP update 的白名单化有界投影      |
| `stdio.ts`          | 一个连接对应一个 `CoreApi` 的启动、settlement 和逆序关闭 |
| `stdio-entry.ts`    | CLI 参数、signal 和 stdout / stderr 约束                 |

执行专项检查：

```bash
npm test --workspace @emperor/core -- src/acp
npm run typecheck --workspace @emperor/core
npm run lint --workspace @emperor/core
npm run build:acp --workspace @emperor/core
node scripts/test-acp-bundle.mjs
```

根质量门禁也会构建并以真实子进程完成 `initialize`、`session/new` 和安全关闭 smoke。修改协议方法、capability、event projection 或取消语义时，必须同步本页、架构总览和 wire / Core E2E 测试。
