# 界面文案规范

> 文档状态：Active<br>
> 面向读者：设计者、前端开发者、维护者<br>
> 最后核验：2026-10-21<br>
> 事实源：`desktop/src/renderer/src/copyAudit.ts` 与 `copy-audit.test.ts`（文案扫描）、`desktop/src/renderer/src/errors/messages.ts` 与 `messages.test.ts`（错误码文案）

Emperor 的界面说中文。按钮、标题、提示、错误、空状态、读屏标签（`aria-label`）和悬停提示都写中文；品牌名、协议、文件名、命令和代码值保持原样。本文给出术语表、禁用词、格式约定和错误文案的规则；`copy-audit.test.ts` 在每次检查时扫描全部界面源码，违反规则的文案会让测试失败。

## 原则

- **说中文，说短句。** 一个按钮一个动词（保存、获取、推送），一条提示说清发生了什么、接下来能做什么：「GitHub CLI 还没有登录，请在终端运行 gh auth login。」
- **用户看到的是结果，不是实现。** 不在界面上出现内部错误码（`git_gh_unavailable`）、类名或英文异常原文；需要排查时，原始信息放进可复制的错误详情（见「错误文案」）。
- **同一个东西只有一个名字。** 按下面的术语表写；术语表没有的新概念，先加进本文再用。

## 术语表

| 术语                    | 指什么                                                          | 不要写                     |
| ----------------------- | --------------------------------------------------------------- | -------------------------- |
| 子智能体                | 主会话交出去的任务的执行者：内置子智能体，或 Claude Code、Codex | 子代理、执行器、外部执行器 |
| 主智能体                | 用户正在对话的那个 Agent，与子智能体相对                        | 主代理                     |
| 交给子智能体 / 安排任务 | 主会话把一件事交出去                                            | 派工、派发                 |
| 验证                    | 检查子智能体的成果是否达标（命令、测试、人工确认）              | 验收                       |
| 成果                    | 子智能体留下的文件改动与说明                                    | 结果树                     |
| 目标                    | `/goal` 开启的长期目标（目标模式、目标已暂停）                  | Goal                       |
| 计划 / 计划模式         | `/plan` 开启的先计划后执行的模式                                | Plan、Plan 模式            |
| 定时任务                | 按时间或周期运行的任务（侧栏入口与通知）                        | Scheduler、调度任务        |
| 工作台                  | 主窗口右侧的一栏：文件、终端、审查、浏览器、环境信息            | 右侧面板、Workspace        |
| 环境信息                | 工作台里显示会话目录、分支、worktree 与子智能体的那一页         | Environment                |
| 审查                    | 工作台里看改动、提交、操作分支与 Pull Request 的那一页          | Review、代码审查页         |
| 待发送                  | 输入框上方排队、还没有发给模型的消息                            | 队列消息、Queued           |
| 过程                    | 一轮回答里折叠起来的思考与工具调用（查看过程 / 收起过程）       | 步骤详情、Trace            |
| 轨迹                    | 开启「显示轨迹」后的调试视图：每轮的请求、记录与计时            | Trajectory                 |
| 登录档案                | Emperor 操作网页时使用的浏览器配置（持久 / 临时）               | profile、浏览器 profile    |

## 禁用词

下列词已经退役。`copy-audit.test.ts` 在界面源码的每个字符串里查找它们，也查 Core 源码的字符串：Core 的错误与提示经 IPC 显示在界面上，要用同样的词。

| 禁用词 | 改用                                     |
| ------ | ---------------------------------------- |
| 子代理 | 子智能体                                 |
| 执行器 | 子智能体（或直接写 Claude Code / Codex） |
| 派工   | 交给子智能体 / 安排任务                  |
| 验收   | 验证 / 检查                              |
| 结果树 | 成果                                     |

禁用词表的唯一来源是 `copyAudit.ts` 的 `BANNED_TERMS`；改这里时同步改它。

## 保留原文的内容

这些内容不翻译，扫描也不会报：

- **品牌与产品名**：Emperor、Claude Code、Codex、GitHub、DeepSeek、macOS、Chrome、Emperor Computer Helper、Ralph 循环里的 Ralph。
- **协议与格式**：MCP、API Key、URL、HTTPS、JSON、Markdown、OAuth、Pull Request（PR）、Git、worktree、Token、TTFT。
- **能力的专有名**：Skill、Hook、Plugin 作为功能名保留（「个人 Skill」「Hooks 视图」）。
- **文件、路径、地址**：`SKILL.md`、`~/.emperor/`、`https://…`、`owner/repo`、Bundle ID（`com.example.Writer`）、环境变量（`HTTPS_PROXY`）。
- **命令与参数**：完整的命令行（`git pull --ff-only`、`gh auth login`）和 `--flag`。
- **代码与样例值**：`<code>`、`<pre>`、`<kbd>` 里的内容；等宽（`monospace` / `mono`）输入框的占位样例（`npx`、`aihot`）和徽标；工具页里的 JSON Schema 类型名（`string`、`enum`、`any`）。
- **轨迹里的原始协议值**：轨迹是调试视图，记录的取值（`pass`、`workspace-write`、阶段名）照原样显示，标签与外围说明写中文（「决定：pass · 退出码 0」）。

