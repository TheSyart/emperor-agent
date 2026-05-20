<p align="center">
  <img src="assets/brand/og-cover.png" alt="Emperor Agent — 皇帝密探 / 大内总管" width="780" />
</p>

<h1 align="center">Emperor Agent · 皇帝智能体</h1>

<p align="center">
  <b>本地运行的个人 Python 智能体</b><br/>
  多 Provider · 三层记忆 · 子代理派遣 · 流式 WebUI · 像素风纸质美术
</p>

<p align="center">
  <img src="assets/nav/nav-chat-active.png"    width="42" alt="Chat" />
  <img src="assets/nav/nav-model-active.png"   width="42" alt="Model" />
  <img src="assets/nav/nav-tokens-active.png"  width="42" alt="Tokens" />
  <img src="assets/nav/nav-skills-active.png"  width="42" alt="Skills" />
  <img src="assets/nav/nav-tools-active.png"   width="42" alt="Tools" />
  <img src="assets/nav/nav-team-active.png"    width="42" alt="Team" />
  <img src="assets/nav/nav-scheduler-active.png" width="42" alt="Scheduler" />
  <img src="assets/nav/nav-configs-active.png" width="42" alt="Configs" />
  <img src="assets/nav/nav-mcp-active.png"     width="42" alt="MCP" />
  <img src="assets/nav/nav-memory-active.png"  width="42" alt="Memory" />
</p>

---

> 用户下旨，主智能体（"大内总管"）统筹上下文、工具、记忆与子代理；把任务拆解、执行、校验后回禀。
> 项目重点不是教学材料，而是一个可持续演进的个人 Agent 工程。

---

## ✨ 快速开始

### 1. Python 后端

```bash
python -m venv .venv
source .venv/bin/activate                 # Windows: .venv\Scripts\activate
pip install -r requirements.txt

cp model_config.example.json model_config.json
# 在 model_config.json 中选择 provider/model，并填入对应 apiKey
```

### 2. CLI 模式

```bash
python agent.py
```

启动时若发现热 `memory/history.jsonl` 中有活跃对话，会先调用模型做一次启动压缩。

### 3. WebUI 模式

WebUI 用 **Vue 3 + Vite + Tailwind + vue-router** 构建，**首次使用前必须先打包前端产物**：

```bash
cd webui
npm install
npm run build              # 产出 webui/dist/
cd ..
python webui.py
# 浏览器打开 http://127.0.0.1:8765
```

后端 aiohttp 服务器把 `webui/dist/` 作为 SPA 静态资源托管，并代理 `/api/*` 与 `/ws`。前端开发模式可以另起 `cd webui && npm run dev`（Vite 5173），并配 proxy 指到 8765。

### 4. 质量检查

开发环境建议安装 dev 依赖：

```bash
pip install -r requirements-dev.txt
git diff --check
python -m ruff check agent tests
python -m pytest
cd webui && npm run build
```

<p align="center">
  <img src="assets/empty/welcome-hero.png" alt="御书房 · 准备就绪" width="640" />
</p>

---

## 🧧 首次启动会发生什么

`memory/`、`templates/USER.local.md`、`model_config.json`、`webui/dist/`、`webui/node_modules/` 都被 `.gitignore` 排除，所以新克隆的仓库是**干净**的。首次启动会自动从仓库内的初始化模板生成本地副本：

| 私密文件 | 由谁生成 | 来源 |
|---|---|---|
| `memory/`（整个目录） | `MemoryStore._ensure()` | `mkdir` |
| `memory/MEMORY.local.md` | `MemoryStore._ensure()` | 复制 `templates/init/MEMORY.md` |
| `memory/history.jsonl` | `HistoryLog` 首次启动 | 热对话日志，只保留活跃上下文 |
| `memory/history_index.json` | `HistoryLog` 首次启动 | 热/冷历史统计索引 |
| `memory/history_archive/*.jsonl.gz` | 压缩后自动生成 | 已压缩原始对话冷归档 |
| `memory/versions/` | 记忆写入或恢复时生成 | `MEMORY.local.md`、`USER.local.md` 与情景记忆的本地快照 |
| `memory/tokens.jsonl` | `TokenTracker` 首次写入 | append |
| `memory/control/state.json` | `ControlStore` 首次启动 | 当前 ask / plan 等待状态 |
| `memory/runtime/events.jsonl` | `RuntimeEventStore` 首次启动 | Chat 行为事件热日志，只保留活跃 turn |
| `memory/runtime/index.json` | `RuntimeEventStore` 首次启动 | Runtime 热/冷统计索引 |
| `memory/runtime/archive/*.jsonl.gz` | Runtime 维护/压缩后生成 | 已归档的旧行为事件 |
| `memory/scheduler/jobs.json` | `SchedulerStore` 首次启动 | 本地持久定时任务热配置 |
| `memory/scheduler/action.jsonl` | `SchedulerStore` 写操作 | 跨入口 action log，用于合并任务变更 |
| `memory/watchlist.md` | `WatchlistStore` 首次启动 | 主动检查清单，供 Scheduler heartbeat 周期判断 |
| `memory/watchlist_state.json` | Watchlist 检查后写入 | 最近一次 skip/run 决策与模型信息 |
| `templates/USER.local.md` | `AgentLoop._ensure_local_user_file()` | 复制 `templates/init/USER.md` |
| `model_config.json` | **需要手动** `cp model_config.example.json model_config.json` 并填 apiKey |  |
| `webui/dist/` | **需要手动** `cd webui && npm install && npm run build` | Vite 构建 |

只要按"快速开始"两步走，引导链路就完整了，无需再手动建任何目录。

---

## ⚔️ 核心能力

