# W15 · 传输与前端接线（IPC）

依赖：全部核心波次（W01–W14）　|　子系统映射：`agent/web/*`（app/container/state/guards）+ 17 routes + 11 services + `agent/webui.py`。
**拓扑切换核心波**：把「HTTP/WS server」整体替换为「进程内核心 API + Electron IPC」。原 `origin_guard`/`auth_guard` 随 server 退役。渲染层 Vue 保留，但从 WS/HTTP 改为 IPC。

### MIG-IPC-001 · 进程内核心 API 门面

- **功能点**：定义 `CoreApi` —— 渲染层需要的全部操作的类型化门面（替代 routes）。
- **源(Python)**：`agent/web/container.py`（组合根）+ 17 routes 暴露的操作集合。
- **目标(TS)**：`packages/core/src/api/core-api.ts`（`class CoreApi { chat, sessions, model, plans, control, scheduler, team, external, tasks, memory, projects, skills, diagnostics, … }`）。
- **依赖**：MIG-CORE-011
- **设计**：CoreApi 是进程内单例，方法即原 route handler 的纯逻辑；不含 HTTP。`apps/desktop` 主进程持有它。
- **风险/复杂度**：M。
- **验证**：vitest：CoreApi 方法覆盖原 route 操作清单。**验收**：每条 route 都有对应方法。
- **状态**：todo · PR: —

### MIG-IPC-002 · Electron IPC 桥（main↔renderer）

- **功能点**：ipcMain handlers + preload contextBridge 类型化通道，替代 fetch/WS。
- **源(Python)**：原 `/api/*` 请求语义 + 现 `desktop/src/preload`、`renderer/src/api/{backend,http}.ts`。
- **目标(TS)**：`apps/desktop/src/main/ipc.ts`、`src/preload/index.ts`（`window.emperor` 类型化 invoke）。
- **依赖**：MIG-IPC-001
- **设计**：每个 CoreApi 方法→`ipcMain.handle('emperor:<area>:<op>')`；preload 暴露类型化 invoke；安全错误映射（不泄栈）。
- **风险/复杂度**：M。
- **验证**：集成：renderer 经 IPC 调通各 area。**验收**：无 fetch/WS 残留。
- **状态**：todo · PR: —

### MIG-IPC-003 · 事件流桥（core 事件 → 渲染层推送）

- **功能点**：核心事件总线 → `webContents.send` 推到渲染层，替代 WS 广播。
- **源(Python)**：WS 广播 + `useRuntime.ts` 的 `last_seq` 断线重连。
- **目标(TS)**：`apps/desktop/src/main/event-bridge.ts` + renderer 订阅。
- **依赖**：MIG-IPC-002、MIG-RTE-001,002
- **设计**：进程内订阅事件总线→IPC 推送；**进程内无需断线重连/last_seq**（简化）；渲染层 reducer 复用。
- **风险/复杂度**：M。
- **验证**：集成：发一条消息，事件流到达渲染层、reducer 重放正确。**验收**：事件顺序/字段一致。
- **状态**：todo · PR: —

### MIG-IPC-004 · bootstrap 初始快照

- **功能点**：替代 `/api/bootstrap`：渲染层初始状态快照（含未压缩 runtime events）。
- **源(Python)**：`agent/web/routes`(bootstrap) + `runtime.events` 重放。
- **目标(TS)**：`CoreApi.bootstrap()` + renderer `useBootstrap.ts` 改 IPC。
- **依赖**：MIG-IPC-001、MIG-RTE-002
- **设计**：返回会话、控制态、runtime events（未压缩 turn）等；渲染层据此重建 UI。
- **风险/复杂度**：M。
- **验证**：集成：刷新后状态恢复一致。**验收**：bootstrap 字段与重放一致。
- **状态**：todo · PR: —

### MIG-IPC-005 · MainlineTurnService + ChatService

- **功能点**：聊天回合提交入口（所有入站汇入会话）。
- **源(Python)**：`agent/web/services/mainline_turn.py`、`chat_service.py`、`agent/web/routes/chat.py`。
- **目标(TS)**：`packages/core/src/api/chat-service.ts`。
- **依赖**：MIG-CORE-011、MIG-IPC-001
- **设计**：submit→AgentRunner.step；流式 delta 经事件桥；External/Scheduler 也走 MainlineTurnService 汇入默认会话。
- **风险/复杂度**：M。
- **验证**：移植 `test_project_execution_smoke.py` 思路 + chat 路径集成。**验收**：回合提交/流式一致。
- **状态**：todo · PR: —

### MIG-IPC-006 · 17 routes → CoreApi 方法映射

