# Emperor Agent 代码审计报告

> 审计日期：2026-07-13（Asia/Shanghai）  
> 审计模式：Standard / Repository / Local Context / Review  
> 审计快照：`main@53a54aaa495f449e78d5d4db996f50db950362a0`  
> 审计方式：只读静态追踪、跨层传播分析、现有测试与类型检查验证

## 1. 执行摘要

本次审计发现 5 个需要处理的问题：

| 严重度 | 数量 | 结论                                                      |
| ------ | ---: | --------------------------------------------------------- |
| P0     |    1 | 外部页面可继承完整 Core IPC，并通过 MCP 配置启动本地进程  |
| P1     |    1 | AUTO 模式可通过脚本间接执行绕过高风险命令审批             |
| P2     |    3 | Scheduler 重复副作用、WebFetch SSRF、启动配置非原子持久化 |
| P3     |    0 | 无                                                        |

最高优先级风险位于 Electron renderer 信任边界：普通 Markdown 外链可以把主窗口导航到远端页面，而 preload 和 Core IPC 权限会继续暴露给该页面。远端页面随后可以切换 AUTO 模式、写入 stdio MCP 配置并触发本地进程启动。这条传播链可由一次普通链接点击触发，属于发布阻断级问题。

建议修复顺序：

1. 封闭 Electron 导航并在 IPC 层认证 sender。
2. 修复 AUTO 模式的脚本间接执行审批绕过。
3. 修复 Scheduler 同任务并发启动问题。
4. 统一 WebFetch 与环境下载器的网络边界校验。
5. 将 Model/MCP 配置迁移到原子写与损坏恢复协议。

## 2. 范围与快照

审计覆盖：

- Electron main、preload、renderer 与 Core IPC 边界。
- Agent runner、Control、Permission、工具注册与执行。
- MCP 配置、连接与 stdio transport。
- Scheduler、ActiveTaskRegistry、Team wake 传播链。
- Model/MCP 配置持久化与启动恢复。
- WebFetch 与环境下载器的网络策略。
- Session history、checkpoint、runtime event replay。
- Environment catalog/download/install 与 release 发布门禁。

明确排除：

- 未读取 `.env`、`~/.emperor-agent`、`memory/`、`sessions/` 或其他私有运行数据。
- 未访问真实模型账号、MCP server、远端 CI 设置或分支保护配置。
- 未执行真实 SSRF、恶意进程启动、破坏性命令或断电模拟。

审计期间外部工作流将初始 `codex/cross-platform-release-v2@8a6d56e` 的 58 个工作区改动提交到了 `main@53a54aaa`。全部最终证据、测试、typecheck、lint 和格式检查均在当前 `main@53a54aaa` 上重新确认。

## 3. 系统边界与安全不变量

### 3.1 关键边界

| 边界                                | 高价值资产                            | 主要入口                                      |
| ----------------------------------- | ------------------------------------- | --------------------------------------------- |
| Renderer → preload → Electron main  | CoreApi、文件系统、桌面能力、私有状态 | `window.emperor`、Core IPC                    |
| Model output → tool runner          | 用户文件、shell、网络、外部系统       | tool calls、Control mode、Permission pipeline |
| Core config → MCP transport         | 本地进程执行、MCP tools               | `mcp.saveConfig`、stdio server command/args   |
| Scheduler → Agent/Team/System       | 自动化任务、持久 inbox、外部副作用    | timer、手动 run、team wake                    |
| Network tool → local/public network | 本地服务、云元数据、模型上下文        | `web_fetch`、redirect、DNS                    |
| State store → startup               | 模型配置、MCP 配置、可启动性          | JSON save/load、CoreHost 初始化               |

### 3.2 审计不变量

- **INV-001：** 只有可信的内置 renderer 可以访问 privileged preload/Core IPC；任何远端导航都不得继承 bridge。
- **INV-002：** 权限审批必须绑定真正承载副作用的输入；脚本或解释器间接执行不得绕过高风险判断。
- **INV-003：** 被拒绝或判定为重复的 Scheduler 任务不得启动任何副作用。
- **INV-004：** 网络工具只能连接经过 DNS、IP 和逐跳 redirect 校验的公共地址，并限制响应总字节数。
- **INV-005：** Boot-critical 配置写入必须原子化；单文件损坏不得阻止整个桌面应用启动。
- **INV-006：** Session history、checkpoint 与 runtime replay 应保持会话隔离和事件顺序。
- **INV-007：** 环境安装只能执行 catalog 绑定且经过完整性验证的产物。
- **INV-008：** Release 发布必须经过 candidate、receipt、SBOM、attestation 和聚合门禁。

