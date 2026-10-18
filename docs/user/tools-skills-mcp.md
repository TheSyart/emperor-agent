# Tools、Skills 与 MCP

> 文档状态：Active<br>
> 面向读者：希望扩展 Agent 能力的用户<br>
> 最后核验：2026-09-30<br>
> 事实源：`packages/core/src/harness/host/host.ts`（`compose()`）、`packages/core/src/harness/tools/builtin/`（含 `skill-manage.ts`、`mcp-config.ts`）、`packages/core/src/harness/workflow/`、`packages/core/src/skills/`、`packages/core/src/plugins/`、`packages/core/src/mcp/`、`desktop/src/renderer/src/components/pages/capabilities/`、`desktop/src/renderer/src/components/pages/explore/`、`desktop/src/renderer/src/components/settings/`（插件 / Skills / MCP / 工具分区组件）

Tool 是 Agent 可调用的接口；Skill 是按需加载的工作说明和资源包；Plugin 是带来源、版本和启用状态的 Skill 分发单元；MCP 把外部 server 暴露的工具接入 Agent。

- 侧栏的「能力」打开能力页（`/capabilities`），用“插件 / Skills / MCP / 工具”四个标签分别管理 Plugin、Skill、MCP server，并查看注册给 Agent 的工具；
- 侧栏的「探索」列出应用内置的一小组精选 Skills 和 MCP server，见[探索](#探索)；
- 能力页的“工具”标签（`/capabilities/tools`）按用途分类查看 Emperor 内建的工具。

## Tools

| 分类             | 工具                                                                                                                             |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 基础工具         | 文件 `read`、`write`、`edit`；搜索 `glob`、`grep`；命令 `bash`，后台命令用 `job_output`、`job_list`、`job_kill` 管理             |
| 网络             | `web_search`                                                                                                                     |
| 任务与规划       | `todo_write`、`ask_user_question`、`exit_plan_mode`；目标 `get_goal`、`create_goal`、`update_goal`；定时 `scheduler`             |
| 子代理与工作流   | `subagent`、`subagent_fork`、`send_message`、`interrupt_agent`、`list_agents`（子代理内另有 `report`）；编排 `workflow`、`ralph` |
| 技能、记忆与配置 | `skill`、`skill_manage`、`memory_edit`、`mcp_config`                                                                             |
| MCP              | `mcp_<server>_<tool>`，每个已连接 server 的工具各一个                                                                            |

能力页的“工具”标签只列 Emperor 内建的工具，按上表的五类分组，每组标题带数量；每行是工具名和一句说明，展开后查看完整说明、参数和 JSON schema，可以按名称和说明搜索。MCP server 的工具在“MCP”标签里按 server 列出，插件带来的工具（包括电脑操作的工具）在插件详情里；页首有这两处的链接。

要点：

- **文件**：`write` 与 `edit` 受当前权限预设的写入范围约束，超出范围时可以为单次调用请求批准。`read` 不受写入沙箱限制。
- **搜索**：`grep` 优先使用受管执行环境中的 ripgrep，找不到时使用内置的纯 JS 实现；`glob` 与 `grep` 的超大结果会把完整结果保存到本地。
- **命令**：`bash` 在 macOS / Linux 的系统沙箱中执行，工作目录固定为当前 workspace；有默认超时，`run_in_background: true` 时立即返回 job id，由 `job_*` 工具读取输出或停止。工具说明要求模型先写一句命令用途（`description`）再写命令，界面因此能在命令生成时就显示它要做什么；删除或移动文件前，模型会被要求先核对解析后的绝对路径，变量写成 `${VAR:?}`，避免空变量把路径变成上级目录。没有沙箱后端的平台只有 `danger-full-access` 才能运行 `bash`。
- **子代理**：`subagent` 在独立上下文中完成一个自足的子任务；`subagent_fork` 的子代理继承当前对话已完成的部分。两者默认在后台运行，完成时通知主 Agent；子代理最多嵌套 3 层，不能请求提权。
- **编排**：只在明确要求工作流或 Ralph 循环时使用。`workflow` 运行模型编写的 JavaScript 编排脚本，脚本里的 `agent()` 会启动真实子代理（在对话的工具卡片下流式显示）；`ralph` 以同一目标反复启动全新子代理，每轮只传递一份有界的结构化交接，默认最多 64 轮。两者都在前台运行，调用返回时整个运行已结束；运行期间环境信息卡的「后台任务」行显示运行数量，展开后可以查看运行记录或单独停止它（会先确认）；停止当前 turn 也会同时取消运行。
- **记忆**：`memory_edit` 修改用户档案、全局长期记忆或当前项目的私有记忆，不需要审批。
- **扩展管理**：`skill_manage` 管理 Skills，`mcp_config` 管理 MCP server，见下文。查看、校验和重新连接不需要审批；修改 Skill 文件或 MCP 配置的动作跟随当前权限预设，除 `danger-full-access` 外每次写入都会先请求你批准。
- **Scheduler**：`scheduler` 让 Agent 创建和管理定时任务，不需要审批。
- **大结果**：超过 50,000 字节的纯文本结果会完整保存到 `stateRoot/spill/`，模型只看到首尾预览和文件路径。
- **网页**：默认没有网页抓取工具。`web_search` 只在宿主配置了搜索后端时才会出现，桌面版当前没有配置，所以“工具”标签里暂时没有“网络”一组。需要联网时可以使用 MCP server、会联网的 Skill，或在权限允许时用 `bash` 调用命令行工具。

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
| 4      | 内置   | 应用内置的 `runtimeRoot/skills`（目前是 `skill-creator`）    | 只读     |

同名时高优先级覆盖低优先级。每个 Build 项目只看到自己的项目 Skill；Chat 会话和其他项目看不到它。当前生效来源可在“设置 → 诊断”的“配置”分组中核对 `skills.<name>` 行。

### 名称与校验规则

- Skill 的名称取自 frontmatter 的 `name`：以小写字母或数字开头，只能包含小写字母、数字、`.`、`_` 和 `-`，最多 64 个字符。文件夹名与它不同时只给出警告，Skill 仍以 frontmatter 名称为准。
- 校验只检查 `SKILL.md` 和其中按相对路径引用的文件；文件夹里的其他文件只做链接安全扫描。
- `node_modules`、`.venv`、`venv`、`.git` 和 `__pycache__` 不遍历、不计数，导入时也不复制。
- 指向 Skill 文件夹内部的符号链接可以使用；绝对路径链接和指向文件夹外部的链接会让校验失败。Skill 文件夹本身不能是符号链接。
- frontmatter 按宽松模式解析：重复的键以最后一个值为准，不严格合法的 YAML 会尽量解析，同时给出警告。

未通过校验的 Skill 不会加载。它们出现在能力页“Skills”标签顶部的「不合格的 Skill」列表中，并附上具体原因；个人和项目中的不合格 Skill 可以直接打开所在文件夹或删除。

### 在能力页管理 Skills

能力页的“Skills”标签（`/capabilities/skills`）列表支持搜索，并可按“全部 / 个人 / 项目 / 插件 / 内置”筛选来源。右上角的「新增」提供四种方式：

1. **粘贴 SKILL.md**：粘贴内容后自动从 frontmatter 读取名称并实时校验。
2. **选择本地文件夹**：导入一个包含 `SKILL.md` 的文件夹。
3. **导入 zip 或 GitHub 链接**：选择本地 zip 文件，或填写 `https://` 链接，可以是 GitHub 仓库链接、`…/tree/<分支>/<目录>` 形式的目录链接，也可以是直接的 zip 下载地址。
4. **打开 Skills 文件夹**：在文件管理器中打开个人 Skills 文件夹，或在 Build 会话中打开项目 Skills 文件夹，直接放入或修改文件。项目 Skills 文件夹在保存第一个项目 Skill 时才会创建；还没有时，打开会提示，不会为此在你的项目里建目录。

导入时选择保存位置：“个人”，或只在 Build 会话中可选的“当前项目”。一个来源里有多个 Skill 文件夹时会逐个导入并分别报告结果；已有同名 Skill 时会提示，确认「覆盖」后才替换。

点开一个 Skill 可以查看来源、文件位置和 `SKILL.md`；页面地址带上 `?skill=<名称>`，旧的 `/skills/<名称>` 链接也会打开同一个 Skill：

- 个人和项目 Skill 可以直接编辑（输入时实时校验，⌘S 保存）、还原或删除；删除会从磁盘移除该 Skill，无法撤销。
- 内置和 Plugin Skill 只读，可以「复制为个人 Skill」得到一份可编辑的副本，已有同名个人 Skill 时会先询问是否覆盖。个人副本的优先级高于同名的内置或 Plugin 版本。

你在文件管理器中修改个人、项目或 Plugin 的 Skills 文件夹后，Skills 列表会自动刷新；Agent 从下一步开始看到更新后的 Skill 目录。

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

需要来源、版本、更新和卸载语义的扩展使用 Plugin。能力页“插件”标签右上角的「安装」菜单提供三种来源：

- **选择本地文件夹**：从解压后的 Plugin 目录安装；
- **选择 zip 文件**：从本地 Plugin 压缩包安装；
- **从 URL 安装**：填写 `https://` 地址。

Emperor 识别三种包格式，按以下顺序判断：

1. 根目录有 `plugin.json`（agent-plugins.org 的可移植格式，至少写 `$schema` 和 `name`）；
2. 只有 `.codex-plugin/plugin.json`（OpenAI Codex 格式）；
3. 只有 `.emperor-plugin/plugin.json`（Emperor 旧格式，原样读取）。

文件夹或压缩包里只能有一个插件包；子目录里的清单算作包内容。清单无法解析、名称不合规、路径越出包目录、含符号链接、超过大小上限、同名 Skill 或 MCP server 重复时，检查会失败并说明原因，不会留下任何内容。

每次安装都先检查来源，再在确认窗口中展示来源、版本、digest、签名状态、大小和包含的能力，并选择安装范围：用户（所有项目可用）、项目（写入当前项目的 `.emperor/settings.json`）或本地项目（写入当前项目的 `.emperor/settings.local.json`，不随仓库提交）。确认后才会安装。

本地文件夹和 zip 记为本地来源，启用后即可激活。从 URL 安装的 Plugin 必须通过签名验证才会激活；当前还无法验证 URL 来源的签名，这类 Plugin 安装后停在“签名未验证”，不会激活。信任该来源时，请下载后改用本地安装。

能力页的「插件」标签分「已安装」和「预装」两组列出插件，可以按名称、说明或开发者搜索。点开一个插件会显示它的详情：名称、说明、开发者、版本和启用开关；示例提示旁的「立即试用」会新建一个对话，把提示填进输入框，由你决定是否发送；下面按 Skill、MCP、应用连接、Hook、不支持的成员分组列出真实成员，每个成员都带状态和原因；接着是插件带来的「工具」，写法与能力页的“工具”标签相同，每个 MCP server 的工具列在这个 server 名下，server 没有运行时写明原因；最后是来源、格式、权限、安装时间等信息。没有任何成员的插件只展示元数据。「全部插件」回到列表，搜索词保留。

Emperor 自带两个 Plugin：GitHub 和 Computer Use，在插件列表里标为「随 Emperor 提供」。它们可以停用，不能卸载；GitHub 的开关记在 `stateRoot/plugins/managed.json`，升级 Emperor 不会改变。Computer Use 插件是 `computer-use` Skill 的唯一来源：电脑操作关闭时这个 Skill 不出现在列表里；详情按驱动列出内置浏览器、Chrome/Edge 连接和 macOS 桌面各自的实际状态（例如 Chrome 未配对、Helper 缺失），只在插件启用时读取；「工具」按驱动分为通用（6 个）、内置浏览器（19 个）、Chrome 和 Edge（4 个）、Mac 应用（17 个）四组共 46 个，电脑操作关着时也列出，并注明「打开电脑操作后可用」，后三组右侧的「设置」分别打开「设置 › 浏览器」「设置 › 电脑操作 › Chrome 和 Edge」和「设置 › 电脑操作」。从插件页关闭它与在设置里关闭相同，有待处理的确认卡片时也能立即关闭。GitHub 插件带一个只读查询的 GitHub Skill、Pull Request 页的 Issue 与 CI 标签（见[对话与 Build](chat-build.md#issue-与-cigithub-插件)），以及应用连接「GitHub（本机 gh）」：它的状态按 `gh` 实况显示，已登录为可用并写明账户，`gh` 未安装或未登录为需要连接；只装了 `gh` 不算已连接。停用它只撤下这些入口，不影响 `gh` 的登录。Computer Use 的开关就是「设置 › 电脑操作」的总开关，两处看到的始终一致；不支持电脑操作的电脑上它不能开启。你自己安装的同名 Plugin 会覆盖自带的那个。

已安装的 Plugin 可以启用、停用或卸载。已激活 Plugin 的成员这样接入：

- **Skill**：进入 Skill 目录。项目范围的 Plugin 只在该项目的会话里可见。
- **MCP server**：以「插件名-server 名」为名字连接，工具名为 `mcp_<这个名字>_<工具名>`，最长 64 个字符，超长时截短并加一段哈希。与你自己的 server 重名时只改插件这一侧；与已有工具重名的插件工具不注册，原因写在插件详情里。stdio server 在插件目录里运行，在沙箱中只能读自己的插件目录、写自己的数据目录（`stateRoot/plugins/data/<插件名>`），读不到 Emperor Home 里的其他内容。配置里除 `${PLUGIN_ROOT}`、`${PLUGIN_DATA}` 和少数系统变量（如 `HOME`、`PATH`）外的 `${变量}` 不会展开，这样的 server 显示为「需要连接」，不会启动。
- **Hook**：旧格式 Plugin 的 Hook 与你自己的 `hooks.json` 写法相同。可移植格式和 Codex 格式的 Hook 只有事件、匹配条件都能对应到 Emperor 时才运行：事件限 `SessionStart`、`UserPromptSubmit`、`PreToolUse`、`PostToolUse`、`Stop`、`SubagentStart`、`SubagentStop`；匹配条件只能是工具名的简单并列（例如 `Bash|Write`，会对应到 Emperor 的 `bash`、`edit`、`write`），一般正则、`WebFetch` 这类 Emperor 没有的工具、后台运行的 Hook 都不运行，并在详情里说明原因。Hook 命令可以用 `PLUGIN_ROOT`、`PLUGIN_DATA` 环境变量。
- **应用连接**：自带 GitHub 插件的「GitHub（本机 gh）」和 Computer Use 插件的三个驱动按上文显示真实状态；其他插件的应用连接暂不支持，详情里列出。

停用或卸载后，这个 Plugin 的 MCP server 立即断开，Hook 不再运行。Plugin 的 MCP server 和 Hook 不写入你的 `mcp_config.json` 或 `hooks.json`，也不在「能力 › MCP」里显示；项目范围的 Plugin 跟随当前会话所在的项目。

用户范围的启用意图保存在 `stateRoot/settings.json`，物化内容保存在 `stateRoot/plugins/`；禁用或卸载不会同步删除不可变缓存。Plugin 安装只能由你在能力页发起，没有对应的模型工具。

旧的 Skill 安装接口和环境配方安装接口已下线；需要外部 CLI 依赖时，在权限允许的情况下用普通命令安装，并单独验证结果。

## MCP

Emperor 只读取自己的 MCP 配置文件 `stateRoot/mcp_config.json`（默认 `~/.emperor/mcp_config.json`），不读取 Claude Desktop、Cursor、VS Code 等其他客户端的配置，也不通过 mcporter 管理 server。

### 添加 server

在能力页“MCP”标签（`/capabilities/mcp`）点击右上角的「添加」，有两种方式：

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
- `add` 接受与 MCP 标签相同的 JSON，同名 server 默认跳过，明确要求覆盖时才替换；
- `remove`、`enable`、`disable` 按名称修改，`reload` 重新连接全部 server；
- 除 `danger-full-access` 外，`add`、`remove`、`enable`、`disable` 每次写入前都会请求你批准。写入成功后 MCP 自动重载，新的 `mcp_<server>_<tool>` 工具从下一步起可用。

Agent 被要求只通过 `mcp_config` 添加 server，不使用 mcporter，也不修改其他客户端的配置文件。

### MCP 工具

每个已连接 server 的工具注册为 `mcp_<server>_<tool>`，参数按 server 声明转发，由 server 自行校验。MCP 工具不经过文件沙箱，也不需要审批；声明为只读且非独占的工具可以与其他并发安全的调用同时执行。

## 探索

侧栏的「探索」（`/explore`）以卡片列出一小组随应用发布的精选条目，可以搜索，并按“全部 / Skills / MCP / 插件”筛选：

- Skills：来自 [anthropics/skills](https://github.com/anthropics/skills) 的若干 Skill；
- MCP：[modelcontextprotocol/servers](https://github.com/modelcontextprotocol/servers) 中的几个本地 server，以及一个无需 API 密钥的远程 server。标签会注明需要 Node.js 或 uv 等本机依赖。

目录随应用版本更新，不从网络实时拉取；当前还没有精选 Plugin。已安装的 Skill 或 MCP server 显示「已安装」。

「安装」不会直接写入任何东西，而是打开与能力页相同的确认对话框：Skill 进入 URL 导入对话框并选择保存位置，MCP 进入添加对话框，先预览将要新增、覆盖或跳过的 server，确认「导入」后才写入。「主页」在系统浏览器中打开条目的来源页面，安装前可以先查看。

## 安全边界

- MCP server 的名称、命令和 URL 来自你的配置。Agent 只能通过 `mcp_config` 修改配置，在 `danger-full-access` 以外的预设中每次修改都需要你批准。
- `stdio` server 会启动本地进程，应像审查命令一样审查它的来源和参数。
- MCP 工具的副作用不受 Emperor 权限预设约束，只配置你信任的 server。
- 远程 MCP、Skill 脚本和 Plugin 内容都按不可信输入处理。导入 Skill 或安装 Plugin 前确认来源可信。
- 不要把 API Key 直接写进可提交的项目文件，优先使用 `${ENV_NAME}`。MCP 标签读取配置时保留 `${ENV_NAME}`，把 args、env、headers、URL 中其余字面字符串显示为 `[REDACTED]`；保存原始配置时，未改动的掩码只从同一 server 同一字段回填，没有旧值的掩码会被拒绝。

排查加载问题时，先看能力页“MCP”标签中该 server 卡片的状态和最近错误，再检查配置 JSON、执行环境和“设置 → 诊断”。
