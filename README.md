<p align="center">
  <img src="assets/generated/emperoragent-wordmark.png" alt="Emperor Agent 产品字标" width="560" />
</p>

<h1 align="center">Emperor Agent · 皇帝智能体</h1>

<p align="center">
  <b>本地运行的个人 Agent 工作台</b><br/>
  日常对话 · 项目工作 · 先规划再执行 · 持续完成长任务
</p>

Emperor Agent 是一款面向个人长期使用的桌面 Agent。你可以用它处理日常问答，也可以绑定本地项目，让 Agent 在明确的权限范围内读取文件、运行工具并持续推进任务。

桌面端直接托管 TypeScript Core 与 Agent 内核，界面通过 Electron IPC 与核心能力通信。已经退役的 Python CLI、HTTP server 和 WebSocket server 不再参与运行。

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

| 层级         | 含义                                                                      |
| ------------ | ------------------------------------------------------------------------- |
| Chat / Build | 会话类型：一个用于普通对话，一个绑定本地项目                              |
| 权限预设     | `read-only`、`workspace-write`、`danger-full-access`：决定 Agent 能写哪里 |
| Plan         | 规划模式：先只读探索并提交方案，批准后再执行                              |
| Goal         | 让 Agent 在你不再输入时一轮轮继续推进同一个目标                           |
| Scheduler    | 按时间触发 Agent turn 的机制                                              |

应用会把会话、记忆、配置和附件保存在本机。Chat（普通对话）适合问答和轻量任务；Build（项目工作）绑定本地目录，并读取项目中的 `AGENTS.md` / `CLAUDE.md`。

每个会话的全部内容都记录在一份只追加的 session log 中：模型看到的内容与记录一一对应，应用崩溃后可以自动修复并继续使用。

“本地优先”不等于完全离线。模型请求会发送给你配置的 Provider；调用远程 MCP、会联网的 Skill 或命令时，对应内容也会离开本机。

<a id="download"></a>

## 下载与首次使用

安装包适合直接使用，不要求目标机预装 Node.js、Python、Git 或 ripgrep。