- **多轮对话** — 保留当前会话工作记忆；流式 delta 与工具事件实时显示。
- **三层记忆** — 工作记忆（`history`）、情景记忆（`memory/YYYY-MM-DD.md`）、长期记忆（`memory/MEMORY.local.md`）协同运转。
- **自动压缩** — 上下文超过阈值时把旧对话归档为情景记忆，并刷新长期记忆与用户档案。
- **记忆版本回滚** — 长期记忆、用户档案与每日情景记忆写入前自动保存轻量快照；Memory 页和 `/memory-log` / `/memory-restore` 可查看 diff 并恢复。
- **多厂家 + 双模型路由** — DeepSeek、Anthropic、OpenAI、Azure OpenAI、AWS Bedrock、OpenRouter、DashScope（阿里云）、SiliconFlow、Ollama、vLLM、OpenAI Codex、GitHub Copilot 与自定义 OpenAI-compatible endpoint；每个 entry 同时配置主模型与次模型，简单任务自动走次模型，失败后升主模型一次。
- **MCP 外部工具** — 通过 stdio 或 SSE 连接外部 MCP 服务器，自动发现工具并注册为 `mcp_{server}_{tool}`，与内置工具统一调度。
- **流式 WebUI** — 网页聊天通过 WebSocket 接收 `message_delta`、`tool_call`、`tool_result`、`subagent_*` 等事件；活跃行为事件持久化到 `memory/runtime/events.jsonl`，旧事件进入 `memory/runtime/archive/*.jsonl.gz`，刷新或后端重启后按 seq 回放未压缩会话细节；Scheduler 主动 turn 会显示为中性的“定时任务触发”卡片，不伪装成用户消息；Chat 停止按钮与 `/stop` 会通过统一 active task registry 取消当前 turn / Scheduler run / Watchlist check。
- **三模式权限与 Ask / Plan 控制流** — 默认 `ask_before_edit` 会在危险或不确定动作前审批；`auto` 走最高自动权限；`plan` 只允许只读探索、提问和提交 PlanCard，批准或取消后恢复进入 Plan 前的模式。
- **本地 Scheduler** — 持久保存 `at` / `every` / `cron` 任务，启动 WebUI 后后台 timer 自动恢复；支持触发本地主动 Agent turn、Team wake 与系统维护 heartbeat；Agent 可通过 `scheduler` 工具查看任务，创建/修改/删除/手动运行长期任务会走权限审批。
- **Watchlist Heartbeat** — `memory/watchlist.md` 记录希望系统主动留意的事项；受保护的 `watchlist-check` 定期用次模型判断 `skip/run`，只有必要时才投递完整主动 turn。
- **External Bridge 基础** — `agent/external/` 提供通用外部平台适配骨架、入站去重、inbox/outbox 状态和 runtime 事件；当前不内置任何具体平台实现。外部消息只会汇入唯一主线，不创建多会话、不暴露 `session_id`。
- **Token 统计** — 按日期、provider/model、使用种类（main_agent / subagent / memory_compaction）汇总，并按“输入缓存命中 / 输入缓存未命中 / 输出 / 总 Token”展示。
- **工具调用** — 命令执行、网页抓取、文件读写、Glob/Grep 搜索、技能加载、todo 维护、子代理派遣。
- **任务规划** — 内置 todolist，未完成时自动 nudge 模型继续执行。
- **子代理派遣** — 把独立任务交给不同身份的子代理（独立 history、独立工具白名单），结果摘要回填主上下文，多个子代理可并发派遣。
- **Agent Team** — Lead 可召入持久队友，队友拥有 `.team/` 下独立 inbox、thread、状态和 WebUI 工作台；v1 采用“按消息唤醒”，不启动后台常驻轮询。
- **技能系统** — 按需加载 `skills/` 下的能力包，避免一开始塞满 system prompt。
- **历史保护** — `runner._pair_tool_calls` 保证 OpenAI 格式 history 中 assistant `tool_calls` 与 tool 消息严格配对，运行时异常或压缩切边都不会污染下一次请求。
- **上下文治理** — 每次 LLM 调用前自动跑两步：单条工具结果硬截断（`_cap_tool_result`，留头尾，默认 8KB 上限）+ 旧大体积工具消息摘要化（`_shrink_old_tool_results`，最近 10 条保留原文，更早的替换为 `[shrunk] name → N chars omitted`）。让长对话从 8-10 轮稳定到 30+ 轮不撞 token 上限。
- **LLM 错误恢复** — `step_async` 内置两个状态机：模型偶发空响应时自动注入 nudge 重试（≤2 次）；`finish_reason="length" / "max_tokens"` 时自动续写并拼接（≤3 次）。前端通过既有 `tool_error` 事件可见 `_empty_response` / `_length_truncation` 提示。
- **中断恢复 Checkpoint** — `MemoryStore.write_checkpoint` 在每次工具批次完成后把 history 原子写到 `memory/_checkpoint.json`（gitignore），关 tab / Ctrl-C / 模型超时都不丢。`AgentLoop` 启动时 `read_checkpoint` 优先于 `history.jsonl` 未归档段恢复 in-memory history，再 `clear_checkpoint`；`_pair_tool_calls` 兜底处理任何 orphan tool_call。turn 正常落地时自动清理。
- **对话附件** — Composer 支持点选 / 拖拽上传图片（png / jpeg / webp / gif，≤10MB）和文档（pdf / json / csv / text / markdown，≤25MB），单条消息至多 5 个。文件落盘到 `memory/attachments/YYYY-MM/{hash8}-{name}.{ext}`，PDF 与文本文档同步抽取 sidecar 文本（`pypdf`），发消息时按 OpenAI 多模态格式装配 user content：vision-capable entry 走 `image_url` block，否则替换为占位提示；文档总把抽出的文本内联进 prompt，并在末尾附落盘路径供 `read_file` 兜底读取。User 多模态消息在 cap/shrink 链上原样保留，不会被截断；WebUI 刷新恢复时只显示用户原话与附件卡片，不把模型侧提取文本 / 落盘说明塞回气泡。
- **视觉徽章 + 连通测试** — `/model` 编辑器内置「测试文本」「测试视觉」两个按钮：发一次最小 ping 或一张内置 2×2 红色 PNG 探测图，返回延迟、模型名、响应 sample。视觉测试通过会自动把 `entry.supports_vision = true` 持久化到 `model_config.json`，entry 列表立刻在该条目右侧显示视觉能力像素徽章；Composer 的附件按钮 tooltip 与图片上传路径都依据该徽章决定走视觉链还是占位文字。

---

## 🏯 项目结构

