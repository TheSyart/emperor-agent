# 权限与 Plan 架构

> 文档状态：Active<br>
> 面向读者：Core 开发者、安全审查者、维护者<br>
> 最后核验：2026-10-19<br>
> 事实源：`packages/core/src/harness/sandbox/`、`packages/core/src/harness/approval/`、`packages/core/src/harness/plan/plan-mode.ts`、`packages/core/src/harness/questions/`、`packages/core/src/harness/host/interactions.ts`、`packages/core/src/harness/computer-use/`、`packages/core/src/harness/tools/builtin/skill-manage.ts`、`packages/core/src/harness/tools/builtin/mcp-config.ts`、`packages/core/src/api/mutation-guard.ts`、`packages/core/src/workspace/git-runner.ts`、`packages/core/src/security/`、`packages/core/src/config/model-config.ts`、`packages/core/src/mcp/config.ts`

Agent 能做什么由两个独立旋钮决定：**沙箱模式**限制文件写入范围，**审批策略**决定需要批准的操作是否询问用户。用户看到的是把两者打包在一起的**权限预设**。Plan 模式是独立的会话状态，不是第四种权限。

## 权限预设

| 预设                 | 沙箱模式             | 审批策略 | 行为                                                          |
| -------------------- | -------------------- | -------- | ------------------------------------------------------------- |
| `read-only`          | `read-only`          | `ask`    | 可以读取任何文件；任何修改都需要一次经批准的提权              |
| `workspace-write`    | `workspace-write`    | `ask`    | 可以写入当前 workspace 和系统临时目录；更大范围的重试需要批准 |
| `danger-full-access` | `danger-full-access` | `never`  | 不限制文件写入，也不弹出审批；需要审批的操作会被自动拒绝      |

新 session 固定使用默认预设 `workspace-write`。切换入口是 `/permissions <preset>`、Composer 的权限选择器和 `control.setPermissionMode`。选择记录为 session log 中的 `permission/preset`，随后只记录实际发生变化的 `sandbox/mode` 与 `approval/policy` 事件；当前预设从 log 推导。两个旋钮不对应任何预设时显示为 `custom`，该值不可选择。

权限状态完全存放在 session log 中，没有跨 session 的持久权限规则；旧版 `settings.json` 的 `permissions.rules` 在读取时被忽略。

## 沙箱模式

| 模式                 | 文件效果                                  |
| -------------------- | ----------------------------------------- |
| `read-only`          | 受限操作不能修改文件                      |
| `workspace-write`    | 只能写入 session workspace 与系统临时目录 |
| `danger-full-access` | 除受保护路径表外不限制文件效果            |

执行方式：

- `write` / `edit` 在进程内做路径围栏：`read-only` 直接拒绝；`workspace-write` 在写入前重新解析真实路径（能发现被替换的符号链接祖先），要求目标位于可写根内。
- `bash` 在受限模式下通过 OS 沙箱运行：macOS 使用 Seatbelt（`sandbox-exec`），Linux 使用 bubblewrap（启动时做一次功能探测）。其他平台没有后端，`read-only` 与 `workspace-write` 下的 `bash` 在启动前失败（fail closed），只有 `danger-full-access` 才会执行 Shell。
- 受限 `bash` 主要限制文件写入，并拒绝向 Apple Events、WindowServer 和 Helper socket 发起部分连接；普通文件读取与互联网访问没有普遍禁止。读写都受下文「受保护路径」一表约束：`read`、`edit`、`write`、`glob`、`grep` 不经过 Shell 沙箱，但与 Seatbelt 共用这一张表（`sandbox/protected-state.ts`）。`danger-full-access` 下的 `bash`（包括一次经批准的提权）在 macOS 上也跑在只含这张表的 Seatbelt profile 里（`LocalSandbox.guard`），守护进程起不来时 fail closed；Linux 与其他平台没有这层守护。
- `memory_edit`、`scheduler`、MCP 工具与 Skill 加载不经过文件沙箱，也不需要审批；Memory 是应用状态，MCP server 的能力由其配置决定。
- `skill_manage`（Skills 文件夹）与 `mcp_config`（`mcp_config.json`）同样不经过文件沙箱，但写入动作跟随权限预设：沙箱模式为 `danger-full-access` 时直接执行，其他模式下每次写入都通过 `ApprovalService` 询问一次，审批策略为 `never` 时被拒绝。查看类动作（`list`、`validate`、`reload`）不询问。

