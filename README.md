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

启动时若发现 `memory/history.jsonl` 中有未归档对话，会先调用模型做一次启动压缩。

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
| `memory/history.jsonl` | `MemoryStore._ensure()` | 创建空文件 |
| `memory/tokens.jsonl` | `TokenTracker` 首次写入 | append |
| `templates/USER.local.md` | `AgentLoop._ensure_local_user_file()` | 复制 `templates/init/USER.md` |
| `model_config.json` | **需要手动** `cp model_config.example.json model_config.json` 并填 apiKey |  |
| `webui/dist/` | **需要手动** `cd webui && npm install && npm run build` | Vite 构建 |

只要按"快速开始"两步走，引导链路就完整了，无需再手动建任何目录。

---

## ⚔️ 核心能力

- **多轮对话** — 保留当前会话工作记忆；流式 delta 与工具事件实时显示。
- **三层记忆** — 工作记忆（`history`）、情景记忆（`memory/YYYY-MM-DD.md`）、长期记忆（`memory/MEMORY.local.md`）协同运转。
- **自动压缩** — 上下文超过阈值时把旧对话归档为情景记忆，并刷新长期记忆与用户档案。
- **多厂家模型** — DeepSeek、Anthropic、OpenAI、Azure OpenAI、AWS Bedrock、OpenRouter、DashScope（阿里云）、SiliconFlow、Ollama、vLLM、OpenAI Codex、GitHub Copilot 与自定义 OpenAI-compatible endpoint。
- **MCP 外部工具** — 通过 stdio 或 SSE 连接外部 MCP 服务器，自动发现工具并注册为 `mcp_{server}_{tool}`，与内置工具统一调度。
- **流式 WebUI** — 网页聊天通过 WebSocket 接收 `message_delta`、`tool_call`、`tool_result`、`subagent_*` 等事件；断线自动重连并按 seq 回放。
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
├── runner.py                   单轮模型调用、tool_use 循环、并发安全工具组合、tool_call 配对保护、上下文治理（cap/shrink）、空响应+截断重试
├── memory.py                   三层记忆存储、未归档历史载入、中断恢复 checkpoint
├── attachments.py              附件落盘 + mime 校验 + PDF/文本抽取 + 引用反查（LRU）
├── compactor.py                历史压缩与长期记忆 / 用户档案更新
├── model_config.py             多 provider 模型配置读写
├── context.py                  system prompt 组装（SOUL.md / TOOL.md / USER.md / MEMORY / Skills）
├── skills.py                   skill 加载与摘要生成
├── telemetry.py                token 用量记录、压缩触发判断、按多维度统计
├── webui.py                    aiohttp Web 服务（HTTP + WebSocket 流式）
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
├── history.jsonl               原始对话与压缩标记
├── tokens.jsonl                token 用量明细
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
    ├── styles.css              Tailwind layer + 自定义 .nav-rail / .main-view / .view-head 等
    ├── api/http.ts             fetch 封装
    ├── commands.ts             斜杠命令解析
    ├── types.ts                共用 TS 类型
    ├── composables/
    │   ├── useBootstrap.ts     拉取 /api/bootstrap、读写 skill / config / memory / model
    │   ├── useRuntime.ts       WebSocket 连接、消息流、断线续接、本地快照
    │   └── useAppContext.ts    provide / inject 桥接，跨路由保活
    ├── components/
    │   ├── layout/NavRail.vue          左侧导航 + 状态卡 + 指标格 + 清屏按钮
    │   ├── chat/                       MessageList / AssistantFlow / ToolEvent / SubagentTrail / TodoPanel / Composer / PendingBar / MarkdownBlock / ExpandableText
    │   └── panels/                     ModelPanel / TokensPanel / SkillsPanel / ToolsPanel / ConfigPanel / MemoryPanel
    └── views/                          ChatView / ModelView / TokensView / SkillsView / ToolsView / ConfigsView / MemoryView
