# 迁移主追踪表（STATUS）

> 共 **116** 个 task / 18 波。状态：`todo` · `wip` · `done` · `blocked`。领 task 前确认其依赖波次已 `done`。
> 改状态时回填 PR；一个波次全 `done` 解锁下游。详情见各 `waves/W*.md`。

图例：☐ todo ・ ◐ wip ・ ☑ done ・ ⛔ blocked

## W00 基础（FND） · 依赖 — · ✅ 全部完成（26 vitest 绿，tsc 0）
| ID | 标题 | 状态 |
|---|---|---|
| MIG-FND-001 | monorepo/工具链骨架（npm workspaces） | ☑ |
| MIG-FND-002 | 原子 JSON store + 腐坏隔离 | ☑ |
| MIG-FND-003 | 文件锁（O_EXCL，零依赖） | ☑ |
| MIG-FND-004 | id/时间工具 | ☑ |
| MIG-FND-005 | 类型化事件总线 | ☑ |
| MIG-FND-006 | 结构化日志 | ☑ |
| MIG-FND-007 | JSONL append + 归档 | ☑ |
| MIG-FND-008 | 错误/结果基类型 | ☑ |

## W01 配置/模型路由（CFG） · 依赖 W00 · ✅ 全部完成（12 vitest 绿，tsc 0）
| ID | 标题 | 状态 |
|---|---|---|
| MIG-CFG-001 | local_config | ☑ |
| MIG-CFG-002 | model_config 模型+解析/校验 | ☑ |
| MIG-CFG-003 | model_config IO（脱敏待 W15） | ☑ |
| MIG-CFG-004 | ModelRouter | ☑ |

## W02 Providers（PROV） · 依赖 W01
| ID | 标题 | 状态 |
|---|---|---|
| MIG-PROV-001 | LLMProvider 基类+转换 | ☑ |
| MIG-PROV-002 | Provider Spec 注册表 | ☑ |
| MIG-PROV-003 | OpenAI-compat(+子类) | ☑ |
| MIG-PROV-004 | Anthropic(缓存/重试) | ☑ |
| MIG-PROV-005 | Bedrock(system/拒tools/重试) | ☑ |
| MIG-PROV-006 | 工厂 + snapshot/凭证 | ☑ |

## W03 Agent 核心（CORE） · 依赖 W02,W04 · ✅ 全部完成（context/runner targeted 30 vitest 绿；core 271 vitest 绿，tsc 0）
> CORE-001/006/007/008/009/010/011 已迁移对账。CORE-005 已补齐 ContextPipeline 富 report、ToolResultStore 大工具结果落盘替换、registry tool_result_limits、逐条 local microcompact 与 plan runtime context 注入。
> CORE-011 AgentLoop 已接线 session/runtime/memory/tools/subagent/scheduler/Team/MCP/control/routed runner；startup compaction 保持 session-safe 空钩子。
| ID | 标题 | 状态 |
|---|---|---|
| MIG-CORE-001 | ModelCaller | ☑ |
| MIG-CORE-002 | context: tool_call 配对 | ☑ |
| MIG-CORE-003 | context: 截断/摘要 | ☑ |
| MIG-CORE-004 | context: microcompact | ☑ |
| MIG-CORE-005 | ContextPipeline.project | ☑ |
| MIG-CORE-006 | 系统提示词 ContextBuilder | ☑ |
| MIG-CORE-007 | query_state 恢复 | ☑ |
| MIG-CORE-008 | AgentRunner 回合状态机 | ☑ |
| MIG-CORE-009 | Runner 错误恢复接线 | ☑ |
| MIG-CORE-010 | runner_factory | ☑ |
| MIG-CORE-011 | AgentLoop 装配根 | ☑ |

## W04 工具（TOOL） · 依赖 W00
| ID | 标题 | 状态 |
|---|---|---|
| MIG-TOOL-001 | Tool 基类+schema | ☑ |
| MIG-TOOL-002 | ToolResult/Artifact | ☑ |
| MIG-TOOL-003 | ToolRegistry | ☑ |
| MIG-TOOL-004 | 执行上下文+protocol/adapter | ☑ |
| MIG-TOOL-005 | 命令判定 resolvers | ☑ |
| MIG-TOOL-006 | ReadFileTool | ☑ |
| MIG-TOOL-007 | Write/EditFileTool | ☑ |
| MIG-TOOL-008 | GlobTool | ☑ |
| MIG-TOOL-009 | GrepTool | ☑ |
| MIG-TOOL-010 | WebFetch(SSRF) | ☑ |
| MIG-TOOL-011 | RunCommand | ☑ |
| MIG-TOOL-012 | LoadSkill+SkillsLoader | ☑ |
| MIG-TOOL-013 | UpdateTodos+TodoStore | ☑ |
| MIG-TOOL-014 | DispatchSubagent(壳) | ☑ |