Chat 会话的 workspace 是 `stateRoot/workspace/` 下的可写目录；Build 会话的 workspace 是绑定的项目目录。

## 一次性提权

`bash`、`write`、`edit` 的参数都可以带 `sandbox_permissions`（`workspace-write` 或 `danger-full-access`）和一句 `justification`。请求的模式必须严格宽于当前有效模式；审批服务向用户询问一次，只有 `allowed-once` 才让这一次调用以更宽的模式执行，授权不会延续到之后的调用。`read` 也接受这对参数，但只用于读取凭据文件（见下节）：它要求 `danger-full-access`，审批理由写明文件（`escalate sandbox to danger-full-access to read credentials (~/.ssh/config): …`）。`bash` 请求 `danger-full-access` 时，命令文本里能认出的凭据路径（`~/…`、`$HOME/…`、`${HOME}/…` 或展开的家目录）同样写进审批理由；这只是提示，实际约束由 Seatbelt 执行。写入受保护路径的 `write` / `edit` 在询问之前就被拒绝，不会弹出无意义的审批。

审批策略为 `never` 时，需要审批的请求被确定性地拒绝，系统提示词也会告诉模型不要请求提权。子代理的审批策略固定为 `never`，因此子代理内的提权总是被拒绝。

每次询问在 session log 中记录为 `approval/asked` 与 `approval/decided`。结果只可能是 `allowed-once`、`rejected`、`cancelled` 或 `unavailable`；应答方缺失或出错时 fail closed 为 `unavailable`，崩溃修复会把没有决定的询问关闭为 `unavailable`。

## 受保护路径与配置加密

`sandbox/protected-state.ts` 定义一张表，分三类：

| 类别         | 路径                                                                                                                                         | 读                                          | 写  |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | --- |
| `state`      | `<stateRoot>/computer-use`、`<stateRoot>/browser`                                                                                            | 拒                                          | 拒  |
| `config`     | `<stateRoot>` 下直接以 `model_config`、`mcp_config`、`settings.json`、`hooks.json` 开头的文件（含 `.pre-seal-*`、`.tmp-*`、`.corrupt-*` 等） | 拒                                          | 拒  |
| `credential` | `~/.ssh`、`~/.aws`、`~/.config/gcloud`、`~/.docker/config.json`、`~/.netrc`、`~/.codex/auth.json`、`~/.claude/.credentials.json`             | 仅 `danger-full-access`（常设或一次性提权） | 拒  |

- 文件工具：`write` / `edit` 对三类都返回 `FS_PROTECTED_PATH`，任何模式、任何提权都一样；`read` 对 `state` / `config` 返回 `FS_PROTECTED_PATH`，对 `credential` 在受限模式下返回 `FS_SANDBOX_DENIED` 并提示带 `sandbox_permissions="danger-full-access"` 重试。判断按真实路径（符号链接、大小写、`/System/Volumes/Data` 别名），再按文件身份（硬链接）。
- 搜索工具：搜索根落在表内时报 `SEARCH_PROTECTED_PATH`，从上级目录搜索时略过表内条目；`credential` 只在 `danger-full-access` 下可搜，搜索不提供提权。
- Seatbelt：受限 profile 在所有放行规则之后追加 `(deny file-read* file-write* …)`（`state`、`config`）与凭据规则（受限模式读写都拒，`danger-full-access` 只拒写）；`config` 用以 Emperor Home 真实路径开头的正则匹配。Emperor Home 和凭据路径的各级父目录追加 `(deny file-write* (literal …))`，防止把整个目录改名移出规则（目录里照常可以新建文件）。宿主通过 `SandboxExecutionPolicy.writableFiles` 授给外部执行器的单个文件（AGT-03 的 Codex `auth.json`）在凭据规则之后重新放行读写，所以 Emperor 启动的 Codex 进程仍能读取并原地刷新用户的 `auth.json`；Agent 自己的 Shell 没有这项授权。`state` / `config` 规则排在放行之后，宿主授权也打不开它们。
- 已知影响：默认预设下 Agent 的 Shell 读不到 `~/.ssh`，经 SSH 的 git、`aws`、`gcloud`、带私有仓库凭据的 `docker` 需要一次提权或在用户终端运行；委派给 Claude Code / Codex 的子进程同样读不到这些位置（它们不能提权）。Claude 的 `.credentials.json` 由 Core 进程读取后以环境变量传入子进程，不受影响。MCP stdio server 用的是另一套进程隔离（SEC-08 统一），不在此表约束内。

