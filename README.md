# Emperor Agent（皇帝智能体）

一个面向个人工作流的 Python 智能体。它以“皇上 / 大内总管”的交互隐喻运行：用户下旨，主智能体统筹上下文、工具、记忆与子代理，把任务拆解、执行、校验后回禀。

项目重点不是教学材料，而是一个可持续演进的个人 Agent 工程。

---

## 快速开始

```bash
python -m venv .venv
source .venv/bin/activate                 # Windows: .venv\Scripts\activate
pip install -r requirements.txt

cp model_config.example.json model_config.json
# 在 model_config.json 中选择 provider/model，并填入对应 apiKey

python agent.py
```

启动网页工作台：

```bash
python webui.py
# 打开 http://127.0.0.1:8765
```

---

## 核心能力

- 多轮对话：保留当前会话工作记忆。
- 三层记忆：工作记忆、情景记忆、长期记忆协同运转。
- 自动压缩：上下文过长时自动归档旧对话，保留关键事实。
- 多厂家模型：支持 DeepSeek、Anthropic、OpenAI-compatible、Azure OpenAI、Bedrock、OpenAI Codex、GitHub Copilot 等 provider 配置。
- 流式 WebUI：网页聊天通过 WebSocket 接收模型文本 delta 和工具执行事件。
- Token 统计：按日期、provider/model、使用种类（主 Agent / 子代理 / 记忆压缩）汇总调用次数与 token。
- 工具调用：支持命令执行、网页抓取、文件读写、搜索和技能加载。
- 任务规划：通过 todolist 维护当前差事的状态。
- 子代理派遣：把独立任务交给不同身份的子代理处理，再汇总给主智能体。
- 技能系统：按需加载 `skills/` 下的专用能力包。

---

## 项目结构

```text
agent.py                    启动入口
agent/
├── loop.py                 主循环与组件装配
├── runner.py               单轮模型调用、tool_use 循环、安全工具并发
├── memory.py               三层记忆存储
├── compactor.py            历史压缩与长期记忆更新
├── model_config.py         多 provider 模型配置读取与装配
├── context.py              system prompt 组装
├── skills.py               技能加载器
├── telemetry.py            token 用量记录与压缩触发判断
├── providers/              多厂家 provider 抽象与实现
├── subagents/              子代理 spec 与 registry
└── tools/                  内置工具

webui/                      本地网页工作台（单一聊天主线 / model / skills / tools / 配置 / 记忆）
templates/
├── SOUL.md                 智能体灵魂档案
├── TOOL.md                 工具使用配置
├── init/
│   ├── MEMORY.md           仓库初始化版长期记忆模板
│   └── USER.md             仓库初始化版用户偏好模板
├── USER.local.md           本地个人用户偏好档案，已被 gitignore，首次启动自动生成
├── agent/                  主智能体 prompt 模板
└── subagents/              子代理身份模板

skills/                     可插拔技能包
memory/                     运行期记忆产物，已被 gitignore（含 MEMORY.local.md / history / tokens / episodes）
model_config.json           本地私密模型配置，已被 gitignore
```

---

## 模型配置

模型配置使用本地 `model_config.json`，允许明文保存 API key。该文件已加入 `.gitignore`，请不要提交到仓库。

默认配置：

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
  }
}
```

WebUI 的 `Model` 面板可以编辑 provider、model、apiBase、apiKey、temperature、maxTokens、reasoningEffort 和上下文窗口。主 Agent、子代理和记忆压缩共用这份配置。

Token 用量在独立的 `Tokens` 面板查看，包含总量、按 provider/model、按使用种类和按日期的汇总。

---

## 记忆系统

| 层 | 载体 | 写入时机 | 读取方式 |
|----|------|----------|----------|
| 工作记忆 | `history` 列表 | 每轮对话追加 | 全量传给模型 |
| 情景记忆 | `memory/YYYY-MM-DD.md` | 压缩触发时生成 | 按需检索 |
| 长期记忆模板 | `templates/init/MEMORY.md` | 仓库初始化格式 | 首次启动复制到本地长期记忆 |
| 长期记忆 | `memory/MEMORY.local.md` | 压缩或启动归档时更新 | 每轮注入 system prompt |
| 用户档案模板 | `templates/init/USER.md` | 仓库初始化格式 | 首次启动复制到本地用户档案 |
| 用户档案 | `templates/USER.local.md` | 压缩或 WebUI Config 编辑时更新 | 优先注入 system prompt |

当上一次调用的 input tokens 超过阈值时，系统会把较旧对话压缩成情景记忆，并更新长期记忆，只保留最近对话作为当前工作上下文。

`memory/`、`templates/USER.local.md`、`model_config.json` 都是本地私密运行期文件，默认不提交。仓库中的 `templates/init/MEMORY.md` 和 `templates/init/USER.md` 应保持通用初始化格式。

---

## 内置工具

| 工具 | 作用 |
|------|------|
| `run_command` | 执行 shell 命令 |
| `web_fetch` | 抓取 URL 内容 |
| `read_file` / `write_file` / `edit_file` | 工作区文件读写 |
| `glob` / `grep` | 工作区搜索 |
| `load_skill` | 按需加载技能 |
| `update_todos` | 维护当前任务列表 |
| `dispatch_subagent` | 派遣子代理独立办差 |

---

## 子代理

子代理拥有独立上下文，可以读文件、抓网页、执行允许的工具，最终只把结果摘要返回给主智能体。这样可以减少主上下文污染，也更适合并行处理互不依赖的任务。

当前内置身份：

- `xiaohuangmen`：轻量只读，适合快速确认和短命令。
- `sili_suitang`：只读文书，适合阅读代码与整理文档。
- `dongchang_tanshi`：只读查访，适合网页抓取和资料探索。
- `shangbao_dianbu`：只读核验，适合清点文件、校对清单、检查遗漏。
- `neiguan_yingzao`：可读写、可执行命令，适合修改文件、搭建工程、跑验收。

`researcher` 和 `general` 作为兼容别名保留，分别映射到 `dongchang_tanshi` 和 `neiguan_yingzao`。

---

## 技能系统

`skills/{name}/SKILL.md` 使用 YAML frontmatter 描述触发条件，用 Markdown 编写能力说明。主智能体会在需要时通过 `load_skill` 加载对应技能，避免一开始塞满上下文。

当前内置技能：

- `clawhub`：技能库搜寻与安装
- `ddg-web-search`：DuckDuckGo 搜索
- `github`：GitHub CLI 交互
- `skill-creator`：创建或更新技能
- `summarize`：URL、播客、文件总结
- `weather`：天气查询

---

## 环境变量

模型 API Key 默认从 `model_config.json` 读取。`.env` 仍可保留给你自己的工具或脚本使用，但主 Agent 不再依赖 `ANTHROPIC_API_KEY`。