```text
agent.py                        CLI 启动入口
webui.py                        WebUI 启动入口

agent/
├── loop.py                     主循环、组件装配、CLI 命令处理
├── model_router.py             主/次模型路由：main_agent、memory、subagent、team 的模型选择与 fallback
├── runner.py                   单轮执行编排、tool_use 循环、并发安全工具组合、tool_call 配对保护、上下文治理（cap/shrink）、空响应+截断重试
├── runner_model.py             ModelCaller：模型调用、流式 delta、次模型失败后升主模型一次
├── memory.py                   三层记忆存储、未归档历史载入、中断恢复 checkpoint
├── memory_versions.py          记忆快照、diff 与 restore，本地存储在 memory/versions/
├── attachments.py              附件落盘 + mime 校验 + PDF/文本抽取 + 引用反查（LRU）
├── compactor.py                历史压缩与长期记忆 / 用户档案更新
├── model_config.py             多 provider 模型配置读写
├── context.py                  system prompt 组装（SOUL.md / TOOL.md / USER.md / MEMORY / Skills）
├── control/                    Ask / Plan 会话控制：pending interaction、暂停/恢复、Ask Guard
├── permissions/                Claude Code 风格三模式权限策略：ask_before_edit / auto / plan
├── runtime/                    WebUI 行为事件冷记录、event payload、seq replay
├── scheduler/                  本地长期自动运行中枢：job store / timer service / scheduler tool
├── watchlist/                  Watchlist heartbeat：本地清单、次模型 skip/run 决策、主动 turn 过滤
├── external/                   外部平台适配基础：adapter 抽象、统一消息模型、bridge service
├── web/                        aiohttp Web 后端：app/state/routes/services 分层
│   ├── app.py                  aiohttp app 与中间件
│   ├── state.py                共享依赖、广播、bootstrap glue
│   ├── routes/                 HTTP / WS 路由注册，不拼复杂 payload
│   └── services/               chat / model / memory / team 业务服务
├── skills.py                   skill 加载与摘要生成
├── telemetry.py                token 用量记录、压缩触发判断、按多维度统计
├── webui.py                    兼容入口，导出 create_app() / main()
├── providers/                  Provider 抽象层
│   ├── base.py                 LLMProvider / GenerationSettings / ToolCallRequest / LLMResponse
│   ├── registry.py             ProviderSpec 表 + 名称查找
│   ├── factory.py              ProviderSnapshot 与 create_provider()
│   ├── anthropic_provider.py   Anthropic Messages API
│   ├── bedrock_provider.py     AWS Bedrock
│   └── openai_compat.py        OpenAI / Azure / Codex / Copilot / DeepSeek / DashScope / SiliconFlow / Ollama / vLLM / OpenRouter
├── subagents/                  子代理 spec 与 registry
├── team/                       Agent Team：持久队友、MessageBus、TeamStore、team tools
├── tools/                      内建工具
└── mcp/                        MCP Client（外部工具连接）
    ├── base.py / registry.py / schema.py
    ├── shell.py / web.py / filesystem.py / search.py
    ├── skills.py / todo.py / dispatch.py

templates/
├── SOUL.md                     智能体灵魂档案（已提交）
├── TOOL.md                     工具使用约定（已提交）
├── USER.local.md               本地个人用户档案（gitignore，首启自动生成）
├── init/
│   ├── MEMORY.md               长期记忆初始化模板（已提交）
│   └── USER.md                 用户档案初始化模板（已提交）
├── agent/                      主智能体 prompt 模板（compact_prompt.md / identity.md / skills_section.md ...）
└── subagents/                  各身份子代理模板

skills/                         技能包，每个目录一个 SKILL.md
memory/                         运行期产物（gitignore，首启自动创建）
├── MEMORY.local.md             长期记忆
├── history.jsonl               热对话日志：只保存活跃上下文
├── history_index.json          history 热/冷统计索引
├── history_archive/            已压缩原始对话冷归档：YYYY-MM.jsonl.gz
├── versions/                   记忆版本快照：index.json + snapshots/*.json
├── tokens.jsonl                token 用量明细
├── control/state.json          Ask / Plan 当前模式与等待交互状态
├── runtime/events.jsonl        Chat 行为流：工具、子代理、队友、Ask/Plan、assistant_done
├── scheduler/
│   ├── jobs.json               持久 Scheduler jobs：at / every / cron
│   └── action.jsonl            append-only action log，用于跨入口写入合并
├── watchlist.md                主动检查清单：每行一个希望系统定期留意的事项
├── watchlist_state.json        最近一次 Watchlist skip/run 决策
├── _checkpoint.json            未完成 turn 的 history 快照（中断恢复用）
├── attachments/                上传附件落盘：YYYY-MM/{hash8}-{name}.{ext} + sidecar .txt
└── YYYY-MM-DD.md               每日情景记忆

.team/                          Agent Team 运行期状态（gitignore，首次召入队友自动创建）
├── config.json                  队友 roster：name / role / agent_type / status
├── inbox/                       lead 与各 teammate 的 append-only JSONL inbox
├── threads/                     teammate 独立上下文
├── checkpoints/                 teammate 未完成 wake 的恢复点
└── cursors/                     各 actor inbox 已读游标

model_config.json               本地私密模型配置（gitignore，需手动从 example 复制）
model_config.example.json       配置范例（已提交）

assets/                         WebUI 像素风素材库（已提交）
├── nav/                        导航图标（默认 + 激活）
├── tools/                      11 张工具事件图标
├── actions/                    10 张操作 / 状态图标
├── attachments/                5 张附件类型图标（image / pdf / markdown / text / file）
├── model/                      4 张模型能力图标（text / vision / test ok / test fail）
├── avatars/                    3 张角色头像
├── brand/                      logo / favicon / og-cover
├── empty/                      4 张空态插画
└── textures/                   2 张纸质 / 印章纹理

webui/                          前端工作台（Vue 3 + Vite + Tailwind + vue-router）
├── package.json
├── vite.config.ts / tailwind.config.ts / tsconfig.json
├── public/                     直接拷贝到产物的静态资源（favicon）
├── dist/                       Vite 构建产物（gitignore）
└── src/
    ├── main.ts                 应用入口，加载 router + brandAssets 设置 favicon
    ├── App.vue                 二列 shell：NavRail + RouterView，provide/inject 全局状态
    ├── router.ts               7 条一级路由 + SPA fallback
    ├── assets.ts               assets/ PNG 引用聚合（brandAssets / actionAssets / attachmentIcon / navIcon ...）
    ├── styles.css              Tailwind base 与全局变量
    ├── styles/                 layout / chat / activity / panels / responsive 分层样式
    ├── api/http.ts             fetch 封装
    ├── commands.ts             斜杠命令解析
    ├── types.ts                共用 TS 类型
    ├── composables/
    │   ├── useBootstrap.ts     拉取 /api/bootstrap、读写 skill / config / memory / model
    │   ├── useRuntime.ts       WebSocket 生命周期、发送消息、replay 调度
    │   └── useAppContext.ts    provide / inject 桥接，跨路由保活
    ├── components/
    │   ├── layout/NavRail.vue          左侧导航 + 状态卡 + 指标格 + 清屏按钮
    │   ├── chat/                       MessageList / AssistantFlow / ToolEvent / SubagentTrail / TodoPanel / Composer / PendingBar / MarkdownBlock / ExpandableText
    │   └── panels/                     ModelPanel / TokensPanel / SkillsPanel / ToolsPanel / ConfigPanel / MemoryPanel
    ├── runtime/                        events / reducer / selectors / persistence
    └── views/                          ChatView / ModelView / TokensView / SkillsView / ToolsView / TeamView / SchedulerView / ConfigsView / MemoryView
```