配置里的秘密不再明文落盘（SEC-06）：

- 端口 `SecretSealer`（`security/secret-sealer.ts`）：`seal(plain, context) → "el1:<base64>"`、`open(sealed, context)`、`available`。实现基于 `security/local-secret-store.ts` 的 `LocalSecretStore`（AES-256-GCM，密钥文件 `<stateRoot>/computer-use/secrets/local.key`，从不使用钥匙串）；`context` 进入关联数据，值换到别的字段就解不开。桌面主进程把凭据库同一个 `LocalSecretStore` 实例包成 sealer 传给 Core（`KeptServicesOptions.secretSealer`）；没有主进程时（ACP、headless）Core 用同一个密钥文件自建（`createLocalKeySealer`），连「密钥丢失而凭据库仍有密文时不新建密钥」这条规则也一样（读 `vault.json` 判断）。
- `model_config.json`：每条 `apiKey` 以 `model_config.json#models/<entryId>/apiKey` 为上下文加密。读取时解开，运行时视图与模型路由只见明文；明文 Key 照常读取，第一次保存时加密，加密前把原文件复制为 `model_config.json.pre-seal-<时间>`（0600）。解不开的条目（密钥丢失或被替换）`apiKey` 读作 null、记入 `ModelConfig.credentialsNeedingReentry`，设置页显示「凭据需要重新输入」，可用性判定给出同样的提示；文件不被隔离，其余条目照常可用，密文保留到重新填写或用户明确清除为止。sealer 不可用时（凭据库仍需旧密钥）明文保持明文并记日志，不阻塞保存。
- `mcp_config.json`：`headers`、`env` 中名字匹配 `/(key|token|secret|authorization|password)/i` 的值以 `mcp_config.json#servers/<名>/<headers|env>/<字段>` 为上下文加密；只引用环境变量的值（`${VAR}`、`Bearer ${VAR}`）不加密。连接时解开；解不开的值在连接时丢弃（server 报认证失败，不发送密文），在编辑器往返与具名修改里原样保留。第一次加密时同样保留 `mcp_config.json.pre-seal-<时间>`。
- 设置页的 Key 只以 `***` 加末 4 位到达 renderer，编辑器占位显示「已保存 ···1234」。

## Git 控制文件与 Emperor 内部 Git

仓库自己的 Git 配置可以让 git 运行任意程序（filter、diff textconv 与外部 diff、merge driver、credential helper、gpg 签名程序、sshCommand、hooks 等）。Emperor 有两道约束：

- **Emperor 自己执行的 git**（回合快照、审查面板、worktree、委派快照与整合、PR 浏览）都经过 `HardenedGitRunner`：不读系统与全局配置（`GIT_CONFIG_NOSYSTEM`、`GIT_CONFIG_GLOBAL=/dev/null`），hooks 指向 `/dev/null`，禁用 fsmonitor 与 `ext::` 协议；执行前列出仓库生效配置（含 include）里所有会执行程序的键，逐个用 `-c` 换成中性值（textconv 换成 `cat`，签名开关换成 `false`，其余置空）；diff、log、show 一律带 `--no-ext-diff`。仓库配置因此不能借 Emperor 的 git 在沙箱外运行程序。
- **Agent 修改 Git 控制文件**：workspace-write 下，`write` / `edit` 把 `.git/config`、`.git/config.worktree`、`.git/info/attributes`、`.git/hooks/*`（含子模块）视为可写范围之外，改动需要一次性提权批准；受限 Shell 的 Seatbelt profile 拒绝写 `.git/hooks/` 下的文件，`git init` / `git clone` 生成的 `*.sample` 不受影响。

已知限制：受限 Shell 仍可直接改写 `.git/config`（`git clone`、`git remote add`、`git config` 都要写它），这类改动只会影响用户自己在终端里运行的 git，不影响 Emperor 内部的 git。

## 工具执行管线中的决策

单次工具调用的顺序是：参数校验 → pre-execute middleware（取最严格的 allow / ask / deny）→ 需要时审批 → guard → 工具体。Hooks 的 `PreToolUse` 可以返回 deny 或 ask，但不能放宽沙箱。电脑操作工具另经过 `computerUseGate` 和 Plan guard；一次性提权的审批发生在工具体内部、任何副作用之前。