## W05 控制/计划/权限（CTRL） · 依赖 W03 · ✅ 全部完成（control/plans/runner plan context 51+ vitest 绿；core 271 vitest 绿，tsc 0）
> 纯逻辑/store/policy/manager 全部迁移并对账（permissions/ + plans/ + control/）。
> AgentLoop 已接入 taskManager/todoStore/controlManager；PlanExecution 执行态、verification evidence、independent verification、runner followup 与 plan runtime context 已完成对账。
| ID | 标题 | 状态 |
|---|---|---|
| MIG-CTRL-001 | 控制态模型+Store | ☑ |
| MIG-CTRL-002 | ControlManager 门面+模式 | ☑ |
| MIG-CTRL-003 | ClarificationPolicy | ☑ |
| MIG-CTRL-004 | ask_user/propose_plan | ☑ |
| MIG-CTRL-005 | PlanDecisionPolicy | ☑ |
| MIG-CTRL-006 | PlanDrafting(豁免) | ☑ |
| MIG-CTRL-007 | PlanExecution | ☑ |
| MIG-CTRL-008 | PlanVerification+核验 | ☑ |
| MIG-CTRL-009 | PlanPermissionToken | ☑ |
| MIG-CTRL-010 | plan helpers | ☑ |
| MIG-CTRL-011 | Ask/Plan 交互流+resume | ☑ |
| MIG-CTRL-012 | plans 模型+Store | ☑ |
| MIG-CTRL-013 | 质量门+执行态+上下文 | ☑ |
| MIG-CTRL-014 | 权限模型 | ☑ |
| MIG-CTRL-015 | 工具画像解析 | ☑ |
| MIG-CTRL-016 | PermissionPolicy(三模式) | ☑ |
| MIG-CTRL-017 | PermissionPipeline+Manager | ☑ |

## W06 记忆/压缩（MEM） · 依赖 W03 · ✅ 全部完成（15 memory vitest 绿，core 165 vitest 绿，tsc 0）
| ID | 标题 | 状态 |
|---|---|---|
| MIG-MEM-001 | MemoryStore+History+checkpoint | ☑ |
| MIG-MEM-002 | 记忆版本快照/diff/restore | ☑ |
| MIG-MEM-003 | Compactor | ☑ |
| MIG-MEM-004 | TokenTracker+context_usage | ☑ |

## W07 会话（SESS） · 依赖 W06 · ✅ 全部完成（8 sessions vitest 绿，core 173 vitest 绿，tsc 0）
| ID | 标题 | 状态 |
|---|---|---|
| MIG-SESS-001 | ConversationStore | ☑ |
| MIG-SESS-002 | SessionStore | ☑ |
| MIG-SESS-003 | 首启迁移 | ☑ |
| MIG-SESS-004 | 会话标题服务 | ☑ |

## W08 子代理（SUB） · 依赖 W05,W03 · ✅ 全部完成（5 subagent vitest 绿，tsc 0）
| ID | 标题 | 状态 |
|---|---|---|
| MIG-SUB-001 | SubagentRegistry | ☑ |
| MIG-SUB-002 | 派遣 runner+证据抽取 | ☑ |
| MIG-SUB-003 | 子代理模型路由 | ☑ |

## W09 调度器（SCHED） · 依赖 W14,W07 · ✅ 全部完成（11 scheduler vitest 绿，tsc 0）
| ID | 标题 | 状态 |
|---|---|---|
| MIG-SCHED-001 | 调度模型+校验 | ☑ |
| MIG-SCHED-002 | SchedulerStore | ☑ |
| MIG-SCHED-003 | SchedulerService+受保护任务 | ☑ |
| MIG-SCHED-004 | SchedulerTool | ☑ |
| MIG-SCHED-005 | Scheduler executor | ☑ |