```

---

## 🗺️ WebUI 架构

二列布局：左侧 **NavRail**（品牌、状态、4 项指标、9 项导航、清屏按钮）+ 右侧 **RouterView**。每个功能一个独立路由，主区独占全宽。

| | 路由 | 视图 | 用途 |
|---|---|---|---|
| <img src="assets/nav/nav-chat.png"    width="28" alt="" /> | `/chat`                    | ChatView    | 默认页，流式聊天，tool / subagent 事件可视化 |
| <img src="assets/nav/nav-model.png"   width="28" alt="" /> | `/model`                   | ModelView   | Provider、model、apiBase、apiKey、temperature、maxTokens、reasoningEffort、上下文窗口 |
| <img src="assets/nav/nav-tokens.png"  width="28" alt="" /> | `/tokens`                  | TokensView  | 总量 + 按 model / 用途 / 日期 / KV Cache 统计 |
| <img src="assets/nav/nav-skills.png"  width="28" alt="" /> | `/skills` `/skills/:name`  | SkillsView  | 列表 + SKILL.md 编辑器 |
| <img src="assets/nav/nav-tools.png"   width="28" alt="" /> | `/tools`                   | ToolsView   | 注册的工具与 MCP 工具一览 |
| <img src="assets/nav/nav-team.png"    width="28" alt="" /> | `/team`                    | TeamView    | Agent Team 队友、Inbox、执行轨迹 |
| <img src="assets/nav/nav-configs.png" width="28" alt="" /> | `/configs` `/configs/:path(.*)` | ConfigsView | TOOL.md / USER.md 编辑器 |
| <img src="assets/nav/nav-mcp.png"     width="28" alt="" /> | `/mcp`                     | McpView     | MCP 服务器配置（JSON 编辑器 + 已加载工具列表） |
| <img src="assets/nav/nav-memory.png"  width="28" alt="" /> | `/memory`                  | MemoryView  | 长期记忆、今日情景、历史归档列表 |

**跨路由保活**：`useBootstrap` / `useRuntime` 在 `App.vue` 顶层执行，通过 `provide()` 注入；`<router-view>` 用 `<keep-alive>` 包住，切换路由时 WebSocket、消息流、Composer 草稿、滚动位置都不丢。

**SPA fallback**：`agent/webui.py` 的静态处理器对未匹配 `/api/*` 与 `/ws` 的路径回退到 `index.html`，刷新 `/skills/foo` 等深层路由不会 404。

**素材管线**：所有 PNG 放在仓库根 `assets/` 下，`webui/src/assets.ts` 用 `new URL('../../assets/...', import.meta.url)` 引用。Vite 会在 `npm run build` 时把它们指纹哈希后输出到 `webui/dist/assets/`。新增图标只需放进对应子目录并在 `assets.ts` 中加一行。

---

## ⚙️ 模型配置

模型配置使用本地 `model_config.json`，允许明文保存 API key。该文件已加入 `.gitignore`。

默认配置摘要：

```json
{
  "agents": {
    "defaults": {
      "model": "deepseek-v4-flash",
      "provider": "deepseek",
      "maxTokens": 20000,
      "temperature": 0.1,
      "reasoningEffort": null,
      "contextWindowTokens": 200000
    }
  },
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

WebUI `/model` 页可以编辑全部字段并热更新；主 Agent、子代理、记忆压缩共用这份配置。

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
| 原始历史 | `memory/history.jsonl` | 每轮 user/assistant 追加 | 启动时载入未归档段，必要时启动压缩 |

</td>
</tr>
</table>

Token 账本：`memory/tokens.jsonl` 每行记录一次模型调用，字段包括 `input`、`output`、`cache_read`、`cache_create`、`provider`、`model`、`usage_type`。Anthropic 的 `cache_read_input_tokens` / `cache_creation_input_tokens` 会归一化到 `cache_read` / `cache_create`；OpenAI-compatible 的 `prompt_tokens_details.cached_tokens` 会归一化到 `cache_read`，并从普通 `input` 中扣除以避免重复统计。WebUI Token 页把这些字段派生为 4 个主口径：输入缓存命中 = `cache_read`，输入缓存未命中 = `input + cache_create`，输出 = `output`，总 Token = 前三者合计；大数字按 K / W / M 自动缩写，完整值保留在悬停提示里。

压缩触发：`TokenTracker.should_compact(max_context, threshold=0.7)` —— 上一次调用的 input + cache_read + cache_create 估算超过窗口的 70% 时，下一轮 step 结束后压缩 `history[:-K]`（K 默认 10），保留最近 K 条。

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

主智能体（"大内总管"）服侍用户（"皇上"），可派遣"小太监"作为子代理处理独立差事——子代理拥有独立 `history` 与受限工具白名单，办完只把摘要返回主上下文。WebUI 会通过 `subagent_*` 事件实时显示子代理的进度（delta、tool_call、result、done / error）。

Agent Team 是更长期的协作层：Lead 使用 `spawn_teammate` 创建队友，队友状态写入 `.team/config.json`，通信走 `.team/inbox/*.jsonl`，完整上下文保存在 `.team/threads/*.json`。v1 不启动后台常驻线程；`send_message(..., wake=true)` / `broadcast(..., wake=true)` 会按消息唤醒队友执行一次。队友 token 用量记录为 `usage_type=team:<name>`，主上下文只接收摘要，避免长期协作污染 Lead 的 history。

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
| `/compact` | 立即压缩未归档对话（WebUI） |
| `/clear` | 清空当前网页屏幕（不删 memory） |
| `/reload` | 重新拉取 bootstrap |
| `/exit` | 退出 CLI |

---

## 🌐 环境变量

模型 API Key 默认从 `model_config.json` 读取。`.env` 仍可保留给你自己的工具或脚本使用，但主 Agent 不再依赖任何 `*_API_KEY` 环境变量。

---

## 🤝 协作约定

- **不要提交**：`memory/`、`.team/`、`templates/USER.local.md`、`model_config.json`、`.env`、`webui/dist/`、`webui/node_modules/`、任何 `*.local.md`。
- **可以提交**：`templates/init/*.md` 模板（保持通用）、`templates/SOUL.md` / `TOOL.md`、`assets/`（像素素材）、`skills/`、`webui/src/`、`webui/package*.json`。
- 新增 provider：在 `agent/providers/registry.py` 加 `ProviderSpec`，需要新 backend 时在 `factory.py` 加分支并新增 provider 实现。
- 新增工具：在 `agent/tools/` 实现 `Tool` 子类，到 `agent/loop.py` 注册。
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