---

## 🗺️ WebUI 架构

二列布局：左侧 **NavRail**（品牌、状态、4 项指标、10 项导航、清屏按钮）+ 右侧 **RouterView**。每个功能一个独立路由，主区独占全宽。

| | 路由 | 视图 | 用途 |
|---|---|---|---|
| <img src="assets/nav/nav-chat.png"    width="28" alt="" /> | `/chat`                    | ChatView    | 默认页，流式聊天，tool / subagent 事件可视化 |
| <img src="assets/nav/nav-model.png"   width="28" alt="" /> | `/model`                   | ModelView   | Provider、model、apiBase、apiKey、temperature、maxTokens、reasoningEffort、上下文窗口 |
| <img src="assets/nav/nav-tokens.png"  width="28" alt="" /> | `/tokens`                  | TokensView  | 总量 + 按 model / 用途 / 日期 / KV Cache 统计 |
| <img src="assets/nav/nav-skills.png"  width="28" alt="" /> | `/skills` `/skills/:name`  | SkillsView  | 列表 + SKILL.md 编辑器 |
| <img src="assets/nav/nav-tools.png"   width="28" alt="" /> | `/tools`                   | ToolsView   | 注册的工具与 MCP 工具一览 |
| <img src="assets/nav/nav-team.png"    width="28" alt="" /> | `/team`                    | TeamView    | Agent Team 队友、Inbox、执行轨迹 |
| <img src="assets/nav/nav-scheduler.png" width="28" alt="" /> | `/scheduler`             | SchedulerView | 本地长期任务、运行历史与手动调度 |
| <img src="assets/nav/nav-configs.png" width="28" alt="" /> | `/configs` `/configs/:path(.*)` | ConfigsView | TOOL.md / USER.md 编辑器 |
| <img src="assets/nav/nav-mcp.png"     width="28" alt="" /> | `/mcp`                     | McpView     | MCP 服务器配置（JSON 编辑器 + 已加载工具列表） |
| <img src="assets/nav/nav-memory.png"  width="28" alt="" /> | `/memory`                  | MemoryView  | 长期记忆、今日情景、历史归档列表 |

**跨路由保活**：`useBootstrap` / `useRuntime` 在 `App.vue` 顶层执行，通过 `provide()` 注入；`<router-view>` 用 `<keep-alive>` 包住，切换路由时 WebSocket、消息流、Composer 草稿、滚动位置都不丢。

**SPA fallback**：`agent/web/routes/chat.py` 注册静态处理器，对未匹配 `/api/*` 与 `/ws` 的路径回退到 `index.html`，刷新 `/skills/foo` 等深层路由不会 404。

**素材管线**：所有 PNG 放在仓库根 `assets/` 下，`webui/src/assets.ts` 用 `new URL('../../assets/...', import.meta.url)` 引用。Vite 会在 `npm run build` 时把它们指纹哈希后输出到 `webui/dist/assets/`。新增图标只需放进对应子目录并在 `assets.ts` 中加一行。

---

## ⚙️ 模型配置

模型配置使用本地 `model_config.json`，允许明文保存 API key。该文件已加入 `.gitignore`。

默认配置摘要：

```json
{
  "agents": {
    "defaults": {
      "model": "deepseek-work",
      "provider": "deepseek",
      "maxTokens": 20000,
      "temperature": 0.1,
      "reasoningEffort": null,
      "contextWindowTokens": 200000
    }
  },
  "models": [
    {
      "name": "deepseek-work",
      "provider": "deepseek",
      "mainModelId": "deepseek-reasoner",
      "secondaryModelId": "deepseek-chat",
      "apiKey": "",
      "apiBase": null
    }
  ],
  "providers": {
    "deepseek":   { "apiKey": "", "apiBase": "https://api.deepseek.com" },
    "anthropic":  { "apiKey": "", "apiBase": null },
    "openai":     { "apiKey": "", "apiBase": null },
    "openrouter": { "apiKey": "", "apiBase": "https://openrouter.ai/api/v1" },
    "dashscope":  { "apiKey": "", "apiBase": "https://dashscope.aliyuncs.com/compatible-mode/v1" },
    "ollama":     { "apiKey": "", "apiBase": "http://localhost:11434/v1" },
    "vllm":       { "apiKey": "", "apiBase": "http://localhost:8000/v1" },
    "...": "等等"
  }
}
```

