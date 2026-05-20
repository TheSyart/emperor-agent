# AGENTS.md · Emperor Agent 协作指南

## 0. 用户与沟通约定

- 默认使用中文沟通；涉及命令、路径、配置 key 时可保留英文原文。
- 这个仓库是“可持续迭代的个人 Agent 工程”，不是 demo。做改动时优先考虑长期可维护性。

## 1. 项目定位（一句话）

`Emperor Agent` 是一个本地运行的 Python 智能体系统，包含：

- 多 Provider LLM 调用层
- 工具调用与子代理派遣
- Agent Team 持久队友协作
- 本地 Scheduler 长期自动运行中枢
- Ask / Plan 会话控制与可暂停执行
- 三层记忆 + 自动压缩
- WebSocket 流式 WebUI（Vue3 + Vite + Tailwind）
- 附件上传（图像/文档）与多模态输入链路
- External Bridge 基础设施（外部平台只汇入唯一主线，不做多会话）

## 2. 先看哪里（最小阅读路径）

当你第一次接手任务，优先按这个顺序读：

1. `README.md`
2. `agent/loop.py`（装配与主循环）
3. `agent/runner.py`（单轮执行、工具循环、容错）
4. `agent/web/` + `agent/webui.py`（HTTP/WS API 与兼容入口）
5. `agent/memory.py` + `agent/compactor.py`（记忆与压缩）
6. `agent/memory_versions.py`（记忆快照、diff、restore）
7. `agent/model_config.py` + `agent/providers/*`（模型配置与 provider 实现）
8. `agent/tools/*` + `agent/subagents/*`（工具与子代理能力边界）
9. `agent/control/*`（Ask / Plan pending 状态、暂停恢复）
10. `agent/permissions/*`（三模式权限与审批策略）
11. `agent/runtime/*`（WebUI 行为事件冷记录与刷新重放）
12. `agent/scheduler/*`（持久 jobs、timer service、scheduler tool）
13. `agent/watchlist/*`（Watchlist heartbeat、次模型 skip/run 决策）
14. `agent/team/*`（持久队友、MessageBus、TeamStore、team tools）
15. `agent/external/*`（外部平台 adapter 抽象、bridge service、inbox/outbox 状态）
16. `webui/src/runtime/*` + `webui/src/composables/useRuntime.ts` + `useBootstrap.ts` + `components/panels/ModelPanel.vue` + `components/panels/TeamPanel.vue`

## 3. 关键目录地图

### 后端

- `agent.py`：CLI 入口
- `webui.py`：WebUI 服务入口
- `agent/loop.py`：系统装配（memory / tools / subagents / runner）
- `agent/runner.py`：LLM 调用循环、工具并发、空响应与截断恢复
- `agent/web/`：aiohttp app/state/routes 模块化后端，HTTP 路径保持兼容
- `agent/webui.py`：兼容入口，导出 `create_app()` 与 `main()`
- `agent/model_config.py`：新旧 schema 兼容、entry 激活、保存与脱敏
- `agent/providers/`：OpenAI-compatible / Anthropic / Bedrock
- `agent/tools/`：内建工具实现（命令、读写、搜索、todo、子代理）
- `agent/control/`：Ask / Plan 会话控制、pending interaction、暂停/恢复语义
- `agent/permissions/`：Claude Code 风格 `ask_before_edit` / `auto` / `plan` 权限判断
- `agent/runtime/`：Chat 行为事件冷记录与 payload 构造，支持刷新/重启后恢复工具、队友、Ask/Plan 细节
- `agent/scheduler/`：本地长期自动运行中枢，持久保存 `at` / `every` / `cron` jobs，WebUI 启动后恢复 timer，Agent 通过 `scheduler` 工具管理任务；执行侧由 `agent/web/services/scheduler_executor.py` 把 job payload 投递到本地主动 turn 或 Team wake
- `agent/watchlist/`：Watchlist heartbeat，读取 `memory/watchlist.md`，用次模型先判断 `skip/run`，只有 `run` 才投递完整主动 turn
- `agent/team/`：Agent Team 子系统（持久队友、inbox、thread、状态机、team tools）
- `agent/external/`：外部平台适配基础层；提供 `ExternalAdapter`、统一消息模型、入站去重、inbox/outbox 状态。当前不内置真实平台实现，外部消息必须进入唯一主线，不能引入多会话。
- `agent/attachments.py`：附件落盘、MIME 校验、PDF/文本抽取、图片 base64 编码
- `agent/memory.py`：长期记忆、历史日志、checkpoint 恢复
- `agent/memory_versions.py`：记忆快照、diff 预览与恢复；本地数据在 `memory/versions/`
- `agent/compactor.py`：历史压缩，更新 `MEMORY.local.md` / `USER.local.md`