## W10 Team（TEAM） · 依赖 W03,W05 · ✅ 全部完成（5 team + 3 CoreTeamService vitest 绿；core 271 vitest 绿，tsc 0）
> Team 模型、事件、`.team/` roster/inbox/thread/checkpoint/cursor、MessageBus、工具和可注入 runner 的按消息唤醒骨架已迁。
> AgentLoop 已提供真实 Team runner factory 与 ModelRouter 主次路由；CoreTeamService 已覆盖项目 scope、member detail、写入口 guard 与 wake/shutdown payload。
| ID | 标题 | 状态 |
|---|---|---|
| MIG-TEAM-001 | Team 模型+事件 | ☑ |
| MIG-TEAM-002 | TeamStore+MessageBus | ☑ |
| MIG-TEAM-003 | TeamManager(唤醒/恢复) | ☑ |
| MIG-TEAM-004 | Team 工具(6) | ☑ |

## W11 MCP（MCP） · 依赖 W04 · ✅ 全部完成（5 mcp vitest 绿，tsc 0）
| ID | 标题 | 状态 |
|---|---|---|
| MIG-MCP-001 | MCP 配置 | ☑ |
| MIG-MCP-002 | MCP 连接(stdio/SSE) | ☑ |
| MIG-MCP-003 | MCPClient+Adapter | ☑ |

## W12 外部桥/Watchlist（EXT） · 依赖 W14,W09 · ✅ 全部完成（8 ext/watchlist vitest 绿，tsc 0）
> External 模型、adapter、durable store、入站去重/忙碌排队/出站状态已迁移。WatchlistStore、
> 决策解析、次模型路由/fallback 和 scheduler executor 投递路径已迁移；不内置具体平台 adapter。
| ID | 标题 | 状态 |
|---|---|---|
| MIG-EXT-001 | External 模型+Adapter | ☑ |
| MIG-EXT-002 | External durable store | ☑ |
| MIG-EXT-003 | ExternalBridgeService | ☑ |
| MIG-EXT-004 | Watchlist | ☑ |

## W13 附件/多模态（ATT） · 依赖 W03 · ✅ 全部完成（7 attachments vitest 绿，core 201 vitest 绿，tsc 0）
> AttachmentStore/sidecar/图片编码/Chat user content 组装已迁移。PDF 抽取采用可注入 extractor；
> 默认无解析库时跳过 sidecar，不阻断上传，与 Python 缺 `pypdf` 时的容错一致。
| ID | 标题 | 状态 |
|---|---|---|
| MIG-ATT-001 | AttachmentStore+MIME | ☑ |
| MIG-ATT-002 | PDF/文本抽取 sidecar | ☑ |
| MIG-ATT-003 | 图片多模态编码 | ☑ |

## W14 运行时/任务/项目（RTE） · 依赖 W00 · ✅ 全部完成（11 runtime/tasks/projects vitest 绿，core 184 vitest 绿，tsc 0）
| ID | 标题 | 状态 |
|---|---|---|
| MIG-RTE-001 | 运行时事件工厂 | ☑ |
| MIG-RTE-002 | RuntimeEventStore | ☑ |
| MIG-RTE-003 | ActiveTaskRegistry | ☑ |
| MIG-RTE-004 | TaskStore+Manager(归档) | ☑ |
| MIG-RTE-005 | ProjectStore | ☑ |