WebUI `/model` 页可以编辑全部字段并热更新。一个模型条目共享同一套 `provider / apiKey / apiBase`，但必须同时填写 `mainModelId` 与 `secondaryModelId`：主模型负责主 Agent、复杂决策和写入型队友；次模型负责记忆压缩、轻量子代理和只读/核验型队友。旧配置里的 `id` 会被兼容读取为 `mainModelId`，启动与普通运行仍可在缺少次模型时降级主模型；但再次保存时必须补齐 `secondaryModelId`。

`/api/model-test` 的语义更严格：显式测试 `role=secondary` 时，如果 entry 没有 `secondaryModelId`，后端会返回 `400`，前端也会禁用“测试次模型”按钮并提示先补齐；这条测试路径不会偷偷 fallback 到主模型。视觉测试始终绑定主模型，因为 `supportsVision` 表示主模型附件能力。

---

## 🧠 记忆系统

<table>
<tr>
<td width="180" align="center">
  <img src="assets/empty/empty-memory.png" alt="记忆层" width="160" />
</td>
<td>

| 层 | 载体 | 写入时机 | 读取方式 |
|----|------|----------|----------|
| 工作记忆 | `history` 列表（内存） | 每轮对话追加 | 全量传给模型 |
| 情景记忆 | `memory/YYYY-MM-DD.md` | 压缩触发时生成 | 按需检索 |
| 长期记忆模板 | `templates/init/MEMORY.md` | 仓库格式 | 首启自动复制到本地 |
| 长期记忆 | `memory/MEMORY.local.md` | 压缩或启动归档时更新 | 每轮注入 system prompt |
| 用户档案模板 | `templates/init/USER.md` | 仓库格式 | 首启自动复制到本地 |
| 用户档案 | `templates/USER.local.md` | 压缩或 WebUI Config 编辑时更新 | 每轮注入 system prompt |
| 活跃原始历史 | `memory/history.jsonl` | 每轮 user/assistant 追加；压缩后原子重写 | 启动时直接载入热日志 |
| 原始历史冷归档 | `memory/history_archive/YYYY-MM.jsonl.gz` | 压缩完成后写入 | 默认不注入上下文，保留审计/备份 |
| 行为事件热记录 | `memory/runtime/events.jsonl` | 每个活跃 WebUI runtime 事件 append；压缩/维护后旧事件轮转 | Chat 刷新后重放未压缩 turn 的工具/队友/Ask/Plan 细节 |
| 行为事件冷归档 | `memory/runtime/archive/YYYY-MM.jsonl.gz` | Runtime 维护或压缩后生成 | 默认不重放，保留审计/备份 |

</td>
</tr>
</table>

Token 账本：`memory/tokens.jsonl` 每行记录一次模型调用，字段包括 `input`、`output`、`cache_read`、`cache_create`、`provider`、`model`、`usage_type`。Anthropic 的 `cache_read_input_tokens` / `cache_creation_input_tokens` 会归一化到 `cache_read` / `cache_create`；OpenAI-compatible 的 `prompt_tokens_details.cached_tokens` 会归一化到 `cache_read`，并从普通 `input` 中扣除以避免重复统计。WebUI Token 页把这些字段派生为 4 个主口径：输入缓存命中 = `cache_read`，输入缓存未命中 = `input + cache_create`，输出 = `output`，总 Token = 前三者合计；大数字按 K / W / M 自动缩写，完整值保留在悬停提示里。

压缩触发：`TokenTracker.should_compact(max_context, threshold=0.7)` —— 上一次调用的 input + cache_read + cache_create 估算超过窗口的 70% 时，下一轮 step 结束后压缩 `history[:-K]`（K 默认 10），保留最近 K 条。压缩完成后，`history.jsonl` 会被重写为热日志；旧原始行进入 `memory/history_archive/YYYY-MM.jsonl.gz`，`memory/history_index.json` 记录热日志大小、归档文件数和最近归档时间。

Chat 页面只展示未压缩 turn 的完整行为细节；压缩前的工具调用、队友轨迹、Ask/Plan 卡片会从热 `memory/runtime/events.jsonl` 转入 `memory/runtime/archive/YYYY-MM.jsonl.gz`，后续可用于审计或历史浏览页。

`memory/`、`.team/`、`templates/USER.local.md`、`model_config.json` 都是本地私密文件，**不要提交**。

---

## 🛠️ 内置工具

<table>
<tr>
<td width="180" align="center">
  <img src="assets/empty/empty-tools.png" alt="工具箱" width="160" />
</td>
<td>

| | 工具 | 作用 | 并发安全 |
|---|------|------|----------|
| <img src="assets/tools/tool-shell.png"    width="20" alt="" /> | `run_command`             | 执行 shell 命令               | ✗ |
| <img src="assets/tools/tool-web.png"      width="20" alt="" /> | `web_fetch`               | 抓取 URL 内容                 | ✓ |
| <img src="assets/tools/tool-read.png"     width="20" alt="" /> | `read_file`               | 工作区文件读取                | ✓ |
| <img src="assets/tools/tool-write.png"    width="20" alt="" /> | `write_file`              | 工作区文件写入                | ✗ |
| <img src="assets/tools/tool-edit.png"     width="20" alt="" /> | `edit_file`               | 局部编辑                      | ✗ |
| <img src="assets/tools/tool-glob.png"     width="20" alt="" /> | `glob`                    | 工作区路径匹配                | ✓ |
| <img src="assets/tools/tool-grep.png"     width="20" alt="" /> | `grep`                    | 工作区内容搜索                | ✓ |
| <img src="assets/tools/tool-skill.png"    width="20" alt="" /> | `load_skill`              | 按需加载技能                  | ✓ |
| <img src="assets/tools/tool-todo.png"     width="20" alt="" /> | `update_todos`            | 维护当前任务列表              | ✗ |
| <img src="assets/tools/tool-todo.png"     width="20" alt="" /> | `ask_user`                | 暂停当前 turn，向用户提结构化问题 | ✗ |
| <img src="assets/tools/tool-todo.png"     width="20" alt="" /> | `propose_plan`            | Plan 模式下提交计划草案并等待评论/批准 | ✗ |
| <img src="assets/tools/tool-todo.png"     width="20" alt="" /> | `scheduler`               | 查看/管理本地长期定时任务         | ✗（`list` 走权限层放行） |
| <img src="assets/tools/tool-subagent.png" width="20" alt="" /> | `dispatch_subagent`       | 派遣子代理独立办差            | ✓（多个子代理可并发） |
| <img src="assets/tools/tool-subagent.png" width="20" alt="" /> | `spawn_teammate`          | 召入持久队友并可立即派任务    | ✗ |
| <img src="assets/tools/tool-subagent.png" width="20" alt="" /> | `list_teammates`          | 查看 Agent Team 队友状态      | ✓ |
| <img src="assets/tools/tool-subagent.png" width="20" alt="" /> | `send_message`            | 向 lead / teammate inbox 留言 | ✗ |
| <img src="assets/tools/tool-subagent.png" width="20" alt="" /> | `read_inbox`              | 读取当前 actor 的 inbox       | ✗（默认会移动已读游标） |
| <img src="assets/tools/tool-subagent.png" width="20" alt="" /> | `broadcast`               | 向多个队友广播并可逐个唤醒    | ✗ |
| <img src="assets/tools/tool-subagent.png" width="20" alt="" /> | `shutdown_teammate`       | 关闭队友，保留历史记录        | ✗ |