1. 打开 [GitHub Releases](https://github.com/TheSyart/emperor-agent/releases)。
2. 根据设备选择 macOS、Windows 或 Linux 安装包。
3. 当前公开安装包是未签名 Preview，不是 Stable。运行前请阅读[未签名预览版安全说明](docs/release/unsigned-preview-notice.md)。
4. 第一次启动后进入设置页，添加模型 Provider、API Key 和模型 ID。
5. 创建 Chat 开始普通对话，或者选择本地目录创建 Build 会话。

没有可用模型时，对话和模型测试会给出配置入口；熟悉配置文件的用户也可以参考 [`config/examples/model_config.example.json`](config/examples/model_config.example.json)。

### 模型配置

设置页可以保存多个标准接口模型，管理 Provider、协议、凭证和能力；当前使用哪个模型在聊天输入框中选择，切换从下一次请求开始生效。Provider 为 `deepseek` 时使用内置的 DeepSeek 适配器，其他 Provider 按所选协议走 OpenAI Chat Completions 或 Anthropic Messages。可重试的错误最多自动重试 5 次，不会暗中切换模型。

模型配置、记忆和附件见[模型、记忆与附件](docs/user/models-memory-attachments.md)。

<a id="workflows"></a>

## Chat、Build、Plan 与 Goal

### Chat：普通对话

Chat 适合日常问答、资料整理和一次性的工具任务。它使用用户档案、全局长期记忆和当前会话历史，工作目录是 Emperor Home 下的 `workspace/`，不绑定你的项目。

### Build：项目工作

Build 会话绑定一个本地文件夹，适合代码、文档和其他项目任务。Agent 会读取项目中逐级的 `AGENTS.md` / `CLAUDE.md` 和该项目的私有记忆。项目私有记忆保存在全局 `stateRoot`，不会写回项目文件。

### 权限预设

| 命令                              | 行为                                                          |
| --------------------------------- | ------------------------------------------------------------- |
| `/permissions read-only`          | 可以读取；任何写入都需要你逐次批准                            |
| `/permissions workspace-write`    | 默认。可以写当前 workspace 和临时目录；超出范围时逐次请求批准 |
| `/permissions danger-full-access` | 不限制写入，也不弹出审批                                      |

批准只对那一次工具调用有效。Shell 命令在 macOS（Seatbelt）和 Linux（bubblewrap）上由系统沙箱执行；其他平台没有沙箱后端，只有 `danger-full-access` 才能运行 Shell 命令。受限预设主要限制文件写入；macOS 还拒读 Emperor 的电脑操作状态与浏览器数据，并阻止部分系统 GUI 连接。普通文件读取和互联网访问仍不受此文件沙箱普遍限制。

### Plan：先规划再执行

```text
/plan
/plan 为现有项目设计一套迁移方案
/plan off
```

进入 Plan 后，Agent 先只读探索、必要时向你提问，然后提交一份完整计划。你可以选择 **Approve**（退出 Plan 并开始执行）或 **Keep planning**（附上意见让它修改）。Plan 通过提示词约束 Agent，实际写入范围仍由当前权限预设决定。

### Goal：持续推进一个目标

```text
/goal 让项目的全部测试通过
```

设置 Goal 后，每当 Agent 空闲，系统会自动发起新一轮续跑，直到 Agent 判断目标完成、报告受阻，或达到轮数上限（默认 256 轮）。你的消息始终优先。

| 命令                | 作用          |
| ------------------- | ------------- |
| `/goal`             | 查看当前 Goal |
| `/goal <目标>`      | 设置 Goal     |
| `/goal edit <目标>` | 修改目标      |
| `/goal pause`       | 暂停自动续跑  |
| `/goal resume`      | 恢复自动续跑  |
| `/goal clear`       | 清除当前 Goal |

应用重启后 Goal 保留，但需要 `/goal resume` 才会继续续跑。Goal 不提高权限。

### 怎么选择

| 情况                             | 使用              |
| -------------------------------- | ----------------- |
| 问答、轻量修改、明确的一次性任务 | 普通 Chat / Build |
| 希望先审阅方案                   | Plan              |
| 希望 Agent 自己一轮轮推进到完成  | Goal              |
| 希望按时间定期发起任务           | Scheduler         |

### 斜杠命令

| 命令                   | 作用                                    |
| ---------------------- | --------------------------------------- |
| `/new`                 | 在当前工作区创建一条空白会话            |
| `/compact`             | 保留摘要并释放当前会话的上下文空间      |
| `/model`、`/reasoning` | 选择模型和思考强度                      |
| `/permissions <预设>`  | 查看或切换权限预设                      |
| `/plan`、`/goal`       | 进入规划模式或设置持续目标              |
| `/stop`、`/continue`   | 停止当前任务，或让 Agent 继续上一项工作 |

命令目录由 Core 生成。每个 active Skill 直接使用自己的 token，例如 `/agent-reach 搜索相关讨论`。未知命令只在本地报错，不会发送给模型。完整语义见 [Slash command 平台](docs/architecture/slash-command-platform.md)。

<a id="capabilities"></a>

## 功能与成熟度

下面的分级描述当前能力边界，不代表公开安装包已经进入 Stable。

### 可直接使用

| 能力                   | 当前用途                                                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Chat / Build           | 多会话对话和项目工作区隔离                                                                                               |
| 权限预设与 Plan        | 控制写入范围、一次性提权、先规划再执行                                                                                   |
| 模型配置               | 保存多个 Provider 模型、激活一个模型并标记视觉能力                                                                       |
| 记忆                   | 用户档案、全局长期记忆、项目私有记忆、版本恢复和 `memory_edit`                                                           |
| 附件                   | 保存图片、文本和受支持的文档，并传入模型上下文                                                                           |
| 本地工具               | 文件读写与编辑、搜索、Shell（含后台任务）、Todo 与提问                                                                   |
| 子代理                 | 在后台委派独立或继承上下文的子任务                                                                                       |
| Skills / Plugins / MCP | 在「能力」页导入和编辑本地 Skill、安装版本化 Plugin、粘贴配置接入 MCP server、查看注册的工具；「探索」页提供少量精选条目 |
| 右侧工作台             | Build 会话的审查（Git Review）、用户终端和只读文件；任何会话可用的内置浏览器                                             |
| 环境信息与导航         | 对话右上角的环境信息卡、置顶会话、应用内通知、前进 / 后退和快捷键                                                        |
| Token / Diagnostics    | 查看消耗、上下文、运行状态和环境问题                                                                                     |

### 预览能力

| 能力            | 入口与限制                                                              |
| --------------- | ----------------------------------------------------------------------- |
| Goal            | `/goal`；同一会话内自动续跑，重启后需要显式恢复                         |
| Scheduler       | 定时任务页面和 `scheduler` 工具；任务使用与普通对话相同的权限           |
| Pull Request    | 侧栏「Pull Request」页；只读，需要本机已安装并登录的 GitHub CLI（`gh`） |
| Hooks           | Settings → Hooks；`hooks.json` 配置，仅 `command` handler               |
| Headless ACP V1 | 源码 operator preview；本机 stdio、纯文本、Build 会话，无桌面开关       |
| 桌宠 companion  | 设置页手动启用；默认关闭，由主 Electron 进程托管                        |

### 基础设施

| 能力      | 当前状态                                   |
| --------- | ------------------------------------------ |
| Watchlist | 已有检查和调度链路，主要供受控后台维护使用 |

<a id="data-security"></a>

## 数据、权限与安全

### 本地数据放在哪里

- `runtimeRoot` 保存内置模板、Skills 和静态资源。开发模式默认是仓库根，Release 来自只读的 `resources/runtime-defaults`。
- Emperor Home（内部兼容名 `stateRoot`）保存会话、记忆、配置、附件、用户 Skills 和受管工具环境，默认是 `~/.emperor`，可以通过 `EMPEROR_CONFIG_DIR` 整体覆盖。

常用私有路径都相对 `stateRoot`：

| 数据         | 路径                                    |
| ------------ | --------------------------------------- |
| 模型配置     | `model_config.json`                     |
| 会话记录     | `sessions/<session-id>/log.jsonl`       |
| 全局长期记忆 | `memory/MEMORY.local.md`                |
| 项目私有记忆 | `projects/<project-id>/AGENTS.local.md` |
| 附件         | `memory/attachments/`                   |
| Hooks 配置   | `hooks.json`                            |
| 用户 Skills  | `skills/`                               |
| 大工具结果   | `spill/`                                |
| 受管工具环境 | `environment/`                          |

首次启动当前版本时，旧版本的 `sessions/` 目录会整体移到 `sessions.legacy-<时间戳>/` 保留，新版本从空的会话列表开始。完整规则见[全局私有存储根架构](docs/architecture/global-state-store.md)。

Build 项目目录不会承载私有会话、记忆或附件数据。

### 安全要点

- 权限预设限制 Agent 的文件写入；读取文件和网络访问不受沙箱限制。
- 子代理继承当前沙箱模式，但不能请求提权。
- 记忆编辑、MCP 工具、Skill 加载和 Scheduler 工具不需要审批；只配置你信任的 MCP server。
- Agent 用 `skill_manage` 修改 Skills、用 `mcp_config` 修改 MCP 配置时，除 `danger-full-access` 外每次写入都需要你批准。
- 存在待回答的问题或审批，或处于 Plan 模式时，由界面发起的 Scheduler、Skill、Plugin、模型和 MCP 配置修改会被 CoreApi guard 拒绝。
- 右侧工作台的浏览器只打开你在地址栏输入的 `http(s)` 网址，使用不落盘的独立会话，拒绝网页的权限请求和下载。
- MCP 结果和外部内容按不可信输入处理。涉及命令、文件、模型配置或外部服务时，仍应检查请求内容和授权范围。

<a id="boundaries"></a>

## 当前边界

- 公开安装包目前是未签名 Preview，不是 Stable。
- Emperor Agent 是本地单用户 Electron 应用，不提供多人服务端部署。
- 桌面主链路必须经过 Electron IPC；普通浏览器不能直接运行完整产品。
- Headless ACP 是源码级、本机 stdio operator preview，不随当前桌面安装包提供服务端入口；它复用 TypeScript Core，不能回答问题或审批。
- Python runtime、Python CLI 和 HTTP/WS backend 已退役，不是备用执行路径。
- 默认没有内置网页搜索或网页抓取工具。
- 没有 macOS / Linux 以外的 Shell 沙箱后端。
- Watchlist 仍属于受控后台维护基础设施，不提供外部消息平台连接器。

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

`package:verify` 使用本地 Preview 配置打包并加载真实的 sandboxed renderer，验证 preload Core bridge 与受管附件协议；在 macOS 上还运行受限 Seatbelt 的开发命令矩阵及电脑操作状态拒读检查。仅生成未打包目录不能替代该门禁。正式签名发布使用独立 release 配置。

分支、目录约定、不应提交的数据和扩展方式统一记录在[开发指南](docs/development/README.md)，README 不重复维护这些规则。

<a id="docs"></a>

## 文档导航

完整入口见[文档中心](docs/README.md)。公开文档按用户手册、当前架构、开发和发布说明分层维护。

| 想了解什么                | 文档                                                              |
| ------------------------- | ----------------------------------------------------------------- |
| 从安装到完整界面能力      | [用户手册](docs/user/README.md)                                   |
| 当前系统边界和执行链路    | [架构总览](docs/architecture/overview.md)                         |
| Goal 状态、续跑与授权     | [Goal 架构](docs/architecture/goal-mode.md)                       |
| 私有数据位置与旧数据迁移  | [全局私有存储根架构](docs/architecture/global-state-store.md)     |
| 源码开发和扩展清单        | [开发指南](docs/development/README.md)                            |
| Headless ACP stdio        | [Headless ACP operator preview](docs/development/headless-acp.md) |
| 未签名 Preview 的安装安全 | [未签名预览版说明](docs/release/unsigned-preview-notice.md)       |
| 当前 Preview 构建与发布   | [Preview 发布手册](docs/release/preview-release-runbook.md)       |
| 未来 Stable 发布边界      | [Stable 发布手册](docs/release/stable-release-runbook.md)         |
| 环境工具 catalog 变更     | [工具 catalog 审查流程](docs/release/tool-catalog-review.md)      |
| 安全边界与私密报告        | [Security Policy](.github/SECURITY.md)                            |
| 版本变化                  | [Changelog](docs/release/CHANGELOG.md)                            |
| 文档维护机制              | [文档维护规范](docs/DOCUMENTATION.md)                             |
| 开发协作规范              | [开发指南](docs/development/README.md)                            |

## License

Emperor Agent 使用 [MIT License](LICENSE)。

<p align="center">
  <img src="assets/generated/emperor-agent-logo-mark.png" alt="Emperor Agent 标志" width="56" />
</p>