## 用户问题

`ask_user_question` 可以一次提出多个问题，每个问题有稳定 `id`、可选 `header` 和选项，`multi_select: true` 时允许多选，用户也可以给出自定义回答。答案以 `{ answers: [{ id, selected, custom? }] }` 形式作为普通工具结果返回。问题在工具调用内阻塞，直到用户回答、取消或 turn 被中止。

## Plan 模式

`harness/plan/plan-mode.ts` 的 Plan 模式只通过提示词生效：

- 进入：`/plan` 或 `/plan <message>`（同时提交该消息），或 `control.setMode('plan')`。离开：`/plan off`，或 `exit_plan_mode` 获得批准。
- 进入后系统提示词加入 `plan:policy` 章节：先只读探索，不修改文件、不改配置、不提交；只对用户拥有的选择使用 `ask_user_question`；最终以 `exit_plan_mode` 提交以 `#` 标题开头的完整计划。
- 工具目录在 Plan 模式下保持不变，以维持请求缓存；普通文件与 Shell 工具没有统一的 Plan guard，实际写入仍受当前沙箱模式约束。电脑操作工具另有硬性 Plan guard：观察可用，交互、跳转、传输和高影响动作拒绝。
- `exit_plan_mode` 通过问题服务发起审阅，选项为 **Approve** 与 **Keep planning**。Approve 离开 Plan 模式，从下一步开始执行计划；Keep planning 保留 Plan 模式，并把用户的反馈（`control.commentPlan`）作为工具结果返回给模型。用户关闭审阅（改为输入自己的话）时保持 Plan 模式，工具返回成功结果并直接结束本轮（`turn/end` 原因为 `plan-dismissed`），不再为“等待用户”多请求一次模型；审阅通道不可用时同样保持 Plan 模式，原因作为工具错误返回给模型。
- turn 运行中请求的切换会排队，在下一个 step 边界以一条 `plan/mode` 事件生效；用户发起的切换会以通知告知模型。

Plan 模式与权限预设相互独立：在 Plan 模式中切换预设，只改变之后的写入范围。

## 电脑操作授权

`ComputerUseService` 是内置浏览器、外部浏览器和桌面驱动的唯一执行入口。总开关默认关闭，各驱动另有开关；关闭的驱动保留工具，调用返回 `CAPABILITY_DISABLED`。开启后，目标由当前会话持有，动作需要有效租约、目标 generation 和观察 revision。普通文件或 Shell 权限预设本身不授予 GUI 目标控制权；反过来，电脑操作总开关也不限制 Shell。

总开关打开后由 AI 连续操作（2026-09-29 起）：普通观察、交互、跳转和传输自动允许，身份的 `fullAccess` 就是总开关本身，与 Shell 预设独立。不再有逐项授权模式、人工暂停 / 接管 / 交还和控制浮层；旧版本保存的 `scoped` 设置在升级时让总开关关闭一次，并在设置页说明原因。只有三类情况暂停：高影响动作和凭据代填弹出 `grant_` 确认卡（每次都问，只允许这一次；凭据的绑定、字段类型与本地加密可用性在弹卡前检查，用户拒绝一次代填只记住该站点的代填），以及模型通过 `ask_user_question` 提问。子代理可执行普通动作，但不能弹卡：高影响动作和凭据代填返回 `PERMISSION_REQUIRED`（原因 `subagent-cannot-ask`），由父任务处理。

保护名单只有内置的系统名单（`protected-apps.ts`：授权弹窗与密码框、钥匙串访问、“密码”、系统设置、登录窗口和 Emperor 自身），不可配置；保护的应用从列表中隐藏且返回 `TARGET_FORBIDDEN`，其余应用都可以操作。用户追加的保护、高风险与不截图名单已于 2026-10-01 取消：`config.json` 里的旧 `appLists` 不校验、写回一次去掉，其中的保护应用记入 `retired-protected-apps.json`，供设置页提示一次（`computerUse.acknowledgeRetiredApps`）。

`computerUseGate` 在工具执行前准备授权决定，`UiActionPolicy` 处理风险等级和主体，驱动在副作用前再次检查目标身份和版本。授权询问使用 `grant_` 交互，决定和动作状态进入 session log；无应答方、取消或关闭总开关均按拒绝处理。动作日志区分 prepared、dispatched 与 settled；若已经派发而结果无法确认，返回 `OUTCOME_UNKNOWN`，恢复时不重放该动作。

