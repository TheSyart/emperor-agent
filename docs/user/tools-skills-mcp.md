# Tools、Skills 与 MCP

> 文档状态：Active<br>
> 面向读者：希望扩展 Agent 能力的用户<br>
> 最后核验：2026-09-22<br>
> 事实源：`packages/core/src/harness/host/host.ts`（`compose()`）、`packages/core/src/harness/tools/builtin/`（含 `skill-manage.ts`、`mcp-config.ts`）、`packages/core/src/skills/`、`packages/core/src/plugins/`、`packages/core/src/mcp/`、`desktop/src/renderer/src/components/settings/`（插件 / Skills / MCP / 工具分区）

Tool 是 Agent 可调用的接口；Skill 是按需加载的工作说明和资源包；Plugin 是带来源、版本和启用状态的 Skill 分发单元；MCP 把外部 server 暴露的工具接入 Agent。设置弹窗中的“插件”“Skills”“MCP”和“工具”四个分区分别管理它们。

## Tools

| 类别       | 工具                                                                                                 |
| ---------- | ---------------------------------------------------------------------------------------------------- |
| 文件       | `read`、`write`、`edit`                                                                              |
| 搜索       | `glob`、`grep`                                                                                       |
| 命令       | `bash`；后台命令用 `job_output`、`job_list`、`job_kill` 管理                                         |
| 规划与交互 | `todo_write`、`ask_user_question`、`exit_plan_mode`                                                  |
| 子代理     | `subagent`、`subagent_fork`、`send_message`、`interrupt_agent`、`list_agents`；子代理内另有 `report` |
| 编排       | `workflow`、`ralph`                                                                                  |
| 上下文     | `skill`、`memory_edit`                                                                               |
| 扩展管理   | `skill_manage`、`mcp_config`                                                                         |
| 目标与定时 | `get_goal`、`create_goal`、`update_goal`、`scheduler`                                                |
| MCP        | `mcp_<server>_<tool>`，每个已连接 server 的工具各一个                                                |

打开“设置 → 工具”查看当前实际注册的工具：内置工具在前，MCP 工具按 server 分组，可以按名称、描述和 server 搜索，展开后查看参数和 JSON schema。

要点：

- **文件**：`write` 与 `edit` 受当前权限预设的写入范围约束，超出范围时可以为单次调用请求批准。`read` 不受写入沙箱限制。
- **搜索**：`grep` 优先使用受管执行环境中的 ripgrep，找不到时使用内置的纯 JS 实现；`glob` 与 `grep` 的超大结果会把完整结果保存到本地。
- **命令**：`bash` 在 macOS / Linux 的系统沙箱中执行，工作目录固定为当前 workspace；有默认超时，`run_in_background: true` 时立即返回 job id，由 `job_*` 工具读取输出或停止。没有沙箱后端的平台只有 `danger-full-access` 才能运行 `bash`。
- **子代理**：`subagent` 在独立上下文中完成一个自足的子任务；`subagent_fork` 的子代理继承当前对话已完成的部分。两者默认在后台运行，完成时通知主 Agent；子代理最多嵌套 3 层，不能请求提权。
- **编排**：只在明确要求工作流或 Ralph 循环时使用。`workflow` 运行模型编写的 JavaScript 编排脚本，脚本里的 `agent()` 会启动真实子代理（在对话的工具卡片下流式显示，并出现在 Task 面板）；`ralph` 以同一目标反复启动全新子代理，每轮只传递一份有界的结构化交接，默认最多 64 轮。两者都在前台运行，调用返回时整个运行已结束；可以在 Task 面板查看记录或停止。
- **记忆**：`memory_edit` 修改用户档案、全局长期记忆或当前项目的私有记忆，不需要审批。
- **扩展管理**：`skill_manage` 管理 Skills，`mcp_config` 管理 MCP server，见下文。查看、校验和重新连接不需要审批；修改 Skill 文件或 MCP 配置的动作跟随当前权限预设，除 `danger-full-access` 外每次写入都会先请求你批准。
- **Scheduler**：`scheduler` 让 Agent 创建和管理定时任务，不需要审批。
- **大结果**：超过 50,000 字节的纯文本结果会完整保存到 `stateRoot/spill/`，模型只看到首尾预览和文件路径。
- **网页**：默认没有网页抓取工具。`web_search` 只在宿主配置了搜索后端时才会出现，桌面版当前没有配置。需要联网时可以使用 MCP server、会联网的 Skill，或在权限允许时用 `bash` 调用命令行工具。