### 前端

- `webui/src/App.vue`：全局注入、斜杠命令、页面壳
- `webui/src/composables/useRuntime.ts`：WS 生命周期、发送消息、replay 调度
- `webui/src/runtime/`：runtime event 类型、reducer、selectors 与 localStorage 热缓存
- `webui/src/composables/useBootstrap.ts`：bootstrap 与 CRUD API 客户端
- `webui/src/components/chat/Composer.vue`：输入框、附件上传、上下文用量环
- `webui/src/components/chat/AskCard.vue` / `PlanCard.vue`：Ask / Plan 内联交互卡
- `webui/src/components/panels/ModelPanel.vue`：模型条目管理、文本/视觉连通测试
- `webui/src/components/panels/TeamPanel.vue`：Agent Team 队友工作台
- `webui/src/views/*`：一级路由页面

### 配置与模板

- `templates/SOUL.md`：人格与语气（当前要求前缀“奉天承运皇帝诏曰”）
- `templates/TOOL.md`：工具使用偏好
- `templates/init/USER.md`、`templates/init/MEMORY.md`：首次启动模板
- `templates/subagents/*.md`：子代理身份模板
- `skills/*/SKILL.md`：技能说明

## 4. 本地运行与构建命令

### Python

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp model_config.example.json model_config.json
python agent.py
```

### WebUI

```bash
cd webui
npm install
npm run build
cd ..
python webui.py
```

开发模式前端可单跑：

```bash
cd webui
npm run dev
```

Vite 会代理 `/api` 与 `/ws` 到 `127.0.0.1:8765`。

## 5. 运行时核心机制（必须理解）

### 5.1 turn 执行链路

`AgentLoop.history`（内存） -> `AgentRunner.step_async` -> provider -> 工具循环 -> assistant 收敛输出。

重要细节：

- 每个 turn 开始先写 `memory/_checkpoint.json`
- 工具批次结束再写一次 checkpoint（保证 tool_calls 与 tool result 成对）
- turn 正常落地后清 checkpoint
- 重启时优先恢复 checkpoint，否则加载热 `history.jsonl` 活跃段；已压缩原始行在 `memory/history_archive/*.jsonl.gz`

### 5.2 上下文治理（防爆 token）

`runner` 在每次模型调用前会：

1. `_pair_tool_calls`：修复/补全 tool_call 对应 tool 消息，防止 OpenAI 格式报错
2. `_cap_tool_result`：单条工具结果硬截断（默认约 8KB）
3. `_shrink_old_tool_results`：旧的大工具结果摘要化（保留最近 10 条原文）

### 5.3 错误恢复

- 空响应自动重试（最多 2 次，注入 nudge）
- `finish_reason=length/max_tokens` 自动续写（最多 3 次）

### 5.4 记忆压缩

- `TokenTracker.should_compact(max_context, threshold=0.7)` 决定是否触发
- 压缩 `history[:-K]`（`K=10`）并更新：
  - `memory/YYYY-MM-DD.md`
  - `memory/MEMORY.local.md`
  - `templates/USER.local.md`
- 压缩成功后 `HistoryLog` 会把已压缩原始行写入 `memory/history_archive/YYYY-MM.jsonl.gz`，再原子重写热 `memory/history.jsonl`

### 5.5 权限模式与 Ask / Plan 暂停恢复

- `agent/control/` 统一管理当前 `mode` 与 pending interaction，状态写入 `memory/control/state.json`
- `agent/permissions/` 统一评估工具风险，当前三种模式为：
  - `ask_before_edit`：默认模式；读操作直接执行，普通编辑可执行，危险/不确定/破坏性/高影响操作先进入 AskCard 审批。
  - `auto`：最高自动权限；工具层不主动审批，但仍受路径安全、schema 校验和工具自身异常保护约束。
  - `plan`：临时计划模式；只读探索 + `ask_user` + `propose_plan`，批准或取消后恢复进入 Plan 前的模式。
- `ask_user` / `propose_plan` 会生成有效 tool result，占位为 waiting，并抛出内部 `TurnPaused`
- Runner 在暂停前写 checkpoint，WebUI / CLI 收到用户回答、评论或批准后，把结构化反馈追加到 history 再恢复执行
- Ask Guard 在高影响歧义下强制先问：大范围工程化、重构、UI 取舍、提交推送、删除覆盖、发布部署、安全/权限/成本边界不清时，写操作和最终答复前必须进入 `ask_user`
- 权限审批采用一次性同参授权：允许后同一工具名 + 参数组合放行一次；拒绝后同参操作下一次返回明确拒绝，避免重复弹同一个审批。
- Plan 模式是工具层 + 输出层硬门禁：只暴露只读工具 + `ask_user` + `propose_plan`；写文件、命令执行、子代理派遣、Team 写操作不可用；普通最终回复会被包装为 PlanCard 并暂停
- 执行中或存在 pending Ask/Plan 时，不允许切换 control mode，HTTP API 返回 409

### 5.6 Chat 行为流持久化

- `agent/runtime/RuntimeEventStore` 把活跃 WebUI runtime 事件 append 到 `memory/runtime/events.jsonl`，旧事件轮转到 `memory/runtime/archive/YYYY-MM.jsonl.gz`，索引写入 `memory/runtime/index.json`
- 每个用户 turn 生成 `turn_id`，写入 `history.jsonl`、checkpoint 上下文和所有 runtime 事件
- `/api/bootstrap.runtime.events` 只返回未压缩 turn 的事件；`useRuntime.ts` 用它重建工具调用、队友轨迹、AskCard、PlanCard 与错误状态
- Chat turn、Scheduler run 与 Watchlist 手动检查会登记到 `agent/runtime/active.py` 的进程内 active task registry；`POST /api/runtime/stop`、WebUI 停止按钮和 `/stop` 共用它取消当前可见任务，并发出 `runtime_task_cancelled`
- External Bridge 入站事件会记录 `external_inbound` / `external_queued`，出站基础状态会记录 `external_outbound_*`；真正进入模型时仍走主线 `user_message` + `turn_id`。
- localStorage 只是热缓存兜底；后端冷记录是刷新/重启恢复的事实来源
- 压缩前的细节会进入 `memory/runtime/archive/*.jsonl.gz`，但 Chat 当前页面只展示未压缩 turn

## 6. WebSocket 事件协议（前后端联动改动必看）

核心事件：

- `user_message`
- `message_delta`
- `tool_call` / `tool_result` / `tool_error`
- `subagent_*`（start/delta/tool_call/tool_result/done/error）
- `team_*`（member_update/message/run_start/run_delta/run_tool_call/run_tool_result/run_done/run_error）
- `scheduler_*`（job_update/run_start/run_done/run_error/run_cancelled）
- `external_*`（inbound/queued/outbound_queued/outbound_sent/outbound_error）
- `runtime_task_cancelled`
- `control_mode_update`
- `ask_request` / `ask_answered`
- `plan_draft` / `plan_comment_added` / `plan_approved`
- `interaction_cancelled`
- `turn_paused`
- `assistant_done`
- `ready`
- `context_usage`

`webui/src/runtime/*` 与 `useRuntime.ts` 负责：

- runtime event replay / reducer / selectors
- 从 `/api/bootstrap.runtime.events` 重放未压缩 Chat 行为流
- 断线重连（带 `last_seq` 回放）
- localStorage 快照兜底
- 未完成 assistant 的中断收尾

凡是新增后端事件，必须同步更新 `agent/runtime/events.py`、前端 `types.ts`、`webui/src/runtime/*` 和 `useRuntime.ts` 分支逻辑。

## 7. 模型配置机制（常见改动区）

`model_config.json` 是真实配置文件；`/api/model-config` 返回时会脱敏 key。

当前 schema：

- `models[]`：多条目（name/mainModelId/secondaryModelId/provider/apiKey/apiBase/...）
- `agents.defaults.model`：当前激活 entry name
- `providers.*`：兜底凭证层

一个 entry 共享一套 `provider / apiKey / apiBase / extraHeaders / extraBody`，但必须同时配置两个模型 id：`mainModelId` 用于主 Agent、复杂决策、写入型子代理/队友；`secondaryModelId` 用于记忆压缩、轻量只读/核验子代理和简单 Team 队友。旧字段 `id` 只作为 `mainModelId` 兼容读取；WebUI 保存时必须补齐 `secondaryModelId`。

注意：

- 前端传回 `***xxxx` 占位 key 时，后端会还原旧值
- `/api/model-test` 的视觉测试通过后，会把 `supportsVision=true` 写回 entry
- 次模型失败或缺失时自动降级主模型；token 账本会记录 `model_role=main|secondary|unknown`

## 8. 附件与多模态链路

- 上传 API：`POST /api/attachments`
- 落盘路径：`memory/attachments/YYYY-MM/{hash8}-{name}.{ext}`
- 文档会尽可能抽取 sidecar 文本 `*.txt`
- 支持视觉的 entry：图片走 OpenAI `image_url` block
- 不支持视觉：图片转为提示文本（不丢消息）
- 文档抽取文本会拼进用户消息，结尾附落盘路径给 `read_file` 兜底

## 9. 工具与子代理边界

### 内建工具

- `run_command`, `web_fetch`, `read_file`, `write_file`, `edit_file`, `glob`, `grep`, `load_skill`, `update_todos`, `dispatch_subagent`
- Control：`ask_user`, `propose_plan`
- Scheduler：`scheduler(action=list|add|update|remove|pause|resume|run)`
- Agent Team：`spawn_teammate`, `list_teammates`, `send_message`, `read_inbox`, `broadcast`, `shutdown_teammate`

### 并发规则

- `read_only && !exclusive` 的工具会被 runner 并发执行
- `dispatch_subagent` 标记为并发安全，可同轮并发派遣

### 子代理

由 `agent/subagents/registry.py` 内置白名单控制能力，模板只负责口吻和职责，不承载权限。

子代理模型由 `agent/model_router.py` 统一路由：`xiaohuangmen`、`sili_suitang`、`dongchang_tanshi`、`shangbao_dianbu` 默认走次模型，`neiguan_yingzao` 默认走主模型；不要在工具里手写主次模型判断。

### Agent Team

- `.team/config.json` 记录队友 roster，`.team/inbox/*.jsonl` 是 append-only 消息总线，`.team/threads/*.json` 保存队友独立上下文。
- v1 采用“按消息唤醒”：Lead 通过 `send_message(..., wake=true)` 或 `broadcast(..., wake=true)` 驱动队友执行一次，不启动后台常驻轮询。
- Teammate 只能使用自身 `agent_type` 白名单工具 + `send_message` / `read_inbox`，不能再派遣 subagent 或创建队友。
- Team runner 同样通过 `ModelRouter` 选主/次模型：reader/reviewer/researcher/runner 类队友走次模型，coder 类队友走主模型。
- 启动时 stale `working` 会变为 `offline`，下次 wake 再恢复。

### External Bridge

- External Bridge 是外部平台接入基础，不是多会话系统。所有外部入口都必须通过 `MainlineTurnService` 汇入唯一 `AgentLoop.history`。
- 当前只允许通用 adapter 抽象、统一消息模型、入站去重、忙碌/Ask/Plan 时排队、只读状态 API 与 runtime 事件；不要在基础层直接实现飞书/Slack/Telegram 等具体平台。
- 外部入站内容进入模型前必须带来源上下文和“不可信输入”标记；长期记忆写入仍由主 Agent 与既有记忆机制决定，不能让平台消息绕过主线。
- 出站能力目前只保留 outbox 状态和 adapter `send()` 接口，不暴露模型可调用的 `send_external_message` 工具；真实外发平台后续必须接入权限/审批策略。

### 权限模式 / Ask / Plan

- Ask 用于目标不清时主动发问：最多 3 个问题，每题 2-4 个选项，并允许自由补充。高影响歧义由 `ClarificationPolicy` 统一判断，避免把主动提问散落到 prompt 文案里。
- 权限模式由 `agent/permissions/` 管理：`ask_before_edit` 默认危险先问，`auto` 自动执行，`plan` 只读计划。
- Plan 需要显式开启（WebUI Composer 模式选择器、`/mode plan` 或 `/plan on`）：只读探索、提问、提交计划；用户可评论修订，批准或取消后自动恢复进入 Plan 前的 `ask_before_edit` / `auto` 模式。Plan 模式必须产出 PlanCard，不能用普通文字最终答复绕过。
- WebUI 手动点击被视为用户直接操作，不再二次弹 Agent AskCard；但统一 Web mutation guard 会在 pending Ask/Plan 时拒绝执行型 Scheduler / Team 操作，并在 Plan 模式下拒绝 Scheduler mutation 与 Team 写操作，防止绕过计划门禁。
- Scheduler 在 Plan 模式下只允许 `scheduler(action=list)`，创建/修改/删除/运行长期任务必须等待计划批准；`ask_before_edit` 下 scheduler 写操作会进入 AskCard 审批；`auto` 下仍保留 schema、timezone、protected job 等安全校验。
- Scheduler job 执行时会设置 scheduler context，禁止递归创建新的 scheduler job；`agent_turn` 默认写入 history/runtime，`deliver=false` 时作为后台运行不插入当前 Chat timeline；`team_wake` 会走 TeamManager inbox+wake，`deliver=false` 时不把 Team 事件挂到当前 Chat；`system_event` 只能由系统代码注册。
- WebUI 启动会登记受保护系统任务：`memory-maintenance`、`runtime-maintenance`、`team-stale-recovery`、`token-ledger-maintenance`、`watchlist-check`。它们可见、可手动运行、可暂停/恢复，但不能删除；Memory 页展示维护任务状态摘要，并提供 `memory/watchlist.md` 编辑与手动检查入口。
- Watchlist heartbeat 先用次模型做 deliverability filter：空清单或不及时的事项只记录 `skip`；只有 `run` 决策才包装为本地主动 `agent_turn`，避免长期心跳污染 Chat。
- `/stop` 与 Chat 停止按钮只取消 active task registry 中登记的运行任务；不要在 UI 里直接改 busy 状态绕过后端取消事件。
- v1 同一时间只允许一个 pending ask 或 plan；扩展时优先保持 `agent/control/` 的模型、store、manager、policy 分层。

### Slash Skill Picker

- WebUI Composer 的 `/` 菜单展示静态斜杠命令和当前项目 `skills/` 下的全部 Skill。
- 用户输入 `/<skill-name> 任务` 或 `/<skill-name>-skill 任务` 时，前端发送 `requested_skills`，后端校验后把 Skill 内容强制注入本轮上下文。
- 点击 Skill 候选会补全 `/<skill-name> ` 前缀；Composer 和 Chat 气泡中非系统命令的 `/skill` 前缀会用特殊颜色字体高亮，普通用户文字仍保持原样。
- 聊天气泡和 `displayContent` 保留用户原始输入；真实模型输入和 `history.jsonl` 保存已注入 Skill 的内容，保证 checkpoint 与重启恢复一致。

## 10. 修改代码时的项目内规

### 10.1 不应提交的文件

严格不要提交：

- `memory/`
- `.team/`
- `model_config.json`
- `templates/USER.local.md`
- `.env`
- `webui/dist/`
- `webui/node_modules/`

### 10.2 新能力扩展路径

- 新 provider：`agent/providers/registry.py` + `factory.py` + 对应 provider 文件
- 新工具：`agent/tools/` 新建类 + `agent/loop.py` 注册
- 新 Control 能力：优先放在 `agent/control/`，同步 `runner` 暂停/恢复语义、`agent/web/routes/*` API/WS、`webui/src/types.ts` 与 chat 卡片组件
- 新权限策略：优先放在 `agent/permissions/`，不要把审批规则散落到工具实现或 prompt 文案里
- 新 Chat 行为事件：优先接入 `agent/runtime/` 持久化，事件需带 `turn_id`，并同步 `agent/runtime/events.py`、`webui/src/types.ts`、`webui/src/runtime/*` 与 `useRuntime.ts` replay 分支
- 新 Team 能力：优先放在 `agent/team/`，同步 `agent/web/routes/team.py` API、`webui/src/types.ts` 与 `TeamPanel.vue`
- 新外部平台接入：优先放在 `agent/external/`，通过 `ExternalAdapter` 标准化入站/出站，并复用 `ExternalBridgeService`；禁止引入 `session_id`、会话列表或 `channel:chat_id` 多会话模型。
- 新子代理：`templates/subagents/*.md` + `subagents/registry.py` 白名单
- 新技能：`skills/<name>/SKILL.md`

### 10.3 前端改动注意

- API 字段改动必须同步：
  - `webui/src/types.ts`
  - `useBootstrap.ts` / `useRuntime.ts`
  - 相关 panel/view
- runtime 状态机改动优先放在 `webui/src/runtime/`；`useRuntime.ts` 只承担 WebSocket 生命周期和调度 glue。
- 新图标放仓库根 `assets/`，并在 `webui/src/assets.ts` 注册

## 11. 常见排查清单（出问题先看）

1. 页面白屏：确认 `webui/dist/index.html` 是否存在，必要时 `npm run build`
2. 消息不流式：检查 `/ws` 连接状态与浏览器控制台 event
3. 工具历史报错：优先看 `runner._pair_tool_calls` 保护是否被绕过
4. 压缩异常：检查 `templates/agent/compact_prompt.md` 输出 XML 标签是否齐全
5. 附件不可用：看 MIME 是否在 `ALLOWED_*_MIMES`，以及大小限制
6. 模型 key 丢失：确认前端是否传回 `***` 占位，后端还原逻辑是否被改坏

## 12. 给未来 agent 的执行建议

- 小改动优先最小 patch，不做无关重构。
- 涉及行为变化时，必须同时更新 README 或本文件对应章节。
- 做完改动至少做一次“路径验证”：能启动、能发消息、关键 API 不 500。
- Python 质量门禁优先使用 `pip install -r requirements-dev.txt` 后执行 `git diff --check`、`python -m ruff check agent tests`、`python -m pytest`；涉及前端还要执行 `cd webui && npm run build`。
- 若发现代码与 README 不一致，以“当前代码行为”为准并回写文档。

## 13. 项目素材生成规范（imagegen）

- 项目内所有位图素材生成/编辑（插画、贴图、mockup、透明抠图等）统一使用技能：`$imagegen`（`/Users/anhuike/.codex/skills/.system/imagegen/SKILL.md`）。
- 默认走内置 `image_gen` 工具；除非用户明确要求 CLI fallback，或透明背景场景经确认需要 `gpt-image-1.5`。

### 13.1 素材保存地址

- 内置工具默认输出目录：`$CODEX_HOME/generated_images/...`（中间产物）。
- 本项目素材根目录（原始路径）：`/Users/anhuike/Documents/workspace/emperor-agent/assets`。
- 生成素材必须最终落在上述 `assets/` 根目录下。
- 若该素材明确属于现有分类（如 `assets/nav/`、`assets/actions/`、`assets/brand/`），保存到对应分类目录。
- 若暂不属于既有分类，保存到 `assets/generated/`。

### 13.2 落盘规则

- 不要让“项目要用的最终素材”只留在 `$CODEX_HOME/generated_images/...`，必须复制或移动回仓库目录。
- 默认不覆盖已有文件；若未明确要求替换，使用版本化命名（如 `hero-v2.png`、`icon-send-v3.png`）。
- 完成后在回复中给出最终仓库内绝对路径。

### 13.3 提示词同步规则（必须执行）

- 每次素材生成/编辑完成后，必须把“最终采用的提示词”同步记录到对应目录的 `PROMPTS.md`：
  - `assets/nav/*` -> `assets/nav/PROMPTS.md`
  - `assets/actions/*` -> `assets/actions/PROMPTS.md`
  - 其他同理
  - `assets/generated/*` -> `assets/generated/PROMPTS.md`
- 记录至少包含：日期、输出文件名、工具模式（built-in / CLI fallback）、最终 prompt（含关键约束）。
- 若目标目录不存在 `PROMPTS.md`，先创建再记录。

---

最后提醒：这是一个强调“持续演进”的仓库。你不是来一次性修补，而是来给下一位接手者留下清晰、可运行、可验证的轨道。