**任务结束释放。** 根会话的 turn 结束且其下没有运行中的后台子代理时（或此后最后一个子代理结束时），宿主调用 `releaseTask`：中止并等待在途动作（已派发的记 `OUTCOME_UNKNOWN`，不重放）；桌面窗口依次停录制流、`input.releaseAll`、`front.restore`（仅本任务激活过的窗口，须在解绑前）、`target.release`；内置浏览器标签页保留页面，只让 ref 失效，下一任务可用 `browser_tab_select` 取回；外部 Chrome 标签页只解除认领，保持扩展连接；once 授权撤销。全部完成后目标同时进入 `released` 状态，预览整组消失；session log 记录 `ui/target-released` 与 `ui/task-released`。旧句柄返回 `STALE_TARGET`（原因 `released-at-task-end`），与“窗口已关闭”区分。释放失败的目标禁止新动作并带 `releaseFailed`，桌面失败时断开 Helper 连接以终止录制流。`ask_user_question` 在 turn 内阻塞，等待回答不会触发释放；关闭总开关、删除会话走同一流程，随后关闭剩余的内置页面。

应用窗口重载期间 Agent 目标暂停，窗口加载完成后由主进程恢复；这期间页面打开的弹窗随之暂停和恢复。紧急停止（快捷键、程序坞菜单、菜单栏图标、`computerUse.stop` / `resume`）与授权挂起已于 2026-10-01 取消：要让 Agent 停下，停止回合或关闭总开关；旧会话日志里的 `emergency-stop` 事件仍可读取。具体使用和已开放范围见[电脑操作（实验）](../user/computer-use.md)。

## CoreApi mutation guard

`packages/core/src/api/mutation-guard.ts` 保护由界面发起的状态修改（Scheduler、Skills、Plugins、模型与 MCP 配置、Task 取消等）：调用方显示的会话（每次调用带的 `view`，见 [Agent 执行链路](agent-runtime.md#选中会话只决定显示)）有待处理交互时返回 409，处于 Plan 模式时返回 403；界面没有显示会话（`view.sessionId` 为 null）时不拦截，进程内调用不带 `view` 时返回 `SESSION_REQUIRED`。外部子会话与任务的控制由所属会话自己的状态把关。Git 写操作另外通过 workspace mutation coordinator 按 worktree 串行。

## 用户直控 Terminal

右侧工作台的「终端」（Terminal）是用户直接操作的系统 Shell，不属于 Agent 工具调用，不经过沙箱或审批，也不进入聊天记录、模型上下文或 session log。Core 仍校验 owner session、项目初始 cwd 和 terminal ID，并在 session 或应用关闭时清理。

## 修改时必须同步

- 新预设或旋钮：`harness/approval/presets.ts`、`commands/builtins.ts` 的 `PERMISSION_PRESET_VALUES`、renderer 权限选择器和用户文档。
- 新受限工具：复用 `harness/sandbox/escalation.ts` 的 `escalationFields` 与 `approveEscalation()`，不要自建审批通道。
- 新的直接读写路径的工具：按 `classifyProtectedPath()` 处理受保护路径表；新增表项同时影响 Seatbelt profile、文件与搜索工具。
- 新的配置秘密：经 `SecretSealer` 加密并给出稳定的 `context`，不要直接调用 `LocalSecretStore`，也不要用钥匙串。
- 修改应用配置而非 workspace 文件的工具：参照 `skill_manage` / `mcp_config`，在写入前按沙箱模式判断并调用注入的 `ApprovalService.request()`，拒绝、取消或通道不可用时抛出 `ToolError`。
- 新沙箱后端：`harness/sandbox/backend.ts` 的平台链、profile 生成与拒绝特征测试。
- 新交互类型：`harness/host/interactions.ts`、`harness/projection/interactions.ts`、`control.*` operation 与 renderer 底部面板。

## 外部执行器权限

外部启动不接受任意 env/argv/owner；原生进程采用私有环境和 OS 边界。根与全部活动祖先权限取交集；Plan 拒绝启动，权限收窄停止已有外部执行。stop/close 等待受管资源，无法证明停止时保留 writer 隔离。[边界与认证](external-agent-delegation.md#工作区进程与认证)。