工具卡显示的是执行投影；真实状态以 session log 为准。

## Skills

Skill 是一个包含 `SKILL.md` 的文件夹，可以附带 `scripts/`、`references/`、`assets/` 等文件。`SKILL.md` 以 YAML frontmatter 开头，至少包含 `name` 和 `description`：

```markdown
---
name: my-skill
description: 一句话说明什么时候使用这个 Skill。
---

# My Skill

具体的工作说明……
```

Skills 文件夹中直接放置的 `<name>.md` 文件，只要 frontmatter 同时声明了 `name` 和 `description`，也会作为 Skill 加载。

### 来源与优先级

| 优先级 | 来源   | 位置                                                         | 能否修改 |
| ------ | ------ | ------------------------------------------------------------ | -------- |
| 1      | 项目   | `<project>/.emperor/skills`，只在绑定该项目的 Build 会话可见 | 可以     |
| 2      | 个人   | `~/.emperor/skills`（`stateRoot/skills`）                    | 可以     |
| 3      | Plugin | 已启用并激活的 Plugin 内的 Skills                            | 只读     |
| 4      | 内置   | 应用内置的 `runtimeRoot/skills`                              | 只读     |

同名时高优先级覆盖低优先级。每个 Build 项目只看到自己的项目 Skill；Chat 会话和其他项目看不到它。当前生效来源可在“设置 → 诊断”的“配置”分组中核对 `skills.<name>` 行。

### 名称与校验规则

- Skill 的名称取自 frontmatter 的 `name`：以小写字母或数字开头，只能包含小写字母、数字、`.`、`_` 和 `-`，最多 64 个字符。文件夹名与它不同时只给出警告，Skill 仍以 frontmatter 名称为准。
- 校验只检查 `SKILL.md` 和其中按相对路径引用的文件；文件夹里的其他文件只做链接安全扫描。
- `node_modules`、`.venv`、`venv`、`.git` 和 `__pycache__` 不遍历、不计数，导入时也不复制。
- 指向 Skill 文件夹内部的符号链接可以使用；绝对路径链接和指向文件夹外部的链接会让校验失败。Skill 文件夹本身不能是符号链接。
- frontmatter 按宽松模式解析：重复的键以最后一个值为准，不严格合法的 YAML 会尽量解析，同时给出警告。

未通过校验的 Skill 不会加载。它们出现在“设置 → Skills”顶部的「不合格的 Skill」列表中，并附上具体原因；个人和项目中的不合格 Skill 可以直接打开所在文件夹或删除。

### 在设置中管理 Skills

“设置 → Skills”的列表支持搜索，并可按“全部 / 个人 / 项目 / 插件 / 内置”筛选来源。右上角的「新增」提供四种方式：

1. **粘贴 SKILL.md**：粘贴内容后自动从 frontmatter 读取名称并实时校验。
2. **选择本地文件夹**：导入一个包含 `SKILL.md` 的文件夹。
3. **导入 zip 或 GitHub 链接**：选择本地 zip 文件，或填写 `https://` 链接，可以是 GitHub 仓库链接、`…/tree/<分支>/<目录>` 形式的目录链接，也可以是直接的 zip 下载地址。
4. **打开 Skills 文件夹**：在文件管理器中打开个人 Skills 文件夹，或在 Build 会话中打开项目 Skills 文件夹，直接放入或修改文件。项目 Skills 文件夹在保存第一个项目 Skill 时才会创建；还没有时，打开会提示，不会为此在你的项目里建目录。

导入时选择保存位置：“个人”，或只在 Build 会话中可选的“当前项目”。一个来源里有多个 Skill 文件夹时会逐个导入并分别报告结果；已有同名 Skill 时会提示，确认「覆盖」后才替换。

点开一个 Skill 可以查看来源、文件位置和 `SKILL.md`：

