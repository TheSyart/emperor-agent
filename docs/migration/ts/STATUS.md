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

## W01 配置/模型路由（CFG） · 依赖 W00
| ID | 标题 | 状态 |
|---|---|---|
| MIG-CFG-001 | local_config | ☐ |
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

## W03 Agent 核心（CORE） · 依赖 W02,W04
| ID | 标题 | 状态 |
|---|---|---|
| MIG-CORE-001 | ModelCaller | ☐ |
| MIG-CORE-002 | context: tool_call 配对 | ☑ |
| MIG-CORE-003 | context: 截断/摘要 | ☑ |
| MIG-CORE-004 | context: microcompact | ☑ |
| MIG-CORE-005 | ContextPipeline.project | ☑ |
| MIG-CORE-006 | 系统提示词 ContextBuilder | ☐ |
| MIG-CORE-007 | query_state 恢复 | ☐ |
| MIG-CORE-008 | AgentRunner 回合状态机 | ☐ |
| MIG-CORE-009 | Runner 错误恢复接线 | ☐ |
| MIG-CORE-010 | runner_factory | ☐ |
| MIG-CORE-011 | AgentLoop 装配根 | ☐ |

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
| MIG-TOOL-014 | DispatchSubagent(壳) | ☐ |

## W05 控制/计划/权限（CTRL） · 依赖 W03
| ID | 标题 | 状态 |
|---|---|---|
| MIG-CTRL-001 | 控制态模型+Store | ☐ |
| MIG-CTRL-002 | ControlManager 门面+模式 | ☐ |
| MIG-CTRL-003 | ClarificationPolicy | ☐ |
| MIG-CTRL-004 | ask_user/propose_plan | ☐ |
| MIG-CTRL-005 | PlanDecisionPolicy | ☐ |
| MIG-CTRL-006 | PlanDrafting(豁免) | ☐ |
| MIG-CTRL-007 | PlanExecution | ☐ |
| MIG-CTRL-008 | PlanVerification+核验 | ☐ |
| MIG-CTRL-009 | PlanPermissionToken | ☐ |
| MIG-CTRL-010 | plan helpers | ☐ |
| MIG-CTRL-011 | Ask/Plan 交互流+resume | ☐ |
| MIG-CTRL-012 | plans 模型+Store | ☐ |
| MIG-CTRL-013 | 质量门+执行态+上下文 | ☐ |
| MIG-CTRL-014 | 权限模型 | ☐ |
| MIG-CTRL-015 | 工具画像解析 | ☐ |
| MIG-CTRL-016 | PermissionPolicy(三模式) | ☐ |
| MIG-CTRL-017 | PermissionPipeline+Manager | ☐ |

## W06 记忆/压缩（MEM） · 依赖 W03
| ID | 标题 | 状态 |
|---|---|---|
| MIG-MEM-001 | MemoryStore+History+checkpoint | ☐ |
| MIG-MEM-002 | 记忆版本快照/diff/restore | ☐ |
| MIG-MEM-003 | Compactor | ☐ |
| MIG-MEM-004 | TokenTracker+context_usage | ☐ |

## W07 会话（SESS） · 依赖 W06
| ID | 标题 | 状态 |
|---|---|---|
| MIG-SESS-001 | ConversationStore | ☐ |
| MIG-SESS-002 | SessionStore | ☐ |
| MIG-SESS-003 | 首启迁移 | ☐ |
| MIG-SESS-004 | 会话标题服务 | ☐ |

## W08 子代理（SUB） · 依赖 W05,W03
| ID | 标题 | 状态 |
|---|---|---|
| MIG-SUB-001 | SubagentRegistry | ☐ |
| MIG-SUB-002 | 派遣 runner+证据抽取 | ☐ |
| MIG-SUB-003 | 子代理模型路由 | ☐ |

## W09 调度器（SCHED） · 依赖 W14,W07
| ID | 标题 | 状态 |
|---|---|---|
| MIG-SCHED-001 | 调度模型+校验 | ☐ |
| MIG-SCHED-002 | SchedulerStore | ☐ |
| MIG-SCHED-003 | SchedulerService+受保护任务 | ☐ |
| MIG-SCHED-004 | SchedulerTool | ☐ |
| MIG-SCHED-005 | Scheduler executor | ☐ |