## W15 传输与前端接线（IPC） · 依赖 W01–W14 · ✅ 全部完成（core 271 / desktop 140 全绿，tsc 0）
> MIG-IPC-001 已提供进程内 `CoreApi` 门面和 route 操作清单覆盖。
> MIG-IPC-002 已有 channel contract、main 注册器、preload/renderer invoke helper；主进程已托管 `CoreApi` 并注册全部 operation，legacy Python 后端 opt-in 已删除。
> MIG-IPC-003 已有 main event bridge、preload/renderer onCoreEvent helper；CoreApi eventSink 已接入 main event bridge，`useRuntime` 可通过 IPC 订阅。
> MIG-IPC-004 已接入 `CoreApi.bootstrap()` 和 renderer IPC 优先入口；bootstrap 返回 session/control/runtime events/memory/model/team/scheduler/projects/diagnostics，并由 `useBootstrap` 通过 Core IPC 恢复初始状态。
> MIG-IPC-005 已提供 `MainlineTurnService`/`ChatService`，chat、External Bridge 与 Scheduler agent_turn 均汇入同一 mainline 入口。
> MIG-IPC-008 已迁移 mutation guard 并接入 CoreApi scheduler/team/desktop-pet 写入口。
> MIG-IPC-010 已让 `useRuntime` 走 IPC 订阅/`chat.submit`/`chat.stopRuntime`，并将 Ask/Plan answer/comment/approve 映射到 CoreApi control resume；`useSession` 已切 sessions/project resolve IPC；通用 `api()` 已对 memory/model/config/mcp/watchlist/scheduler/team/tasks/sidebar/desktop-pet 等支持 CoreApi 映射；附件上传、skill zip import 和模型测试也已支持 Core IPC；无 Core bridge 时快速失败，browser-only 测试通过注入最小 Core bridge fixture 覆盖 UI。
> 附件图片预览已改为 `app://attachments/{id}/raw`，由 Electron protocol 安全读取 `memory/attachments`，为退役 Python `/api/attachments/{id}/raw` 链路扫清阻塞。
> Electron main 不再 probe/spawn/wait Python backend；`CoreApi` 进程内托管后直接建窗。`--python-backend`、`EMPEROR_USE_PY_BACKEND`、`EMPEROR_BACKEND_CMD` 和 packaged preload backend URL/token 注入均已退役。
> Renderer 通用 `api()` 已切为 strict IPC：未映射 route 直接报错暴露迁移缺口；无 Core bridge 的普通浏览器/dev 页面不再尝试 HTTP fallback。
> 通用 `api()` 已补 bootstrap/runtime-stop/control/sessions/projects/plans/external/tools/skills/diagnostics/memory-versions route parity，并修正 scheduler/team/memory-version/task-transcript 动态路径解码，避免把 action 末段误当 id。
> MIG-IPC-006/007 已补 `model.test` probe、sessions route response parity、skill delete、skill zip import、desktop-pet 偏好/进程启动状态、route strict IPC 映射全覆盖和 core service 拆分；route/service parity 已签收。
> MIG-IPC-007 已开始拆出 core service：`CoreConfigService` 承接 `/api/config` 的 `templates/USER.local.md` 读写和 `/api/mcp-config` 读写/reload hook，修正 Core IPC 模式下 `/api/config` 误返回 `emperor.local.json` 的语义偏差。
> MIG-IPC-007/APP-002 已拆出 `CoreDiagnosticsService`：诊断聚合从 `CoreApi` 单文件迁入 core service，保留 model/local/scheduler/runtime/external/desktop-pet/dependencies 汇总，并补 `nodeRuntime` 到 GUI 诊断面板。
> MIG-IPC-007 已拆出 `CoreSkillService`：`/api/tools` 输出 WebUI capability payload（parameters/read_only/source/server 等），`/api/skills` 与 `/api/skill` 支持 frontmatter 元数据和内容读写，save/delete/import 后刷新 runtime context。
> MIG-IPC-007 已拆出 `CoreModelService`：`/api/model-config` 对齐 Python payload（current/secondary/routing/config/providerOptions + apiKey 脱敏），保存时回填 masked key 并刷新模型路由，`/api/model-test` 支持 text/vision probe 与 vision 标记刷新。
> MIG-IPC-007 已拆出 `CoreMemoryService`：`/api/memory` 返回 long_term/today_episode/episodes/context/tokens/history/runtime/watchlist/versions 完整摘要，memory version restore 与 watchlist check 返回 WebUI 期望的嵌套 payload；`TokenTracker` 补齐 provider/model、date/model、hour、streak、session 聚合供 `/api/tokens` 使用。`/api/compact` 已接 session-aware Compactor：未归档少于 2 条时返回 Python 兼容 skipped payload，达到阈值时走 `memory_compaction` 路由更新 memory/user/episode、清空热历史并归档 runtime events。
> MIG-IPC-007 已拆出 `CoreTeamService`：Team payload 增加 managed/scope/project_id 包装，member detail 对齐 Python `member_payload()`（inbox/leadInbox/thread summary/tools），写入口保留当前 renderer 所需的 `{result, team}` 包装并继续同步走 mutation guard。
> MIG-IPC-007/APP-003 已拆出 `CoreDesktopPetService`：桌宠偏好、pid/state、packaged command、Electron 依赖缺失提示和启动/停止流程从 `CoreApi` 迁入 service，并保留同步 mutation guard。
> MIG-IPC-011 已在 main IPC 注册器覆盖安全错误映射，renderer `invokeCore()` 会把安全错误 envelope 转成不泄内部细节的异常，并保留 `errorId` 供诊断关联。
> MIG-IPC-009 已随 Core IPC 拓扑退役 origin/auth guard 攻击面：默认桌面不监听 HTTP/WS server；README 已记录 Python backend 已退役。
| ID | 标题 | 状态 |
|---|---|---|
| MIG-IPC-001 | 进程内核心 API 门面 | ☑ |
| MIG-IPC-002 | Electron IPC 桥 | ☑ |
| MIG-IPC-003 | 事件流桥 | ☑ |
| MIG-IPC-004 | bootstrap 快照 | ☑ |
| MIG-IPC-005 | MainlineTurn+ChatService | ☑ |
| MIG-IPC-006 | 17 routes → CoreApi | ☑ |
| MIG-IPC-007 | 11 services → core | ☑ |
| MIG-IPC-008 | Mutation guard(IPC) | ☑ |
| MIG-IPC-009 | 退役 origin/auth guard | ☑ |
| MIG-IPC-010 | 渲染层接线改造(Vue→IPC) | ☑ |
| MIG-IPC-011 | IPC 安全错误映射 | ☑ |