</td>
</tr>
</table>

`AgentRunner` 会把同一帧内多个并发安全的工具调用合并为 `asyncio.gather`，按原顺序回填结果。

附件文档落盘后，主代理也可以主动 `read_file memory/attachments/.../foo.pdf.txt` 读取被抽出来的 sidecar 文本——这是给非视觉模型保留的一条兜底链路。

---

## 🧭 权限模式与 Ask / Plan 控制流

`agent/control/` 负责可暂停交互，`agent/permissions/` 负责 Claude Code 风格的执行模式判断。状态持久化在 `memory/control/state.json`，配合 `memory/_checkpoint.json` 与 `memory/runtime/events.jsonl`，刷新页面或后端重启后仍能恢复 pending interaction 与对应 Chat 卡片。

| 模式 | 入口 | 行为 |
|---|---|---|
| `ask_before_edit` | 默认、`/mode ask` | 读操作直接执行，普通编辑可执行；危险、不确定、破坏性或高影响操作先进入 AskCard 审批 |
| `auto` | `/mode auto` 或 Composer 模式选择器 | 工具层不主动审批；仍保留路径安全、schema 校验和工具自身异常保护 |
| `plan` | `/mode plan`、`/plan on` 或 Composer 模式选择器 | 只读探索 + `ask_user` + `propose_plan`；写文件、命令执行、Team 写操作、子代理派遣不可用 |

| 机制 | 入口 | 行为 |
|---|---|---|
| Ask | `ask_user(questions, context?)` | Agent 提出 1-3 个结构化问题，每题 2-4 个选项，可带自由补充；Ask Guard 在高影响歧义下会阻止写操作/最终答复并强制进入 Ask；用户回答后把结构化答案注入 history 并继续当前任务 |
| Plan | `/plan on` 或 WebUI Chat Composer 模式选择器 | 进入硬门禁模式：模型只看到只读工具 + `ask_user` + `propose_plan`；普通最终文字会被 Runner 包装成 PlanCard 并暂停 |
| Approve | PlanCard / CLI `approve` | 批准后自动恢复进入 Plan 前的模式（`ask_before_edit` 或 `auto`），并把批准事件作为用户反馈注入 history，随后继续执行 |

Plan 模式不是提示词约束，而是工具层 + 输出层硬门禁：`write_file`、`edit_file`、`run_command`、`dispatch_subagent`、Team 写操作等不会暴露给模型；`scheduler` 在 Plan 模式下只允许 `action=list` 用于了解现有长期任务，创建/修改/删除/运行任务必须等计划批准后再执行。如果模型尝试调用未授权工具，Runner 会返回明确的拒绝结果；如果模型直接普通回复，Runner 会生成 `plan_draft` 并暂停，确保用户必须先看到 PlanCard。执行中或已有 pending Ask/Plan 时，`POST /api/control/mode` 会返回 409，避免中途切换模式导致工具策略漂移。

WebUI 手动点击被视为用户直接操作，不再二次弹 Agent AskCard；但执行型 mutation 仍会走统一 Web guard：存在 pending Ask/Plan 时拒绝 Scheduler run、Team wake、Team message wake 等操作，Plan 模式下拒绝新增/修改/运行长期任务与 Team 写操作，防止绕过计划门禁。

Ask Guard 当前采用“高影响歧义强制”策略：大范围工程化/重构/UI 取舍、提交推送、删除覆盖、发布部署、安全/权限/成本边界不清时，会要求先 `ask_user`；低风险、目标明确的小任务不打扰；`PLEASE IMPLEMENT THIS PLAN` 或决策完整的计划会跳过主动提问。

权限审批是“一次性同参授权”：用户允许后，同一个工具名 + 参数组合下一次执行会放行一次；用户拒绝后，同参操作下一次会返回明确拒绝，避免审批循环。

Scheduler 相关 HTTP API 已接入 Web 后端：`GET /api/scheduler`、`POST /api/scheduler/jobs`、`PATCH /api/scheduler/jobs/{id}`、`POST /api/scheduler/jobs/{id}/run|pause|resume`、`DELETE /api/scheduler/jobs/{id}`。运行事件会通过 `scheduler_job_update`、`scheduler_run_start`、`scheduler_run_done`、`scheduler_run_error`、`scheduler_run_cancelled` 进入 runtime 事件流。

当前运行中的 Chat turn、Scheduler run、Watchlist 手动检查会登记到进程内 active task registry；`POST /api/runtime/stop`、WebUI 停止按钮与 `/stop` 共用这一层取消任务，并发出 `runtime_task_cancelled` 事件。刷新后未完成轨迹仍由 runtime event log 还原，取消后的工具 / 子代理段会显示为已中断。

当前可执行 payload：`agent_turn` 会作为“定时任务触发”的主动 turn；`deliver=true` 时写入当前 Chat runtime，`deliver=false` 时只作为后台运行写入 Scheduler run history，不插入当前对话流；`team_wake` 会向目标 teammate 写入 task 消息并唤醒，`deliver=false` 时不把 Team 运行事件挂到当前 Chat；`system_event` 仅允许系统代码注册，普通 API / tool 创建会被拒绝。