## W10 Team（TEAM） · 依赖 W03,W05
| ID | 标题 | 状态 |
|---|---|---|
| MIG-TEAM-001 | Team 模型+事件 | ☐ |
| MIG-TEAM-002 | TeamStore+MessageBus | ☐ |
| MIG-TEAM-003 | TeamManager(唤醒/恢复) | ☐ |
| MIG-TEAM-004 | Team 工具(6) | ☐ |

## W11 MCP（MCP） · 依赖 W04
| ID | 标题 | 状态 |
|---|---|---|
| MIG-MCP-001 | MCP 配置 | ☐ |
| MIG-MCP-002 | MCP 连接(stdio/SSE) | ☐ |
| MIG-MCP-003 | MCPClient+Adapter | ☐ |

## W12 外部桥/Watchlist（EXT） · 依赖 W14,W09
| ID | 标题 | 状态 |
|---|---|---|
| MIG-EXT-001 | External 模型+Adapter | ☐ |
| MIG-EXT-002 | External durable store | ☐ |
| MIG-EXT-003 | ExternalBridgeService | ☐ |
| MIG-EXT-004 | Watchlist | ☐ |

## W13 附件/多模态（ATT） · 依赖 W03
| ID | 标题 | 状态 |
|---|---|---|
| MIG-ATT-001 | AttachmentStore+MIME | ☐ |
| MIG-ATT-002 | PDF/文本抽取 sidecar | ☐ |
| MIG-ATT-003 | 图片多模态编码 | ☐ |

## W14 运行时/任务/项目（RTE） · 依赖 W00
| ID | 标题 | 状态 |
|---|---|---|
| MIG-RTE-001 | 运行时事件工厂 | ☐ |
| MIG-RTE-002 | RuntimeEventStore | ☐ |
| MIG-RTE-003 | ActiveTaskRegistry | ☐ |
| MIG-RTE-004 | TaskStore+Manager(归档) | ☐ |
| MIG-RTE-005 | ProjectStore | ☐ |

## W15 传输与前端接线（IPC） · 依赖 W01–W14
| ID | 标题 | 状态 |
|---|---|---|
| MIG-IPC-001 | 进程内核心 API 门面 | ☐ |
| MIG-IPC-002 | Electron IPC 桥 | ☐ |
| MIG-IPC-003 | 事件流桥 | ☐ |
| MIG-IPC-004 | bootstrap 快照 | ☐ |
| MIG-IPC-005 | MainlineTurn+ChatService | ☐ |
| MIG-IPC-006 | 17 routes → CoreApi | ☐ |
| MIG-IPC-007 | 11 services → core | ☐ |
| MIG-IPC-008 | Mutation guard(IPC) | ☐ |
| MIG-IPC-009 | 退役 origin/auth guard | ☐ |
| MIG-IPC-010 | 渲染层接线改造(Vue→IPC) | ☐ |
| MIG-IPC-011 | IPC 安全错误映射 | ☐ |

## W16 入 GUI（APP） · 依赖 W15,W03
| ID | 标题 | 状态 |
|---|---|---|
| MIG-APP-001 | 首启向导入 GUI | ☐ |
| MIG-APP-002 | doctor/诊断入应用内 | ☐ |
| MIG-APP-003 | 桌宠进程管理 | ☐ |
| MIG-APP-004 | 主进程托管核心(去 spawn) | ☐ |
| MIG-APP-005 | 退役 Python CLI | ☐ |

## W17 打包/发布/对账（REL） · 依赖 全部
| ID | 标题 | 状态 |
|---|---|---|
| MIG-REL-001 | electron-builder 打包 | ☐ |
| MIG-REL-002 | CI 矩阵 | ☐ |
| MIG-REL-003 | 数据兼容验证 | ☐ |
| MIG-REL-004 | 全量 parity 签收 | ☐ |
| MIG-REL-005 | 退役 Python | ☐ |