## 4. Findings

### 4.1 [P0] 外部链接可让远端页面继承完整 Core IPC，最终执行本地进程

**置信度：** High  
**状态：** Confirmed  
**维度：** L1 / PR-3 / C0  
**违反不变量：** INV-001

#### FACT

- 主窗口配置了 preload、`contextIsolation:true`、`nodeIntegration:false` 和 `sandbox:false`，但没有 `will-navigate`、`will-redirect` 或 `setWindowOpenHandler` 防护：[`desktop/src/main/index.ts:178`](../../desktop/src/main/index.ts#L178)。
- Renderer HTML 没有 `navigate-to` CSP：[`desktop/src/renderer/index.html:1`](../../desktop/src/renderer/index.html#L1)。
- Markdown 使用 `html:false` 和 DOMPurify，能够阻止 HTML 注入，但正常 `https://` Markdown 链接仍会生成，并通过 `v-html` 插入页面：[`MarkdownBlock.vue:5`](../../desktop/src/renderer/src/components/chat/MarkdownBlock.vue#L5)、[`useMarkdown.ts:5`](../../desktop/src/renderer/src/composables/useMarkdown.ts#L5)。
- preload 暴露了 `selectDirectory`、`openPath` 和完整 `invokeCore()`：[`desktop/src/preload/index.ts:5`](../../desktop/src/preload/index.ts#L5)、[`desktop/src/preload/core-ipc.ts:20`](../../desktop/src/preload/core-ipc.ts#L20)。
- Main IPC 注册所有 Core operation，但 listener 忽略了 event，没有验证 sender URL、frame 或 `webContents.id`：[`desktop/src/main/ipc.ts:21`](../../desktop/src/main/ipc.ts#L21)。
- Operation schema 会验证参数形状，但不会验证调用主体：[`packages/core/src/api/operations.ts:224`](../../packages/core/src/api/operations.ts#L224)。
- 远端页面可调用 `control.setMode('auto')`；`mcp.saveConfig` 只受 mutation guard 和可选 Hook 约束，而 mutation guard 仅阻止 pending/plan 状态：[`packages/core/src/api/core-api.ts:557`](../../packages/core/src/api/core-api.ts#L557)、[`packages/core/src/api/mutation-guard.ts:11`](../../packages/core/src/api/mutation-guard.ts#L11)。
- MCP 保存后立即 reload；启用的 stdio server 会将配置中的 command/args 交给 `StdioClientTransport` 启动：[`packages/core/src/api/services/config-service.ts:73`](../../packages/core/src/api/services/config-service.ts#L73)、[`packages/core/src/mcp/client.ts:33`](../../packages/core/src/mcp/client.ts#L33)、[`packages/core/src/mcp/connection.ts:139`](../../packages/core/src/mcp/connection.ts#L139)。

#### REASONING

DOMPurify 保护的是 HTML 注入，不是 Electron 导航边界。普通外链在当前窗口导航后，BrowserWindow 的 preload 配置仍然有效，远端页面因此获得 `window.emperor`。IPC 层没有检查调用来源，参数 schema 只能阻止畸形参数，无法阻止非可信页面调用合法的高权限 operation。

#### 传播路径

```text
模型或网页内容
  → Markdown 外链
  → 用户点击
  → BrowserWindow 导航至远端页面
  → preload 暴露 window.emperor
  → 未认证的 Core IPC
  → control.setMode('auto')
  → mcp.saveConfig(stdio command/args)
  → MCP reload
  → 本地进程启动
```

#### 风险模型

- **触发：** 用户点击一次普通外链；不要求已有 AUTO 配置。
- **爆炸半径：** 当前用户账号及该账号可访问的文件、会话、记忆和本地服务。
- **可恢复性：** 取决于启动进程的行为；可能需要人工终止进程、清理配置和检查数据泄漏。

#### 影响

远程代码执行、私有会话与记忆读取、配置篡改、用户文件访问，以及借助本机凭据进一步访问外部系统。

#### 根因

系统把 renderer 视为永久可信主体，却没有维持 BrowserWindow 导航边界，也没有在 IPC 层重新认证调用来源。

#### 修复策略

1. 对主窗口添加 deny-by-default 的 `will-navigate` 和 `setWindowOpenHandler`。
2. 只允许精确的 `app://bundle` 或显式配置的开发 origin 留在窗口内。
3. HTTP(S) 链接经协议和 hostname 校验后使用 `shell.openExternal`，主窗口始终 `preventDefault()`。
4. IPC handler 校验 `event.senderFrame.url`、顶层 frame 和受信任 `webContents.id`。
5. 缩小 preload surface；不要向任何可能导航的窗口暴露通用 `invokeCore`。

#### 验证建议

- Electron 集成测试点击 Markdown 外链，断言主窗口没有导航。
- 断言远端页面无法访问 `window.emperor`。
- 断言 `target=_blank` 与 `window.open()` 被拒绝或安全转交系统浏览器。
- 断言应用内路由、附件和媒体协议仍正常。

### 4.2 [P1] AUTO 模式可通过脚本文件绕过高风险命令审批

**置信度：** High  
**状态：** Confirmed，触发前提为用户启用 AUTO  
**维度：** L1 / PR-3 / C0  
**违反不变量：** INV-002

#### FACT

- AUTO 模式仅在 `isHighRiskCommand()` 识别出直接危险命令时要求审批，其余工具调用直接允许：[`packages/core/src/permissions/pipeline.ts:90`](../../packages/core/src/permissions/pipeline.ts#L90)。
- 高风险判断只解析有限命令头和子命令；`bash payload.sh`、`sh payload.sh` 不属于高风险：[`packages/core/src/tools/resolvers.ts:201`](../../packages/core/src/tools/resolvers.ts#L201)。
- `RunCommand` 使用有限正则黑名单检查外层命令；拒绝文案还建议“把代码写入临时脚本文件后执行”：[`packages/core/src/tools/builtin.ts:327`](../../packages/core/src/tools/builtin.ts#L327)。
- `write_file` 可以在工作区创建脚本：[`packages/core/src/tools/filesystem.ts:135`](../../packages/core/src/tools/filesystem.ts#L135)。
- Runner 完成 permission 判断后直接执行工具：[`packages/core/src/agent/runner.ts:1353`](../../packages/core/src/agent/runner.ts#L1353)。
- `RunCommand` 最终使用 shell `exec(command)`；cwd、最小环境变量和 120 秒超时都不是文件系统或网络沙箱：[`packages/core/src/tools/builtin.ts:371`](../../packages/core/src/tools/builtin.ts#L371)。

#### REASONING

权限系统检查的是 `bash payload.sh` 这一层命令文本，而真正的副作用存在于脚本文件内容中。AUTO 会允许 `write_file` 和未被分类为高风险的 interpreter invocation，因此脚本内的 `curl`、`rm`、外部路径读取或其他进程启动都不会触发预期审批。

#### 传播路径

```text
提示注入或模型误判
  → write_file(payload.sh, dangerous content)
  → run_command("bash payload.sh")
  → AUTO 自动允许
  → shell 以当前用户权限执行脚本
```

#### 风险模型

- **触发：** 用户开启 AUTO；模型产生两步脚本调用。
- **爆炸半径：** 当前用户账号、工作区外文件、网络与外部系统。
- **可恢复性：** 取决于脚本行为，外传、删除或发布操作可能不可逆。

#### 影响

绕过产品宣称的“高风险 shell 命令仍需审批”保护，执行任意用户级 shell 副作用。

#### 根因

审批绑定外层命令字符串，而不是最终承载副作用的代码、脚本摘要、解释器和执行目标。

#### 修复策略

1. AUTO 下所有 `run_command` 默认要求审批；或改用受 catalog 约束的 executable + argv 模型。
2. 将 shell、解释器、工作区脚本及未知 executable 视为高风险。
3. 审批绑定脚本规范化内容、摘要、argv、cwd 和环境快照；审批后脚本变化必须使授权失效。
4. 删除建议通过临时脚本执行被安全策略拒绝内容的提示。
5. 高权限执行使用操作系统级 sandbox，而不是依赖环境变量裁剪和字符串黑名单。

#### 验证建议

- AUTO 端到端测试创建包含危险内容的脚本，再执行 `bash script.sh`，必须暂停或拒绝。
- 审批后修改脚本，必须重新审批。
- 增加 `sh`、`zsh`、PowerShell、工作区 executable 和脚本嵌套调用测试。

### 4.3 [P2] Scheduler 重复任务被拒绝后，副作用 Promise 仍会执行

**置信度：** High  
**状态：** Confirmed  
**维度：** L1 / PR-3 / C0  
**违反不变量：** INV-003

#### FACT

- 手动运行与 timer 路径没有 per-job mutex：[`packages/core/src/scheduler/service.ts:198`](../../packages/core/src/scheduler/service.ts#L198)。
- Executor 在调用 `ActiveTaskRegistry.run()` 前已经通过 `Promise.resolve().then()` 调度 `dispatch()`：[`packages/core/src/scheduler/executor.ts:71`](../../packages/core/src/scheduler/executor.ts#L71)。
- Registry 检测重复 taskId 后抛错，但无法撤销已经排入微任务队列的 dispatch：[`packages/core/src/runtime/active.ts:38`](../../packages/core/src/runtime/active.ts#L38)。
- `team_wake` 调用 `sendMessage()`：[`packages/core/src/scheduler/executor.ts:157`](../../packages/core/src/scheduler/executor.ts#L157)。
- TeamManager 先持久化消息，之后才检查 teammate 是否正在工作：[`packages/core/src/team/manager.ts:208`](../../packages/core/src/team/manager.ts#L208)。

#### REASONING

第二次调用虽然会因重复 `scheduler:<jobId>` 被 Registry 拒绝，但它的 dispatch Promise 已经启动。Registry 只能阻止跟踪和等待，不能阻止该 Promise 继续发送 Team 消息或产生其他系统副作用。

#### 传播路径

```text
双击运行或手动/timer 碰撞
  → 两个 executeJob
  → 两个 dispatch Promise 已排队
  → Registry 拒绝第二个 taskId
  → 第二个 dispatch 仍执行
  → 重复消息或未跟踪副作用
```

#### 风险模型

- **触发：** 同一 job 的并发手动运行，或 timer 与手动运行竞争。
- **爆炸半径：** 当前 Scheduler job、目标 teammate，以及该任务后续调用的工具和外部系统。
- **可恢复性：** 重复 inbox 消息会持久化；外部副作用可能需要人工回滚。

#### 影响

Scheduler 状态可能记录第二次执行失败，但实际副作用已经发生，破坏 at-most-once 语义和审计一致性。

#### 根因

ActiveTaskRegistry 接收已经启动的 Promise，而不是成功注册唯一任务后才调用的惰性 thunk。

#### 修复策略

1. 将 Registry API 改为 `execute: () => Promise<T>`，成功注册后才调用。
2. SchedulerService 增加 per-job in-flight lease 或 mutex。
3. 重复调用应明确返回 busy/conflict，不创建 task record，不改变 job 运行状态。

#### 验证建议

- 用 deferred Promise 并发运行同一 `team_wake` 两次，断言 `sendMessage` 只调用一次。
- 覆盖手动/手动与手动/timer 两种竞争。
- 断言第二次调用不产生持久消息、task record 或错误运行记录。

### 4.4 [P2] WebFetch 的 SSRF 防护可被 IPv6、DNS 和重定向绕过

**置信度：** High  
**状态：** Confirmed，数据影响取决于本地可访问服务  
**维度：** L1 / PR-3 / C1  
**违反不变量：** INV-004

#### FACT

- WebFetch 只比较少量 hostname 字符串，没有 DNS 解析、完整网段判断或 redirect 逐跳校验：[`packages/core/src/tools/builtin.ts:22`](../../packages/core/src/tools/builtin.ts#L22)。
- 当前 Node 中 `new URL('http://[::1]').hostname` 返回 `[::1]`，代码比较的是 `::1`，IPv6 loopback 可直接通过。
- `127.0.0.2`、`169.254.169.254`、`0.0.0.0` 和解析到私网的域名也没有被覆盖。
- `fetch()` 未设置 `redirect:'manual'`，会跟随重定向；响应先完整执行 `resp.text()`，之后才截取 30,000 字符。
- 仓库已有 DNS、IP BlockList、redirect 逐跳校验和大小限制实现，但 WebFetch 未复用：[`packages/core/src/environment/download.ts:63`](../../packages/core/src/environment/download.ts#L63)、[`packages/core/src/environment/download.ts:202`](../../packages/core/src/environment/download.ts#L202)。

#### REASONING

字符串级 hostname 检查既不知道域名最终解析地址，也无法控制重定向后的目的地。输出字符截断发生在完整响应进入内存之后，不能形成传输大小边界。

#### 传播路径

```text
用户内容或提示注入
  → web_fetch(私网地址或公共重定向)
  → 本地服务/云元数据响应
  → Agent 上下文
  → 云端模型或 UI
```

#### 风险模型

- **触发：** 模型调用 `web_fetch` 访问特制 URL。
- **爆炸半径：** 本地无认证服务、云元数据、开发服务及模型上下文。
- **可恢复性：** 数据泄漏不可撤销；超大响应造成的内存压力通常可通过重启恢复。

#### 影响

本地服务与元数据泄露、提示注入传播，以及通过无界响应造成内存压力。

#### 根因

把 URL 字符串过滤当成实际网络连接边界，没有校验解析地址和每次重定向。

#### 修复策略

1. 复用 hardened downloader 的公共地址解析和 BlockList。
2. 每个 redirect hop 重新解析并校验，连接时固定到已验证地址。
3. 禁止 loopback、private、link-local、CGNAT、multicast、IPv4-mapped IPv6 和 `.local`。
4. 使用流式读取及硬字节上限；不要先完整 `resp.text()`。

#### 验证建议

- 增加 `[::1]`、`127.0.0.2`、`169.254.169.254`、私网 DNS 与 IPv4-mapped IPv6 测试。
- 增加公共地址跳转至私网、相对 redirect 与 DNS rebinding 测试。
- 增加无 `content-length` 超大流和声明长度超限测试。

### 4.5 [P2] Model/MCP 配置非原子覆盖，损坏后会阻断桌面端启动

**置信度：** High  
**状态：** Confirmed  
**维度：** L1 / PR-3 / C0  
**违反不变量：** INV-005

#### FACT

- `model_config.json` 直接写最终文件，读取时直接 `JSON.parse`：[`packages/core/src/config/model-config.ts:462`](../../packages/core/src/config/model-config.ts#L462)。
- `mcp_config.json` 使用 `writeFileSync` 覆盖最终文件，读取时也没有损坏隔离：[`packages/core/src/mcp/config.ts:35`](../../packages/core/src/mcp/config.ts#L35)。
- 两个文件都位于 AgentLoop 启动关键路径：[`packages/core/src/agent/loop.ts:430`](../../packages/core/src/agent/loop.ts#L430)。
- CoreHost 初始化失败后桌面应用显示错误并退出：[`desktop/src/main/index.ts:337`](../../desktop/src/main/index.ts#L337)。
- 仓库已有临时文件加 rename、损坏隔离与 fallback 实现：[`packages/core/src/store/atomic-json.ts:55`](../../packages/core/src/store/atomic-json.ts#L55)。

#### REASONING

直接覆盖最终文件时，进程终止、断电或存储错误可能留下空文件或截断 JSON。下一次启动会在构建 ModelRouter 或初始化 MCP 时抛错，错误传播到 Electron startup 并退出整个应用。

#### 传播路径

```text
配置保存
  → 进程终止/断电/磁盘错误
  → 最终 JSON 截断
  → 下次启动 JSON.parse 抛错
  → CoreHost 初始化失败
  → 桌面应用退出
```

#### 风险模型

- **触发：** 配置保存期间进程崩溃、系统断电、磁盘写失败或空间耗尽。
- **爆炸半径：** 当前 Emperor Agent 实例及其全部会话入口。
- **可恢复性：** 数据仍在本地，但通常需要用户手工定位、修复或删除私有配置。

#### 影响

持久性启动拒绝服务，并可能丢失模型或 MCP 配置。

#### 根因

Boot-critical 状态没有统一使用仓库已有的原子存储和损坏恢复协议。

#### 修复策略

1. 使用同目录临时文件、必要的 flush/fsync 和 rename 替换。
2. 保留 last-known-good 或轮换备份。
3. 读取失败时隔离损坏文件，记录 diagnostics，并进入“需要重新配置”状态，而不是退出应用。
4. 保持包含 API key 的模型配置文件权限不被放宽。

#### 验证建议

- 在临时写入后、rename 前注入异常，旧配置必须保持完整可读。
- 使用截断 JSON 启动 CoreApi，应用应成功进入恢复状态并生成明确诊断。
- 验证损坏文件被隔离、默认值正确加载、旧 secret 文件权限保持不变。

## 5. 关键路径覆盖

| ID     | 关键路径                                           | 关键级别 | 覆盖状态 | 结果                   |
| ------ | -------------------------------------------------- | -------- | -------- | ---------------------- |
| CP-001 | Renderer → preload → IPC → Core/MCP                | C0       | Complete | Finding 4.1            |
| CP-002 | Agent turn → Permission → filesystem/shell         | C0       | Complete | Finding 4.2            |
| CP-003 | Scheduler manual/timer → Team/Agent/System         | C0       | Complete | Finding 4.3            |
| CP-004 | WebFetch → network → model context                 | C1       | Complete | Finding 4.4            |
| CP-005 | Config save → stateRoot → startup                  | C0       | Complete | Finding 4.5            |
| CP-006 | Session history/checkpoint/runtime replay          | C0/C1    | Complete | 未确认新问题           |
| CP-007 | Environment catalog/download/install               | C0       | Complete | 未确认新问题           |
| CP-008 | Release candidate/receipt/SBOM/attestation/publish | C0       | Partial  | 未核对远端 CI/分支保护 |

C0/C1 覆盖率：7/8 Complete，1/8 Partial。

“未确认新问题”仅表示本次审计没有形成满足证据门槛的 finding，不代表该路径经过形式化证明或不存在其他缺陷。

## 6. 验证记录

以下命令在 `main@53a54aaa` 上执行并通过：

```bash
npm test --workspace @emperor/core
npm run typecheck --workspace @emperor/core
npm run lint --workspace @emperor/core

npm --prefix desktop run test
npm --prefix desktop run typecheck
npm --prefix desktop run lint

npm run format:check
git diff --check
```

结果：

- Core：108 个测试文件、912 项测试通过。
- Desktop：72 个测试文件、343 项测试通过。
- Core/Desktop typecheck 通过。
- Core/Desktop lint 通过。
- Prettier format check 通过。
- `git diff --check` 通过。

现有测试未覆盖以下关键回归场景：

- Electron 外链导航与远端页面 preload 隔离。
- AUTO 模式下的脚本间接执行。
- 同 Scheduler job 并发运行。
- WebFetch IPv6、DNS、redirect 与响应大小边界。
- Model/MCP 配置写入故障与损坏启动恢复。

## 7. 未执行项与不确定性

本次没有执行：

- `make check`、desktop build、package 和 screenshots。
- 打包后 Electron 外链交互测试。
- 真实私网 SSRF 或云元数据访问。
- 真实恶意 MCP process、shell payload 或外部写操作。
- 断电、磁盘耗尽或进程 kill 故障注入。
- GitHub 远端 required checks、environment approval 和 branch protection 核对。

因此，本报告不对上述动态环境或远端治理配置作通过声明。

## 8. 建议的修复验收门禁

修复完成前建议将以下用例加入必跑门禁：

1. Electron trusted-origin 与 IPC sender 集成测试。
2. AUTO script indirection 的权限回归测试。
3. Scheduler same-job concurrency 测试。
4. WebFetch SSRF 与流式大小限制测试。
5. Model/MCP atomic-write 故障注入与启动恢复测试。
6. 完整执行 `make check`，涉及 Electron 安全边界时额外执行打包后 smoke/integration 测试。