## W16 入 GUI（APP） · 依赖 W15,W03
> APP-004 已完成：Electron main 托管 `CoreApi` 并删除 Python backend spawn/probe/wait/fallback 代码。
> APP-002 CoreApi diagnostics 已改为只读摘要并迁入 `CoreDiagnosticsService`：model_config 缺失不会被诊断创建，local_config corrupt/backups 可见，并包含 runtime/scheduler/external/desktop-pet/dependencies 状态；Settings 已新增诊断面板读取 `/api/diagnostics` 并展示配置、运行时、外部能力、Node runtime 和依赖状态。
> APP-003 桌宠偏好、pid/state、packaged command、依赖缺失提示、启动/停止流程已迁入 `CoreDesktopPetService` 并接入 CoreApi mutation guard。
> APP-001 已完成：`build_model_config` 逻辑迁入 core (`buildWizardModelConfig` + `model.saveOnboardingConfig`)，桌面端提供用户主动打开的模型配置向导并保存 `model_config.json`；启动不会因无可用模型条目阻塞进入应用，相关 core/renderer 单测已覆盖。
> APP-005 已完成：`agent.py`、`webui.py`、`agent/cli.py` 所属 Python runtime 已删除，开发质量检查统一由 `make check` / npm scripts 承接。
| ID | 标题 | 状态 |
|---|---|---|
| MIG-APP-001 | 首启向导入 GUI | ☑ |
| MIG-APP-002 | doctor/诊断入应用内 | ☑ |
| MIG-APP-003 | 桌宠进程管理 | ☑ |
| MIG-APP-004 | 主进程托管核心(去 spawn) | ☑ |
| MIG-APP-005 | 退役 Python CLI | ☑ |

## W17 打包/发布/对账（REL） · 依赖 全部
> REL-001 已完成本地配置面：release 不运行 PyInstaller，也不把 Python backend 放入 `Resources/backend`；release 包只托管 Electron main 内的 `CoreApi` 与 runtime defaults。legacy backend bundle 脚本已删除。
> REL-001/002 继续推进：electron-builder 已声明 mac dmg/zip、Linux AppImage、Windows NSIS target；GitHub CI/release 已切到 Node 22 + core/desktop vitest/typecheck/build/package dry run，不再跑 Python/pytest。当前本机已验证 `npm run build` 与 `npm run package:dir`（mac unpacked）通过，三平台远端产物仍需 CI/tag 实跑签收。
> REL-003 已完成：新增 `packages/core/fixtures/python-runtime` 与 `python-runtime-compat.test.ts`，覆盖 Python 布局的 `memory/`、`model_config.json`、`mcp_config.json`、sessions 与 `.team/` 可由 TS 版零迁移读取。
> REL-004 已完成：`docs/migration/ts/PARITY.md` 作为冻结源清单覆盖 84 个已退役 Python 源测试文件，`scripts/check_migration_parity.mjs` 校验映射到存在的 TS/JS 测试文件；`make check`、`package:dir` 与 Playwright screenshots 均已在本机通过。
> REL-005 已完成：`agent/`、`tests/`、`agent.py`、`webui.py`、`requirements*.txt`、`pyproject.toml` 已删除；仅保留技能目录自带 helper 脚本作为技能资产。仓库主 runtime 为 TS/Electron/CoreApi。
| ID | 标题 | 状态 |
|---|---|---|
| MIG-REL-001 | electron-builder 打包 | ◐ |
| MIG-REL-002 | CI 矩阵 | ◐ |
| MIG-REL-003 | 数据兼容验证 | ☑ |
| MIG-REL-004 | 全量 parity 签收 | ☑ |
| MIG-REL-005 | 退役 Python | ☑ |