- **功能点**：逐条把 HTTP route 的纯逻辑搬进 CoreApi 方法。
- **源(Python)**：`agent/web/routes/*`：`chat/control/model/plans/scheduler/sessions/team/external/tasks/memory/projects/skills/sidebar/diagnostics/desktop_pet/assets`。
- **目标(TS)**：`packages/core/src/api/*`（按 area 分模块）。
- **依赖**：对应核心波次（control→W05、model→W01/W02、plans→W05、scheduler→W09、sessions→W07、team→W10、external→W12、tasks→W14、memory→W06、projects→W14、skills→W04、diagnostics→W16、desktop_pet→W16）。
- **设计**：route handler 去掉 aiohttp 包装，纯逻辑入 CoreApi；`assets` 改由 Electron `app://` 协议直供（renderer 资源）。每条 route 一个子清单项，逐条勾。
- **风险/复杂度**：L（面广）。
- **验证**：移植各 route 的 API 单测（`test_web_*_api.py`）为 CoreApi 方法测试。**验收**：每条 route 操作语义一致。
- **状态**：todo · PR: —

### MIG-IPC-007 · 11 services → core services

- **功能点**：把 web/services 的业务逻辑迁入 core。
- **源(Python)**：`agent/web/services/*`：`chat/config/diagnostics/memory/model/skill/team` service + `scheduler_executor`/`scheduler_service`/`mainline_turn`。
- **目标(TS)**：`packages/core/src/api/services/*`。
- **依赖**：MIG-IPC-005 及对应核心波次
- **设计**：service 逻辑与 route 解耦后即纯领域逻辑；scheduler_executor 已在 W09。
- **风险/复杂度**：M。
- **验证**：移植各 service 单测。**验收**：service 行为一致。
- **状态**：todo · PR: —

### MIG-IPC-008 · Mutation guard（IPC 边界）

- **功能点**：pending Ask/Plan 时拒绝执行型 Scheduler/Team/Desktop Pet 操作；plan 模式拒 Scheduler mutation/Team 写/桌宠开关。
- **源(Python)**：`agent/web/mutation_guard.py`。
- **目标(TS)**：`packages/core/src/api/mutation-guard.ts`（在 CoreApi 入口处校验）。
- **依赖**：MIG-IPC-001、MIG-CTRL-002
- **设计**：把原 HTTP mutation guard 逻辑搬到 IPC/CoreApi 边界；WebUI 手动点击视为用户直接操作（不二次弹 AskCard）但仍受此 guard。
- **风险/复杂度**：M。
- **验证**：移植 `test_web_mutation_guard.py`。**验收**：拒绝条件一致。
- **状态**：todo · PR: —

### MIG-IPC-009 · 退役 origin_guard / auth_guard（记录）

- **功能点**：随 server 移除跨站/鉴权中间件。
- **源(Python)**：`agent/web/origin_guard.py`、`auth_guard.py`、`app.py` 中间件链。
- **目标(TS)**：无（删除）；在 README 决策章与本 task 记录「无 server 即无此攻击面，IPC 受 Electron 进程隔离」。
- **依赖**：MIG-IPC-002
- **设计**：确认渲染层不再有可被外部网页触达的入口；preload 仅暴露受控通道。
- **风险/复杂度**：S。
- **验证**：审查：无监听端口、无远程可达入口。**验收**：无 server 监听。
- **状态**：todo · PR: —

### MIG-IPC-010 · 渲染层接线改造（Vue → IPC）

- **功能点**：渲染层从 `apiUrl()/wsUrl()` 改为 IPC；`useRuntime` WS 生命周期→IPC 订阅。
- **源(Python/前端)**：现 `desktop/src/renderer/src/{api,composables/useRuntime.ts,useBootstrap.ts}` + WS 客户端。
- **目标(TS)**：`apps/desktop/src/renderer/...` 改 IPC；`runtime/*` reducer 保留。
- **依赖**：MIG-IPC-002,003,004
- **设计**：去 WS 重连/last_seq；localStorage 仍作热缓存兜底；事件 reducer/selectors 不变。
- **风险/复杂度**：M。
- **验证**：前端 vitest（runtime reducer 不变）+ 手动路径验证（能发消息、关键操作不报错）。**验收**：UI 行为不变、无 WS/HTTP。
- **状态**：todo · PR: —

### MIG-IPC-011 · IPC 边界安全错误映射

- **功能点**：未处理异常只回安全错误 + errorId，详细栈只写日志。
- **源(Python)**：`agent/web/app.py:error_middleware`。
- **目标(TS)**：`apps/desktop/src/main/ipc.ts` 统一 try/catch 包装。
- **依赖**：MIG-IPC-002、MIG-FND-008
- **设计**：renderer 永不收到内部 traceback；errorId 关联日志。
- **风险/复杂度**：S。
- **验证**：集成：抛错只回安全错误。**验收**：无内部栈外泄。
- **状态**：todo · PR: —