Scheduler 投递到 Chat 的主动 turn 仍使用主线 `user_message` 事件，但会带 `source="scheduler"` 和 `{ jobId, jobName }` 元数据；前端会把它渲染为“定时任务触发”时间线卡片，而不是右侧用户圣旨气泡。`scheduler_run_done`、`scheduler_run_cancelled` 和 `scheduler_job_update` 的完成提示会短暂显示后自动消失；`scheduler_run_error` 会保持可见，直到下一次 pending 状态覆盖。

WebUI 启动时会自动登记 5 个受保护系统任务：`memory-maintenance`、`runtime-maintenance`、`team-stale-recovery`、`token-ledger-maintenance`、`watchlist-check`。它们在 Scheduler 页可见、可暂停/恢复/手动运行，但不能删除；Memory 页会显示维护任务状态，并提供 `memory/watchlist.md` 编辑与手动检查入口。

Watchlist 不是后台常驻聊天，而是“先过滤再投递”：`watchlist-check` 会读取 `memory/watchlist.md` 的有效条目，用次模型判断是否需要运行；`skip` 只记录状态，`run` 才把可投递消息包装成一次本地主动 `agent_turn`。这样可以保留长期自主性，同时避免清单项每次心跳都污染 Chat。

External Bridge 当前是基础设施层：`ExternalAdapter` 负责未来平台收发，`ExternalBridgeService` 负责入站去重、忙碌/Ask/Plan 时排队、outbox 状态与 `external_*` runtime 事件。它不提供真实飞书/Slack/Telegram adapter，也不会生成平台独立历史；外部消息进入模型前会带 `[EXTERNAL_MESSAGE]` 来源上下文，然后作为一次普通主线 turn 运行。

WebUI 相关接口：

| 类型 | 名称 |
|---|---|
| HTTP | `GET /api/control`、`POST /api/control/mode`、`POST /api/control/interactions/{id}/cancel` |
| HTTP | `GET /api/external` |
| WS client message | `interaction_answer`、`plan_comment`、`plan_approve`、`interaction_cancel` |
| WS server event | `user_message`（可带 `source="scheduler"`）、`scheduler_*`、`runtime_task_cancelled`、`control_mode_update`、`ask_request`、`ask_answered`、`plan_draft`、`plan_comment_added`、`plan_approved`、`interaction_cancelled`、`turn_paused`、`external_inbound`、`external_queued`、`external_outbound_*` |

CLI 也支持 `/mode ask|auto|plan|status` 与 `/plan on|off|status`。Ask pending 时会在终端打印问题并读取答案；Plan pending 时支持 `approve`、`comment <内容>`、`cancel`。

---

## 🔌 MCP 外部工具

Emperor Agent 内置 MCP Client，可连接外部 MCP 服务器扩展工具能力。

### 配置方式

创建 `mcp_config.json`（与 `model_config.json` 同级）：

```json
{
  "servers": {
    "filesystem": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"],
      "enabled": true,
      "tool_overrides": {
        "read_file": { "read_only": true }
      }
    },
    "fetch": {
      "transport": "stdio",
      "command": "uvx",
      "args": ["mcp-server-fetch"],
      "enabled": true
    },
    "remote": {
      "transport": "sse",
      "url": "http://localhost:3001/sse",
      "headers": {},
      "enabled": false
    }
  },
  "defaults": {
    "read_only": false,
    "exclusive": false
  }
}
```

| 字段 | 说明 |
|---|---|
| `transport` | `stdio`（本地命令）或 `sse`（HTTP 服务器） |
| `command` / `args` | stdio 模式下执行的命令 |
| `url` / `headers` | sse 模式下服务器地址与请求头 |
| `enabled` | 是否启用该服务器 |
| `tool_overrides` | 按工具名覆盖 `read_only` / `exclusive` |
| `env` | 额外环境变量（支持 `${ENV_VAR}` 插值） |

### WebUI 管理

`/mcp` 页面提供 JSON 配置编辑器 + 已加载 MCP 工具列表。保存后自动关闭旧连接、重新发现工具并注册。

### 安全提示

- MCP 子进程**仅继承白名单环境变量**（PATH、HOME、USER 等），API key 等敏感变量不会泄露给第三方 MCP 服务器
- 工具名格式为 `mcp_{server}_{tool}`，与内置工具隔离
- 单服务器连接失败不影响其他服务器和内置工具

---

## 👥 角色与子代理

主智能体（"大内总管"）服侍用户（"皇上"），可派遣"小太监"作为子代理处理独立差事——子代理拥有独立 `history` 与受限工具白名单，办完只把摘要返回主上下文。WebUI 会通过 `subagent_*` 事件实时显示子代理的进度（delta、tool_call、result、done / error）。轻量只读/核验子代理默认走当前 entry 的 `secondaryModelId`，写入型 `neiguan_yingzao` 仍走 `mainModelId`；次模型失败时自动升主模型重试一次。

Agent Team 是更长期的协作层：Lead 使用 `spawn_teammate` 创建队友，队友状态写入 `.team/config.json`，通信走 `.team/inbox/*.jsonl`，完整上下文保存在 `.team/threads/*.json`。v1 不启动后台常驻线程；`send_message(..., wake=true)` / `broadcast(..., wake=true)` 会按消息唤醒队友执行一次。队友按 agent_type 复用同一套主/次模型路由，token 用量记录为 `usage_type=team:<name>` 并带 `model_role`，主上下文只接收摘要，避免长期协作污染 Lead 的 history。

role 默认映射：

- `coder` → `neiguan_yingzao`
- `reviewer` → `shangbao_dianbu`
- `researcher` → `dongchang_tanshi`
- `reader` → `sili_suitang`
- `runner` → `xiaohuangmen`
- 未知 role → `sili_suitang`

<p align="center">
  <img src="assets/avatars/avatar-emperor.png"  width="140" alt="皇上"     />&nbsp;&nbsp;
  <img src="assets/avatars/avatar-eunuch.png"   width="140" alt="大内总管" />&nbsp;&nbsp;
  <img src="assets/avatars/avatar-subagent.png" width="140" alt="小太监"   />
