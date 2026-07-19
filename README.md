<p align="center">
  <img src="assets/generated/emperoragent-wordmark.png" alt="Emperor Agent 产品字标" width="560" />
</p>

<h1 align="center">Emperor Agent · 皇帝智能体</h1>

<p align="center">
  <b>本地运行的个人 Agent 工作台</b><br/>
  日常对话 · 项目工作 · 先规划再执行 · 持续完成长任务
</p>

Emperor Agent 是一款面向个人长期使用的桌面 Agent。你可以用它处理日常问答，也可以绑定本地项目，让 Agent 在明确的权限和验收条件下读取文件、运行工具并持续推进任务。

桌面端直接托管 TypeScript Core，界面通过 Electron IPC 与核心能力通信。已经退役的 Python CLI、HTTP server 和 WebSocket server 不再参与运行。

<p align="center">
  <img src="assets/generated/readme-product-hero.png" alt="Emperor Agent 桌面工作区" width="920" />
</p>

## 导航

- [认识 Emperor Agent](#overview)
- [下载与首次使用](#download)
- [Chat、Build、Plan 与 Goal](#workflows)
- [功能与成熟度](#capabilities)
- [数据、权限与安全](#data-security)
- [当前边界](#boundaries)
- [从源码运行](#source)
- [文档导航](#docs)

<a id="overview"></a>

## 认识 Emperor Agent

Emperor Agent 里有几组名称看起来相似，实际处在不同层级：

| 层级               | 含义                                                 |
| ------------------ | ---------------------------------------------------- |
| Chat / Build       | 会话和工作区类型：一个用于普通对话，一个绑定本地项目 |
| Ask / Edits / Auto | 三种执行权限：决定哪些操作需要先询问                 |
| Plan               | 独立的规划生命周期：只读探索、提问并提交方案         |
| Goal               | 跨多个模型回合持续推进的长任务生命周期               |
| Scheduler          | 按时间或条件触发任务的机制                           |

应用会把会话、记忆、配置、附件和运行轨迹保存在本机。Chat（普通对话）适合问答和轻量任务；Build（项目工作）会绑定本地目录，并读取项目的 `AGENTS.md` 和工作区上下文。

Plan（规划模式）用于先探索、再提交方案。Goal（目标模式）则负责持续完成一个结果：它会锁定范围和验收条件，执行过程中可以重新规划，但只有证据和 Completion Gate 都通过后才能标记为完成。

Plan 和 Goal 是互斥的顶层模式，Composer 同一时间只显示一个标识。Goal 内部可以使用 Plan 引擎规划和审批，但这只是 Goal 的“规划中”阶段，不会再显示一个独立 Plan。

“本地优先”不等于完全离线。模型请求会发送给你配置的 Provider；调用网页、远程 MCP 或其他联网工具时，对应内容也会离开本机。Emperor Agent 负责把本地运行数据和项目数据边界分开，但无法替代外部服务自身的隐私政策。

<a id="download"></a>

## 下载与首次使用

安装包适合直接使用，不要求目标机预装 Node.js、Python、Git 或 ripgrep。

1. 打开 [GitHub Releases](https://github.com/TheSyart/emperor-agent/releases)。
2. 根据设备选择 macOS、Windows 或 Linux 安装包。
3. 当前公开安装包是未签名 Preview，不是 Stable。运行前请阅读[未签名预览版安全说明](docs/release/unsigned-preview-notice.md)。
4. 第一次启动后进入设置页，添加模型 Provider、API Key 和模型 ID。
5. 创建 Chat 开始普通对话，或者选择本地目录创建 Build 会话。

启动过程不会强制要求你立刻配置模型。没有可用模型时，对话和模型测试会给出配置入口；已经熟悉配置文件的用户也可以参考 [`config/examples/model_config.example.json`](config/examples/model_config.example.json)。

### 模型配置

你可以在设置页保存多个标准接口模型。设置页管理 Provider、协议、凭证、能力和可选的用户单价；当前对话使用哪个模型，统一在聊天输入框中选择。收起的模型按钮只显示 Provider Logo 和模型名，展开后可以切换模型、调整该模型支持的思考强度。切换结果从下一轮请求开始生效。旧版双角色字段只用于兼容迁移，不再是当前界面语义。

模型失败时默认不会暗中切换。设置页可以显式选择一个备用模型、允许触发的错误类型，以及可选的“每 Agent 轮”成本上限。成本来自用户填写的每百万 token 单价；未知或失败重试成本不会被当作零，也不应把这个本地上限理解为 Provider 账单保证。

模型配置、连接测试、视觉能力和数据边界见[模型、记忆与附件](docs/user/models-memory-attachments.md)。

<a id="workflows"></a>

## Chat、Build、Plan 与 Goal

### Chat：普通对话

Chat 适合日常问答、资料整理和一次性的工具任务。它会使用用户档案、全局长期记忆和当前会话历史，但不会自动绑定某个项目目录。

一次请求通常在当前 Agent turn 内结束。最终回复表示这一轮已经停止生成，不代表系统做过 Goal 式验收。如果结果需要多轮修复、独立复核或可追溯的完成条件，应使用 Goal。

### Build：项目工作

Build 会话绑定一个本地文件夹，适合代码、文档和其他项目任务。Agent 可以读取项目 `AGENTS.md`、当前 workspace 和该项目的私有记忆。

项目私有记忆保存在全局 `stateRoot`，不会自动改写项目中的 `AGENTS.md`。文件修改和命令执行仍受当前权限模式、workspace policy 和工具 schema 约束。

### Plan：先规划再执行

Plan 用于在动手前看清问题、确认方案。进入 Plan 后，Agent 只能进行只读探索、询问用户和提交计划；它不会成为第四种执行权限。Plan 期间仍可在输入框选择询问、编辑或自动，批准方案后使用最新选择的权限执行具体步骤。

在输入框的 `/` 菜单选择 Plan 会立即进入规划模式，权限选择器右侧同时出现 Plan 标识。也可以手动输入：

```text
/plan
/plan on
/plan off
/plan status
```

`/plan` 与 `/plan on` 的效果相同。Agent 空闲时，把鼠标移到 Plan 标识上可以点击右上角关闭按钮；系统会退出 Plan，并恢复进入 Plan 前保存的最新执行权限。Agent 正在运行时，这个快捷按钮不可用。

Plan 会记录步骤、依赖和验证要求，但它不是长期目标，也不会单独决定 Goal 是否完成。权限模式还可以通过下面的命令查看或切换：

```text
/mode ask
/mode edits
/mode auto
/mode status
```

### Goal：持续完成结果

Goal 用于需要跨多个回合推进、修复和验收的任务。可以直接输入完整命令：

```text
/goal 完成项目的 Goal 模式升级并通过全部验收
```

也可以从 `/` 菜单选择 Goal，或单独输入 `/goal`。此时权限选择器右侧会先出现 Goal 标识，下一条纯文字会作为 Outcome 创建并启动 Goal。若独立 Plan 已开启，系统会先退出 Plan，再进入 Goal。这个待输入状态只属于当前会话，不会写入 Goal 账本；切换会话或重启应用后会清除。Goal Outcome 暂不接受附件、Skill 或 MCP 引用，界面会阻止提交，不会静默丢弃这些内容。

Goal 创建后会锁定 Outcome、范围、约束和 Acceptance Criteria。它通常会进入 Plan 阶段提出方案，等待批准后再由普通 Agent turns 和工具完成步骤。

Plan 执行完不等于 Goal 已完成。系统还会检查每条必需的验收条件、真实工具 Observation、人工确认或 reviewer 结果。模型回复、Todo、Plan 状态和界面操作都不能直接把 Goal 写成 `completed`；最终状态由 Core 的 Completion Gate 决定。

Goal 常用命令：

| 命令                             | 作用                            |
| -------------------------------- | ------------------------------- |
| `/goal`                          | 等待下一条纯文字作为 Outcome    |
| `/goal <outcome>`                | 创建当前会话的 Goal             |
| `/goal status`                   | 查看当前 Goal                   |
| `/goals`                         | 列出当前会话的 Goal             |
| `/goal pause` 或 `/goal-pause`   | 安全暂停                        |
| `/goal resume` 或 `/goal-resume` | 重新校验会话和 workspace 后继续 |
| `/goal cancel` 或 `/goal-cancel` | 永久取消                        |

Stop 在 Goal 中表示可恢复的 Pause，不表示已经完成。Cancel 才是不可恢复的终态。应用重启也不会自动恢复写操作，必须由用户显式 Resume。

Composer 同一时间只显示 Goal 或 Plan 其中一个标识。Goal 进入内部规划阶段时仍显示 Goal，状态条会标注“规划中”。鼠标悬浮或键盘聚焦后，标识右上角会出现关闭按钮。尚未创建 Goal 时，关闭只退出待输入状态并保留输入框文字；正式 Goal 处于暂停或等待用户状态时，切换到 Plan 会永久取消旧 Goal，再开启独立 Plan，旧记录仍保留用于审计。Goal 正在 Contract、规划、执行或核验时不能切换，应先停止或暂停。

反向切换同样自动处理：Goal 待输入状态切换到 Plan 时会保留输入框文字；独立 Plan 切换到 Goal 时，必须先成功退出 Plan。`/plan off` 不会关闭 Goal 内部规划，`/plan status` 在 Goal 存续期间只报告当前顶层模式为 Goal。

Goal 不会提高当前权限。连续三个 cycle 没有产生可确认的 Goal、Plan、Observation、Evidence 或交互进展时，Coordinator 会安全暂停。默认不设置总 cycle、总时长或总成本上限；需要这些限制时，应显式配置 guard。

### 怎么选择

| 对比项       | 普通 Chat / Build                | Plan                         | Goal                                          |
| ------------ | -------------------------------- | ---------------------------- | --------------------------------------------- |
| 核心对象     | 当前请求                         | 一份待确认的执行方案         | 锁定的结果、范围和验收条件                    |
| 是否先规划   | 可选                             | 必须先规划                   | 通常会使用 Plan，也允许后续 replan            |
| 生命周期     | 通常是一个 Agent turn            | 提案、审批、分步执行         | 跨多个 turn、Plan 和应用重启                  |
| 完成条件     | 当前回复结束                     | Plan 步骤与验证要求完成      | 必需 AC、Plan、Evidence、复核和 Gate 全部通过 |
| 重启后的状态 | 恢复历史，不自动重跑未完成 turn  | 恢复 Plan 和交互状态         | 从持久账本恢复为安全状态，显式 Resume 后继续  |
| 权限变化     | 使用当前模式                     | 规划阶段限制为只读和控制操作 | 沿用权限规则，不自动提权                      |
| 适合场景     | 问答、轻量修改、明确的一次性任务 | 希望先审阅方案的复杂任务     | 多阶段开发、迁移、反复修复和严格验收          |

### 其他常用命令

| 命令                           | 作用                                             |
| ------------------------------ | ------------------------------------------------ |
| `/help`                        | 查看当前可用的 slash commands                    |
| `/status`、`/model`、`/tokens` | 查看运行状态、模型配置摘要和 Token 消耗          |
| `/tools`、`/skills`            | 查看当前会话可以使用的工具与 Skills              |
| `/memory`、`/compact`          | 查看记忆状态或主动压缩当前会话                   |
| `/stop`                        | 停止当前 turn；Goal 运行中会转成 Pause           |
| `/reload`                      | 重新加载 bootstrap、模型、Skills、工具和记忆状态 |

<a id="capabilities"></a>

## 功能与成熟度

下面的分级描述当前能力边界，不代表公开安装包已经进入 Stable。

### 可直接使用

| 能力                | 当前用途                                           |
| ------------------- | -------------------------------------------------- |
| Chat / Build        | 多会话对话和项目工作区隔离                         |
| Ask / Plan          | 澄清问题、审批计划和恢复执行                       |
| 模型配置            | 保存多个 Provider 模型、激活一个模型并标记视觉能力 |
| 记忆                | 全局长期记忆、用户档案、项目私有记忆和版本恢复     |
| 附件                | 保存图片、文本和受支持的文档，并传入模型上下文     |
| 本地工具            | 文件读取与修改、搜索、命令执行和 Todo 更新         |
| Skills / MCP        | 加载本地技能并接入已配置的 MCP server              |
| Token / Diagnostics | 查看消耗、上下文、运行状态和环境问题               |

### 预览能力

| 能力            | 入口与限制                                                                |
| --------------- | ------------------------------------------------------------------------- |
| Goal            | 在 Chat 或 Build 中使用 `/goal`；当前按单 Core host 串行推进写任务        |
| Scheduler       | Scheduler 面板和工具；任务仍受权限、控制交互和运行锁限制                  |
| Team            | 已有成员、Inbox 和任务工具；独立 `/team` 页面尚未开放                     |
| Agent Hooks     | Settings → Hooks；v1 支持 `command` 和 `http` handler，不能覆盖 Core deny |
| Headless ACP V1 | 源码 operator preview；本机 stdio、纯文本、Build 会话，无桌面开关         |
| 桌宠 companion  | 设置页手动启用；默认关闭，由主 Electron 进程托管                          |

### 基础设施

| 能力            | 当前状态                                                                     |
| --------------- | ---------------------------------------------------------------------------- |
| External Bridge | 内置默认关闭的 Signed Webhook operator preview；不是 Slack、邮件等平台连接器 |
| Watchlist       | 已有检查和调度链路，主要供受控后台维护使用                                   |

<a id="data-security"></a>

## 数据、权限与安全

### 本地数据放在哪里

Emperor Agent 把应用资源和用户私有数据分开：

- `runtimeRoot` 保存内置模板、Skills 和静态资源。开发模式默认是仓库根，打包模式默认是 Electron `userData/runtime`。
- `stateRoot` 保存会话、记忆、配置、附件和其他运行数据，默认是 `~/.emperor-agent`。

可以通过 `EMPEROR_CONFIG_DIR` 覆盖 `stateRoot`。完整的解析优先级、迁移规则和目录说明见[全局私有存储根架构](docs/architecture/global-state-store.md)。

常用私有路径都相对 `stateRoot`：

| 数据            | 路径                                    |
| --------------- | --------------------------------------- |
| 模型配置        | `model_config.json`                     |
| 会话历史与事件  | `sessions/<session-id>/`                |
| 全局长期记忆    | `memory/MEMORY.local.md`                |
| 项目私有记忆    | `projects/<project-id>/AGENTS.local.md` |
| 附件            | `memory/attachments/`                   |
| Goal 状态与证据 | `goals/<goal-id>/`                      |
| Hooks 审计      | `hooks/audit.jsonl`                     |
| External 配置   | `external_config.json`                  |
| External 状态   | `external/state.json`                   |
| External 审计   | `external/audit.jsonl`                  |

Build 项目目录不会承载私有 session、memory、attachments 或 Goal 数据。项目中允许存在协作文档 `AGENTS.md`，以及 `.emperor/settings*.json`、`rules/` 和项目级 Skills；这些内容与全局私有 store 不是一回事。

### 权限模式

| 内部模式          | 命令          | 行为                                                                           |
| ----------------- | ------------- | ------------------------------------------------------------------------------ |
| `ask_before_edit` | `/mode ask`   | 低风险读取、普通文件写入和低风险命令可继续；敏感路径、批量替换和高风险操作询问 |
| `accept_edits`    | `/mode edits` | 普通文件编辑可以直接执行，shell、Team、Scheduler 和其他 mutation 仍需确认      |
| `auto`            | `/mode auto`  | 在当前权限下自动推进；未证明只读的 shell 命令仍需确认                          |

Plan 通过 `/plan` 或 `/plan on|off|status` 独立管理，不属于权限菜单，并与顶层 Goal 互斥。Goal 内部仍可复用 Plan 引擎，但不会产生第二个用户模式。上述三种权限都不会关闭路径安全、schema 校验或 Core deny。存在未处理的 Ask 或 Plan 时，执行型 Scheduler、Team 和桌宠 mutation 会被 CoreApi guard 拒绝；Agent Hooks 也不能覆盖 workspace policy 或 Core deny。Goal 同样复用这套规则，不会因为运行时间更长而获得额外权限。

MCP 工具结果、网页内容和外部消息都按不可信输入处理。涉及命令、文件、模型配置或外部服务时，仍应检查请求内容和授权范围。

<a id="boundaries"></a>

## 当前边界

- 公开安装包目前是未签名 Preview，不是 Stable。
- Emperor Agent 是本地单用户 Electron 应用，不提供多人服务端部署。
- 桌面主链路必须经过 Electron IPC；普通浏览器不能直接运行完整产品。
- Headless ACP 是源码级、本机 stdio operator preview，不随当前桌面安装包提供服务端入口；它复用 TypeScript Core，不是 IPC、HTTP 或 WebSocket fallback。
- Python runtime、Python CLI 和 HTTP/WS backend 已退役，不是备用执行路径。
- Goal 的支持边界是单 Core host 串行 mutation owner，不允许两个写任务同时占用全局执行槽。
- Goal 默认没有总 cycle、总时长或总成本上限；无进展暂停和显式 guard 负责控制长循环。
- External Bridge 的 Signed Webhook 仅是默认关闭、loopback-only、需手工配置的 operator preview；Watchlist 仍属于基础设施。两者都不代表已经提供 Slack、邮件或社交平台连接器。
- 损坏或无法证明安全的中间状态会 fail closed。Goal 不会被隐式降级成普通 Chat 后继续写入。

<a id="source"></a>

## 从源码运行

这一部分面向开发者。源码运行需要 Node.js 22 或更高版本；安装包用户不需要安装 Node.js。

```bash
npm ci

cd desktop
npm ci
npm run dev
```

根目录和 `desktop/` 使用各自的 lockfile，因此需要分别安装依赖。`npm run dev` 会启动 Electron、Vite HMR 和进程内 CoreApi。

受信的本机 ACP client 可以从仓库根目录启动 Headless operator preview：

```bash
npm run headless:acp -- --runtime-root "$PWD"
```

该进程只在 stdio 上实现当前稳定 ACP V1 子集，不监听网络端口。它只接受纯文本 prompt、创建或加载绑定既存目录的 Build 会话，并拒绝 client 注入 MCP server 或额外 workspace root。完整边界、配置和验证方式见 [Headless ACP operator preview](docs/development/headless-acp.md)。

### 质量检查

```bash
make check
```

`make check` 会检查公开文档边界、格式、Core/Desktop tests、typecheck、零 warning ESLint 和生产构建。

涉及界面时额外运行：

```bash
npm --prefix desktop run screenshots
```

验证未打包目录和 packaged smoke：

```bash
npm --prefix desktop run package:verify
```

`package:verify` 会加载真实打包后的 sandboxed renderer，并验证 preload Core bridge 与受管附件协议；仅生成未打包目录不能替代该门禁。

分支、目录约定、不应提交的数据和扩展方式统一记录在 [`AGENTS.md`](AGENTS.md)，README 不重复维护这些规则。

<a id="docs"></a>

## 文档导航

完整入口见[文档中心](docs/README.md)。公开文档按用户手册、当前架构、开发和发布说明分层维护。

| 想了解什么                   | 文档                                                              |
| ---------------------------- | ----------------------------------------------------------------- |
| 从安装到完整界面能力         | [用户手册](docs/user/README.md)                                   |
| 当前系统边界和执行链路       | [架构总览](docs/architecture/overview.md)                         |
| Goal 状态机、Evidence 和恢复 | [Goal 模式架构](docs/architecture/goal-mode.md)                   |
| 私有数据位置与旧数据迁移     | [全局私有存储根架构](docs/architecture/global-state-store.md)     |
| 源码开发和扩展清单           | [开发指南](docs/development/README.md)                            |
| Headless ACP stdio           | [Headless ACP operator preview](docs/development/headless-acp.md) |
| 未签名 Preview 的安装安全    | [未签名预览版说明](docs/release/unsigned-preview-notice.md)       |
| 当前 Preview 构建与发布      | [Preview 发布手册](docs/release/preview-release-runbook.md)       |
| 未来 Stable 发布边界         | [Stable 发布手册](docs/release/stable-release-runbook.md)         |
| 环境工具 catalog 变更        | [工具 catalog 审查流程](docs/release/tool-catalog-review.md)      |
| 安全边界与私密报告           | [Security Policy](.github/SECURITY.md)                            |
| 版本变化                     | [Changelog](docs/release/CHANGELOG.md)                            |
| 文档维护机制                 | [文档维护规范](docs/DOCUMENTATION.md)                             |
| 开发协作规范                 | [AGENTS.md](AGENTS.md)                                            |

## License

Emperor Agent 使用 [MIT License](LICENSE)。

<p align="center">
  <img src="assets/generated/emperor-agent-logo-mark.png" alt="Emperor Agent 标志" width="56" />
</p>