- 个人和项目 Skill 可以直接编辑（输入时实时校验，⌘S 保存）、还原或删除；删除会从磁盘移除该 Skill，无法撤销。
- 内置和 Plugin Skill 只读，可以「复制为个人 Skill」得到一份可编辑的副本，已有同名个人 Skill 时会先询问是否覆盖。个人副本的优先级高于同名的内置或 Plugin 版本。

你在文件管理器中修改个人、项目或 Plugin 的 Skills 文件夹后，设置中的列表会自动刷新；Agent 从下一步开始看到更新后的 Skill 目录。

### 让 Agent 管理 Skills

Agent 使用 `skill_manage` 工具管理 Skills，不应使用文件或 Shell 工具直接修改 Skills 文件夹：

- `list`（包括不合格的 Skill 及原因）和 `validate` 只读，不需要审批；
- `create`、`update`、`delete` 和 `import`（本地文件夹、本地 zip、粘贴的 `SKILL.md` 或 `https://` 链接）写入个人 Skills 文件夹，或在 Build 会话中写入当前项目的 Skills 文件夹；
- 除 `danger-full-access` 外，每次写入都会先弹出审批，拒绝即取消该操作；内置和 Plugin Skill 不能通过它修改。

### 调用 Skill

- 在 Composer 的能力选择器中选择；
- 输入 `/<skill-name> 任务内容`；
- 让 Agent 在需要时调用 `skill` 工具。