</p>

<p align="center">
  <b>皇上</b>（用户）&nbsp;&nbsp;·&nbsp;&nbsp;
  <b>大内总管</b>（主智能体）&nbsp;&nbsp;·&nbsp;&nbsp;
  <b>小太监</b>（子代理）
</p>

当前内置子代理身份：

- `xiaohuangmen` — 轻量只读，适合快速确认和短命令。
- `sili_suitang` — 只读文书，适合阅读代码与整理文档。
- `dongchang_tanshi` — 只读查访，适合网页抓取和资料探索。
- `shangbao_dianbu` — 只读核验，适合清点文件、校对清单、检查遗漏。
- `neiguan_yingzao` — 可读写、可执行命令，适合修改文件、搭建工程、跑验收。

`researcher` 与 `general` 作为兼容别名保留，分别映射到 `dongchang_tanshi` 与 `neiguan_yingzao`。

---

## 📜 技能系统

<table>
<tr>
<td width="180" align="center">
  <img src="assets/empty/empty-skills.png" alt="技能卷轴" width="160" />
</td>
<td>

`skills/{name}/SKILL.md` 用 YAML frontmatter 描述触发条件，Markdown 写能力说明。主智能体在需要时通过 `load_skill` 拉取，避免一开始塞满 system prompt。

WebUI Composer 的 `/` 菜单会同时列出系统命令和当前项目全部 Skill。点击 Skill 会补全 `/<skill-name> ` 前缀；输入 `/<skill-name> 任务` 或 `/<skill-name>-skill 任务` 会作为结构化 `requested_skills` 随消息发送，后端会在本轮强制预加载 Skill 内容。Composer 和 Chat 气泡中，非系统命令的 `/skill` 前缀会以特殊颜色字体高亮；聊天气泡与刷新恢复仍只显示你的原始输入。

当前内置技能：

- `clawhub` — 技能库搜寻与安装
- `ddg-web-search` — DuckDuckGo 搜索
- `github` — GitHub CLI 交互
- `skill-creator` — 创建或更新技能
- `summarize` — URL、播客、文件总结
- `weather` — 天气查询

WebUI `/skills` 页可以新建、编辑、保存。保存后会触发 `loop.refresh_runtime_context()` 重建 system prompt。

</td>
</tr>
</table>

---

## 💬 CLI / WebUI 斜杠命令

CLI 与 WebUI Composer 都支持以下命令（CLI 输入，WebUI 在聊天框输入）：

| 命令 | 说明 |
|---|---|
| `/help` | 列出所有命令 |
| `/status` | 当前 provider / model / token / 工具与技能数 |
| `/model` | 当前模型详细信息 |
| `/tokens` | Token 用量统计（多维度，含 KV Cache） |
| `/tools` | 工具列表 |
| `/skills` | 技能列表 |
| `/config` | 可编辑配置文件 |
| `/memory` | 记忆状态摘要 |
| `/memory-log` | 最近记忆版本快照 |
| `/memory-restore <id>` | 恢复指定记忆版本 |
| `/plan on|off|status` | 开关或查看 Plan 模式 |
| `/mode ask|auto|plan|status` | 切换或查看三模式权限层 |
| `/stop` | 停止当前运行中的 turn / Scheduler 任务 / Watchlist 手动检查 |
| `/compact` | 立即压缩未归档对话（WebUI） |
| `/clear` | 清空当前网页屏幕（不删 memory） |
| `/reload` | 重新拉取 bootstrap |
| `/exit` | 退出 CLI |

WebUI 还支持 Skill 快捷调用：`/<skill-name> 任务` 会强制本轮使用指定 Skill；若 Skill 名与系统命令冲突，可用 `/<skill-name>-skill 任务`。Composer 与 Chat 中的 `/skill` 前缀会用特殊颜色字体区分，正文仍按普通文字显示。

---

## 🌐 环境变量

模型 API Key 默认从 `model_config.json` 读取。`.env` 仍可保留给你自己的工具或脚本使用，但主 Agent 不再依赖任何 `*_API_KEY` 环境变量。

---

## 🤝 协作约定

- **不要提交**：`memory/`、`.team/`、`templates/USER.local.md`、`model_config.json`、`.env`、`webui/dist/`、`webui/node_modules/`、任何 `*.local.md`。
- **可以提交**：`templates/init/*.md` 模板（保持通用）、`templates/SOUL.md` / `TOOL.md`、`assets/`（像素素材）、`skills/`、`webui/src/`、`webui/package*.json`。
- 新增 provider：在 `agent/providers/registry.py` 加 `ProviderSpec`，需要新 backend 时在 `factory.py` 加分支并新增 provider 实现。
- 新增工具：在 `agent/tools/` 实现 `Tool` 子类，到 `agent/loop.py` 注册。
- 新增会话控制能力：优先放在 `agent/control/`；权限审批策略放在 `agent/permissions/`；同步 `agent/runner.py` 暂停/恢复语义、`agent/web/routes/*` API / WS、`webui/src/types.ts` 与 chat 组件。
- 新增 WebUI 行为事件：优先通过 `agent/runtime/events.py` 构造 payload，经 `RuntimeEventStore` 持久化；前端同步 `webui/src/runtime/*` 与 `useRuntime.ts`。
- 新增外部平台适配：优先实现 `agent/external/ExternalAdapter` 并接入 `ExternalBridgeService`；必须汇入唯一主线，不得新增多会话、会话列表或 `session_id` 路由。
- 新增 MCP 服务器：在 `mcp_config.json` 中配置即可，无需改代码。
- 新增子代理：在 `templates/subagents/` 加身份模板，由 `SubagentRegistry` 自动加载。
- 新增 WebUI 图标：把 PNG 放进 `assets/<category>/`，在 `webui/src/assets.ts` 加引用，重新 `npm run build`。

---

<p align="center">
  <img src="assets/brand/logo-mark.png" alt="令" width="56" />
</p>

<p align="center">
  <sub>"大内总管 · 一条主线，边想边回。"</sub>
</p>