模型 ID、用户自己起的名字（会话标题、分支名、服务器名）和模型生成的内容当然也原样显示。

## 格式

- **中英文、中文与数字之间加一个空格**：「Emperor 操作网页时」「4 步 · 4 次工具调用」「第 3 轮」；全角标点前后不加空格。
- **并列信息用 `·` 分隔**：「已连接 · 2 个工具」「请求 #4 · 压缩」。
- **界面上的名字用「」**，路径用 `›`：在「设置 › 子智能体」里启用它。
- **序号**：轮次「第 N 轮」，步骤「第 N 步」，消息块「第 N 块」，请求「请求 #N」，压缩「压缩 #N」。
- **省略号用 `…`**（一个字符）：「正在加载更早的记录…」。
- **按钮写动作，不写「点击」**：「打开子智能体设置」，不写「点击这里打开设置」。
- **Git 操作**：菜单里写中文动作（获取 / 拉取 / 推送），悬停提示里写对应的 git 命令（`git fetch`、`git pull --ff-only`、`git push`），让熟悉命令行的人一眼对上。
- **推理强度**：默认 / 最低 / 低 / 中 / 高 / 超高 / 最高 / 关闭。

## 错误文案

Core 调用失败时，`invokeCore` 用 `errors/messages.ts` 决定界面显示什么：

1. Core 自己的消息已经是中文时，原样显示——大多数是，而且写着具体的文件、服务器或分支；
2. 否则显示错误码对应的中文（`ERROR_MESSAGES`）。MCP、Skill 和参数校验的消息仍是英文，走这一步；
3. git 与 gh 的失败在中文后面附上工具输出的第一行（「Git 命令失败：fatal: couldn't find remote ref main」），这一行往往就是原因；
4. 都不满足时显示「操作没有完成。错误详情可以复制给开发者。」，内部错误显示「发生内部错误，请查看日志。」。

错误码、Core 的原始消息和 IPC 错误 ID 保存在错误对象的 `detail` 上（`错误码 · 原始消息 · 错误 ID`），供复制与排查；界面逻辑要判断错误类型时读 `code` 或 `detail`，不要匹配显示出来的文字（它已经是中文，也会改）。

`messages.test.ts` 从 Core 源码里读出所有能经 IPC 到达界面的错误码——`EmperorError` 及其子类、`WorkspaceOperationError`、MCP / Skill / 插件 / 环境配置的错误码联合类型、`DelegationError` 的指引表、主进程 IPC 的中断码——任何一个没有中文就失败。新增错误码时，同时在 `ERROR_MESSAGES` 里加一行。Harness 与电脑操作的错误（`HarnessError`、`UiError`）给模型看，不经 IPC 显示，不在此列。

## 文案扫描

`copy-audit.test.ts` 扫描 `desktop/src/renderer/src` 下除测试、`testing/`、开发画廊之外的全部 `.vue` 与 `.ts` 文件：

| 扫描什么                                                                                       | 例子                                        |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------- |
| 模板文字                                                                                       | `<Button>保存</Button>`                     |
| 可见属性：`title`、`aria-label`、`placeholder`、`label`、`description`、`hint` 等              | `title="打开文件"`                          |
| 绑定的可见属性与 `{{ }}` 插值里**能显示出来的字符串**：三元两支、`                             |                                             | `/`??`/`+` 两侧、模板字符串的固定部分 | `:title="open ? '折叠所有轮次' : '展开所有轮次'"` |
| 对象里的 `label`、`title`、`description`、`placeholder`、`hint`、`tooltip` 等键                | `{ id: 'fetch', label: '获取' }`            |
| 名字以 Label / Title / Text / Description / Caption / Summary 结尾的函数与 `computed` 的返回值 | `function stateLabel() { return '运行中' }` |

比较与调用参数里的字符串不算（`state === 'running'` 不会报）。中文字符串一律放行；纯英文字符串去掉 URL、路径、文件名、参数、全大写常量、域名和完整命令行之后，剩下的英文词只要有一个不在 `ALLOWED_WORDS` / `ALLOWED_PHRASES` 里就报。禁用词另外在界面与 Core 的每个字符串里查。

扫描报错时，先翻译那条文案；确实是品牌名、协议名或代码的，加进 `copyAudit.ts` 的 `ALLOWED_WORDS`（单词）或 `ALLOWED_PHRASES`（多词名称），并在这里的「保留原文的内容」补一句。计数的基线是 0：不留豁免名单。