所有 active Skill 的名称和描述会作为目录提供给 Agent；frontmatter 设置 `disable-model-invocation: true` 的 Skill 不进入该目录，只能由你手动调用。Skill 的斜杠命令行为可以在 frontmatter 的 `metadata.emperor.command` 中定制（名称、别名、参数提示、参数、调用来源、敏感参数），见 [Slash command 平台](../architecture/slash-command-platform.md#skill-命令)。

## Plugins

需要来源、版本、更新和卸载语义的扩展使用 Plugin。“设置 → 插件”右上角的「安装」菜单提供三种来源：

- **选择本地文件夹**：从解压后的 Plugin 目录安装；
- **选择 zip 文件**：从本地 Plugin 压缩包安装；
- **从 URL 安装**：填写 `https://` 地址。

每次安装都先检查来源，再在确认窗口中展示来源、版本、digest、签名状态、大小和包含的能力，并选择安装范围：用户（所有项目可用）、项目（写入当前项目的 `.emperor/settings.json`）或本地项目（写入当前项目的 `.emperor/settings.local.json`，不随仓库提交）。确认后才会安装。

本地文件夹和 zip 记为本地来源，启用后即可激活。从 URL 安装的 Plugin 必须通过签名验证才会激活；当前还无法验证 URL 来源的签名，这类 Plugin 安装后停在“签名未验证”，不会激活。信任该来源时，请下载后改用本地安装。

已安装的 Plugin 可以启用、停用或卸载，只有已激活 Plugin 内的 Skill 会进入 Skill 目录。用户范围的启用意图保存在 `stateRoot/settings.json`，物化内容保存在 `stateRoot/plugins/`；禁用或卸载不会同步删除不可变缓存。Plugin 安装只能由你在设置中发起，没有对应的模型工具。

旧的 Skill 安装接口和环境配方安装接口已下线；需要外部 CLI 依赖时，在权限允许的情况下用普通命令安装，并单独验证结果。

## MCP

Emperor 只读取自己的 MCP 配置文件 `stateRoot/mcp_config.json`（默认 `~/.emperor/mcp_config.json`），不读取 Claude Desktop、Cursor、VS Code 等其他客户端的配置，也不通过 mcporter 管理 server。

### 添加 server

在“设置 → MCP”点击右上角的「添加」，有两种方式：

- **粘贴 JSON**：直接粘贴其他客户端的 MCP 配置。可以识别 Claude Desktop、Claude Code、Cursor 使用的 `{"mcpServers": {...}}`，VS Code 或 Emperor 使用的 `{"servers": {...}}`，带 `name` 字段的单个 server 对象，以及不带外层容器的“名称 → 配置”映射。带注释、尾逗号或缺少外层花括号的片段会自动修复并提示。
- **表单**：填写名称，选择 HTTP、SSE 或 stdio，再填写服务地址和可选的请求头，或者启动命令、参数和可选的环境变量。

两种方式都会先预览将要新增、覆盖或跳过的 server，并列出警告；同名 server 默认跳过，勾选「覆盖」后才替换。点击「导入」后立即写入配置并连接。例如：

```json
{
  "mcpServers": {
    "example": { "type": "http", "url": "https://example.com/mcp" }
  }
}
```

### 传输方式与字段

| transport | 用途                                                            | 主要字段                 |
| --------- | --------------------------------------------------------------- | ------------------------ |
| `stdio`   | 在本机启动一个进程，通过标准输入输出通信                        | `command`、`args`、`env` |
| `sse`     | 旧版 SSE 端点，URL 通常以 `/sse` 结尾                           | `url`、`headers`         |
| `http`    | Streamable HTTP；首次连接失败时自动回退到 SSE，认证失败时不回退 | `url`、`headers`         |

- 没有写 `type` 时，有 `command` 视为 `stdio`，有 `url` 视为 `http`；`streamable-http` 等写法会规范为 `http`。远程 server 的 `url` 必须是 `http(s)` 地址。
- server 名称只能包含字母、数字、`-` 和 `_`，最多 64 个字符；导入时不合规的名称会被规范化并给出提示。
- `enabled`：按 server 启停，导入的 `disabled: true` 会转换为停用。
- `${ENV_NAME}`：从执行环境展开环境变量，适合放置 API Key。
- `tool_overrides` 和 `defaults`：补充只读、独占等工具属性，以及 `call_timeout_ms` 请求超时。

### 管理已有 server

每个 server 显示为一张卡片，包含连接状态、传输方式、工具数和启用开关。展开后可以查看地址或启动命令、请求头和环境变量的键名、最近的错误（含错误码）以及已发现的工具，也可以删除该 server；删除会从配置中移除它并断开连接。

需要批量调整或设置 `tool_overrides` 时，展开页面底部“高级”中的“原始配置”，直接编辑 `mcp_config.json`。

每次写入后，Core 按 server 做 diff：未变化且健康的连接保留，变化的连接重建。传输失败后按 1、4、16 秒最多重试三次；认证失败不会无限重试，修正配置并再次保存才会重新连接。取消当前 turn 会取消仍在等待的 MCP 请求。

### 让 Agent 管理 MCP

Agent 使用 `mcp_config` 工具管理同一份 `mcp_config.json`：

- `list` 查看 server、transport、状态和工具数，不需要审批；
- `add` 接受与设置页相同的 JSON，同名 server 默认跳过，明确要求覆盖时才替换；
- `remove`、`enable`、`disable` 按名称修改，`reload` 重新连接全部 server；
- 除 `danger-full-access` 外，`add`、`remove`、`enable`、`disable` 每次写入前都会请求你批准。写入成功后 MCP 自动重载，新的 `mcp_<server>_<tool>` 工具从下一步起可用。

Agent 被要求只通过 `mcp_config` 添加 server，不使用 mcporter，也不修改其他客户端的配置文件。

### MCP 工具

每个已连接 server 的工具注册为 `mcp_<server>_<tool>`，参数按 server 声明转发，由 server 自行校验。MCP 工具不经过文件沙箱，也不需要审批；声明为只读且非独占的工具可以与其他并发安全的调用同时执行。

## 安全边界

- MCP server 的名称、命令和 URL 来自你的配置。Agent 只能通过 `mcp_config` 修改配置，在 `danger-full-access` 以外的预设中每次修改都需要你批准。
- `stdio` server 会启动本地进程，应像审查命令一样审查它的来源和参数。
- MCP 工具的副作用不受 Emperor 权限预设约束，只配置你信任的 server。
- 远程 MCP、Skill 脚本和 Plugin 内容都按不可信输入处理。导入 Skill 或安装 Plugin 前确认来源可信。
- 不要把 API Key 直接写进可提交的项目文件，优先使用 `${ENV_NAME}`。MCP 分区读取配置时保留 `${ENV_NAME}`，把 args、env、headers、URL 中其余字面字符串显示为 `[REDACTED]`；保存原始配置时，未改动的掩码只从同一 server 同一字段回填，没有旧值的掩码会被拒绝。

排查加载问题时，先看“设置 → MCP”中该 server 卡片的状态和最近错误，再检查配置 JSON、执行环境和“设置 → 诊断”。
