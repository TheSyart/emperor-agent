# 权限与 Plan 架构

> 文档状态：Active<br>
> 面向读者：Core 开发者、安全审查者、维护者<br>
> 最后核验：2026-10-22（对照 `1bb92495`）<br>
> 事实源：`packages/core/src/sandbox/`、`packages/core/src/harness/sandbox/`、`packages/core/src/mcp/containment.ts`、`packages/core/src/harness/hooks/contained.ts`、`packages/core/src/harness/workflow/process-worker.ts`、`packages/core/src/api/services/session-defaults-service.ts`、`packages/core/src/harness/approval/`、`packages/core/src/harness/plan/plan-mode.ts`、`packages/core/src/harness/questions/`、`packages/core/src/harness/host/interactions.ts`、`packages/core/src/harness/computer-use/`、`packages/core/src/harness/tools/builtin/skill-manage.ts`、`packages/core/src/harness/tools/builtin/mcp-config.ts`、`packages/core/src/api/mutation-guard.ts`、`packages/core/src/workspace/git-runner.ts`、`packages/core/src/security/`、`packages/core/src/config/model-config.ts`、`packages/core/src/mcp/config.ts`

Agent 能做什么由两个独立旋钮决定：**沙箱模式**限制文件写入范围，**审批策略**决定需要批准的操作是否询问用户。用户看到的是把两者打包在一起的**权限预设**。Plan 模式是独立的会话状态，不是第四种权限。

## 权限预设

| 预设                 | 沙箱模式             | 审批策略 | 行为                                                          |
| -------------------- | -------------------- | -------- | ------------------------------------------------------------- |
| `read-only`          | `read-only`          | `ask`    | 可以读取任何文件；任何修改都需要一次经批准的提权              |
| `workspace-write`    | `workspace-write`    | `ask`    | 可以写入当前 workspace 和系统临时目录；更大范围的重试需要批准 |
| `danger-full-access` | `danger-full-access` | `never`  | 不限制文件写入，也不弹出审批；需要审批的操作会被自动拒绝      |

新 session 从 `settings.json` 的 `sessions.defaultPermission` 开始（「设置 › 常规 › 会话 › 新会话的权限」，`sessions.defaults` / `sessions.setDefaults`，默认 `workspace-write`，不认识的值读作默认）；已经有日志的会话保留自己的预设。切换入口是 `/permissions <preset>`、Composer 的权限选择器和 `control.setPermissionMode`。选择记录为 session log 中的 `permission/preset`，随后只记录实际发生变化的 `sandbox/mode` 与 `approval/policy` 事件；当前预设从 log 推导。两个旋钮不对应任何预设时显示为 `custom`，该值不可选择。

每个会话的权限状态完全存放在它的 session log 中；跨 session 的只有上面这个「新会话从哪个预设开始」，没有持久的权限规则，旧版 `settings.json` 的 `permissions.rules` 在读取时被忽略。

## 沙箱模式

| 模式                 | 文件效果                                  |
| -------------------- | ----------------------------------------- |
| `read-only`          | 受限操作不能修改文件                      |
| `workspace-write`    | 只能写入 session workspace 与系统临时目录 |
| `danger-full-access` | 除受保护路径表外不限制文件效果            |

执行方式：

- `write` / `edit` 在进程内做路径围栏：`read-only` 直接拒绝；`workspace-write` 在写入前重新解析真实路径（能发现被替换的符号链接祖先），要求目标位于可写根内。
- `bash` 在受限模式下通过 OS 沙箱运行：macOS 使用 Seatbelt（`sandbox-exec`）。产品只发布 macOS；代码里另有 Linux 的 bubblewrap 后端（启动时做一次功能探测），没有后端的平台在 `read-only` 与 `workspace-write` 下启动前失败（fail closed）。
- 受限 `bash` 主要限制文件写入，并拒绝向 Apple Events、WindowServer 和 Helper socket 发起部分连接；普通文件读取与互联网访问没有普遍禁止。读写都受下文「受保护路径」一表约束：`read`、`edit`、`write`、`glob`、`grep` 不经过 Shell 沙箱，但与 Seatbelt 共用这一张表（`sandbox/protected-state.ts`）。`danger-full-access` 下的 `bash`（包括一次经批准的提权）在 macOS 上也跑在只含这张表的 Seatbelt profile 里（`LocalSandbox.guard`），Seatbelt 起不来时 fail closed（`SANDBOX_UNAVAILABLE`，不会不带守护地运行）；Linux 与其他平台没有这层守护。
- Shell 之外由 Emperor 启动的进程——MCP stdio server、插件 Hook、工作流脚本——与 Shell 共用同一套进程隔离（下一节）。托管环境不再在应用内安装（`environment.createInstallPlan` / `environment.install` 返回 `OperationRetiredError`），没有安装器进程。
- `memory_edit`、`scheduler`、MCP 工具调用本身与 Skill 加载不经过文件沙箱，也不需要审批；Memory 是应用状态，MCP 工具的能力由 server 决定，server 进程本身在进程隔离里运行。
- `skill_manage`（Skills 文件夹）与 `mcp_config`（`mcp_config.json`）同样不经过文件沙箱，但写入动作跟随权限预设：沙箱模式为 `danger-full-access` 时直接执行，其他模式下每次写入都通过 `ApprovalService` 询问一次，审批策略为 `never` 时被拒绝。查看类动作（`list`、`validate`、`reload`）不询问。

Chat 会话的 workspace 是 `stateRoot/workspace/` 下的可写目录；Build 会话的 workspace 是绑定的项目目录。

## 统一进程隔离（SEC-08）

`packages/core/src/sandbox/policy.ts` 是唯一的进程隔离实现：`ContainmentPolicy` 描述一个进程能读、能写、能连什么，同一个生成器把它变成 Seatbelt profile（macOS）或 bwrap 参数（Linux），`ContainmentBackend` 选择 runner、包装 argv、返回 `ContainmentReceipt`。`harness/sandbox/backend.ts`（Shell 的 `LocalSandbox`）与 `environment/sandbox.ts`（受管进程的 `OsSandboxController`）只是适配层，自己不生成任何 profile（`sandbox/policy.test.ts` 的架构断言）。

```ts
interface ContainmentPolicy {
  read: { allow: 'all' | string[]; deny: string[] }
  write: { allow: 'all' | string[]; deny: string[] } // 'all' 只用于 full-access 守护
  network: 'allow' | 'deny'
  tempDir: string // 进程的 TMPDIR / TMP / TEMP
  toolchainReadOnly: string[] // PATH 目录、node / python / uv / bun / deno / pnpm / yarn 安装目录、/opt/homebrew、/usr/local、/opt/local
  ancestorsMetadata: boolean // 允许 lstat 每个可读目录的各级父目录
  fallback: 'refuse' | 'ask-user' // 没有静默的无沙箱回退
  protectedPaths: { stateRoot; home; credentialReads: 'deny' | 'allow' } | null // 下文「受保护路径」的表
  grantedFiles?: string[] // 宿主授予的单个文件（AGT-03 的 Codex auth.json）
  desktop: 'allow' | 'deny' // Apple Events 与 WindowServer
  deniedSocketDirs: string[] // Emperor 自己的 Helper socket 目录
  boundaryTag?: string // AGT-04 诊断模式的边界标记
}
interface ContainmentReceipt {
  backend: 'seatbelt' | 'bwrap' | 'none'
  decision: 'contained' | 'refused' | 'user-allowed-unsandboxed'
  policyHash: string
  reason: string
}
```

Seatbelt 取最后一条匹配的规则，所以 profile 分层写：宽泛放行 → 例外（`deny`，例如 Emperor Home）→ 例外里的授权（缓存、插件目录）→ 受保护路径表，任何授权都打不开最后一层。读为列表时以 `(deny file-read*)` 加 `(import "system.sb")` 开头，再放行系统目录、工具链与列出的目录。

| 进程                                         | 读                                                                                                              | 写                                      | 网络 | 桌面 | 沙箱不可用时                                |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------- | ---- | ---- | ------------------------------------------- |
| `bash`（受限模式）                           | 全部（受保护路径表除外）                                                                                        | 模式的可写根（不变）                    | 允许 | 拒绝 | `SANDBOX_UNAVAILABLE`                       |
| `bash`（`danger-full-access`，macOS）        | 全部（`state` / `config` 除外）                                                                                 | 全部（受保护路径表除外）                | 允许 | 允许 | `SANDBOX_UNAVAILABLE`                       |
| 插件的 MCP stdio server                      | 系统、工具链、workspace、插件包（`stateGrants.read`）、工作目录、缓存                                           | workspace、插件数据目录、缓存           | 允许 | 允许 | 拒绝启动（`mcp_sandbox_refused`，写明原因） |
| 用户的 MCP stdio server（`mcp_config.json`） | 系统、工具链、workspace、工作目录、缓存，以及参数里的绝对路径（目录可写；文件开放其项目目录供读取）；没有插件包 | workspace、缓存、参数里的目录、工作目录 | 允许 | 允许 | 询问一次（下文），记住答案                  |
| 插件 Hook（环境与超时见下）                  | 系统、工具链、workspace（只读）、插件包                                                                         | `plugins/data/<id>`、`plugins/tmp/<id>` | 允许 | 拒绝 | 不运行（非阻塞的 Hook 错误）                |
| 工作流脚本（`workflow` / `ralph`，KRN-09）   | 系统、工具链、Node / Electron 运行文件、自己的临时目录（没有 workspace）                                        | 自己的临时目录                          | 拒绝 | 拒绝 | 不运行（`AGENT_START`）                     |

- **Shell 不变**：Shell 的 profile 仍是 allow-all 读、受保护路径表与原来的写策略。`sandbox/__golden__/*.pre-sec08.sb` 保存 SEC-08 之前的 Shell / 委派 profile，golden 测试要求新 profile 保留每一条旧规则且顺序不变，新增的只能是 `deny`（目前为零）。其他消费者的 profile 文本也有 golden（`mcp-user.sb` 等）。
- **MCP 缓存**：每个 server 有自己的 `<stateRoot>/mcp/cache/<名>`，同时是 `npm_config_cache`、`UV_CACHE_DIR` 与 `TMPDIR`（另有 `UV_TOOL_DIR=<缓存>/uv-tools`，uvx 会在工具目录里放锁文件），所以 `npx -y`、`uvx` 不需要写 `~/.npm`、`~/.cache`。PATH 里的每个目录（真实路径与写法本身，含符号链接）可读，否则在不可读目录里查找命令会以 EPERM 而不是 ENOENT 结束搜索；`~/.npmrc`、`~/.yarnrc`、`~/.yarnrc.yml`、`~/.config/uv`、`~/.local/share/uv`、pip 配置只读开放，镜像与私有源设置照常生效。第一次启动要把包下载进新缓存，可能超过 15 秒的连接时限；下载在后台继续，重新连接时就快了。
- **来源**：只有 `mcp_config.json` 里点名的 server 算用户的；插件的、按项目实例里的 server 一律按插件处理（`fallback: 'refuse'`）。stdio server 没有任何不经隔离的启动路径：没有受管进程运行时的连接直接失败。
- **询问**：沙箱不可用时，用户的 server 不启动，进入 `UnsandboxedConsentRegistry` 的待答列表（状态 `mcp_sandbox_consent_required`）。宿主在下一次用户会话的步骤开始前（`middleware.preAssemble`；后台 turn、子智能体和审批策略为 `never` 的会话不问）用普通审批卡询问一次，卡上写明 server、原因和命令。「允许本次」与「拒绝」都按 server 与命令（指纹）记在 `processes/unsandboxed-consent.v1.json`，允许后当步重新加载 MCP，工具在这一步就可用；关闭卡片不记住，下次再问；命令改了就重新询问。
- **回执**：经 `OwnedProcessRuntime` 启动的进程（MCP stdio server 与插件 Hook）每次启动——包括被拒绝的——都在 `processes/receipts.v1.json` 留下 `ContainmentReceipt`（被拒绝的状态为 `refused`，不启动进程）；Shell 和工作流脚本不写回执。旧版本的回执（`sandboxed` / `unsandboxed` / `denied`）读取时换成新词。诊断页「运行时 › 进程隔离回执」读最新 20 条，显示计数和最多 5 条明细：来源（MCP / Hook）、id、`已隔离 / 已拒绝 / 经同意未隔离`、runner、策略哈希前 12 位与被拒绝的原因；有被拒绝或经同意未隔离的就标为警告。
- **工作流脚本**：不经 `OwnedProcessRuntime`，直接调 `ContainmentBackend.prepare`（模块级的 backend，`workflow/engine.ts`），所以没有回执；宿主构造 `WorkflowEngine` 时不传 `stateRoot`，`protectedPaths` 为 null，靠默认拒读（只开放系统、工具链和自己的临时目录）保护 Emperor Home 与凭据。内存上限 512 MB，最长 30 分钟，见 [Agent 执行链路](agent-runtime.md#子智能体与后台任务)。
- **插件 Hook 的环境与超时（SEC-07）**：插件 Hook 的进程只拿到安全键（`PATH`、`HOME`、`USER`、`SHELL`、`LANG`、`LC_ALL`、`TERM`、`PWD` 等，与 MCP stdio server 同一张 `SAFE_ENV_KEYS`）、插件清单 `env` 声明的变量（取自 Emperor 的环境）、`PLUGIN_ROOT` / `PLUGIN_DATA` 及其 `CLAUDE_` 别名、`CLAUDE_PROJECT_DIR`，`TMPDIR` / `TMP` / `TEMP` 由隔离设为插件的临时目录；默认 30 秒，Hook 自己的 `timeout` 最多算 120 秒，超时按 Hook 失败处理，工具调用照常继续。每个插件 Hook 最近一次失败（原因与可能缺的变量）记在内存的 `PluginHookHealth`，插件详情显示它。细节与清单写法见[扩展 Emperor › 插件 Hook 的运行环境](../development/extending-emperor.md#插件-hook-的运行环境)。
- **项目插件意图（SEC-07）**：项目与本地项目范围的插件启用意图记在 `<stateRoot>/projects/<project-id>/plugins.json`，不读写 workspace 里 Agent 可写的 `.emperor/settings*.json`；仓库 `.emperor/settings.json` 的 `enabledPlugins` 只在能力页生成「该项目建议启用 X」，由用户确认（`plugins.setEnabled`，经 mutation guard）后才写入 stateRoot。Agent 没有改插件启用状态的工具。该文件与 `installed_plugins.json`、`plugins/managed.json` 一样在 Agent 的默认可写根之外，但不在受保护路径表里：常设 `danger-full-access` 的 Shell 能写到它们（与能改插件缓存一样）。
- **不在范围内**：环境探测（`node --version` 之类）和 Emperor 自己的 git / gh 仍直接运行：它们是目录里写死的系统命令（git 另有下文的加固）。用户在 `hooks.json` 里自己写的 Hook 也照旧直接运行，环境变量完整、默认 10 分钟超时（用户可信）。

## 一次性提权

`bash`、`write`、`edit` 的参数都可以带 `sandbox_permissions`（`workspace-write` 或 `danger-full-access`）和一句 `justification`。请求的模式必须严格宽于当前有效模式；审批服务向用户询问一次，只有 `allowed-once` 才让这一次调用以更宽的模式执行，授权不会延续到之后的调用。`read` 也接受这对参数，但只用于读取凭据文件（见下节）：它要求 `danger-full-access`，审批理由写明文件（`escalate sandbox to danger-full-access to read credentials (~/.ssh/config): …`）。`bash` 请求 `danger-full-access` 时，命令文本里能认出的凭据路径（`~/…`、`$HOME/…`、`${HOME}/…` 或展开的家目录）同样写进审批理由；这只是提示，实际约束由 Seatbelt 执行。写入受保护路径的 `write` / `edit` 在询问之前就被拒绝，不会弹出无意义的审批。

审批策略为 `never` 时，需要审批的请求被确定性地拒绝，系统提示词也会告诉模型不要请求提权。子智能体的审批策略固定为 `never`，因此子智能体内的提权总是被拒绝。

每次询问在 session log 中记录为 `approval/asked` 与 `approval/decided`。结果只可能是 `allowed-once`、`rejected`、`cancelled` 或 `unavailable`；应答方缺失或出错时 fail closed 为 `unavailable`，崩溃修复会把没有决定的询问关闭为 `unavailable`。

## 受保护路径与配置加密

`sandbox/protected-state.ts` 定义一张表，分三类：

| 类别         | 路径                                                                                                                                                                                                                                                                                | 读                                          | 写  |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | --- |
| `state`      | `<stateRoot>/computer-use`、`<stateRoot>/browser`                                                                                                                                                                                                                                   | 拒                                          | 拒  |
| `config`     | `<stateRoot>` 下直接以 `model_config`、`mcp_config`、`settings.json`、`hooks.json` 开头的文件（含 `.pre-seal-*`、`.tmp-*`、`.corrupt-*` 等）                                                                                                                                        | 拒                                          | 拒  |
| `credential` | `~/.ssh`、`~/.aws`、`~/.config/gcloud`、`~/.docker/config.json`、`~/.netrc`、`~/.codex/auth.json`、`~/.claude/.credentials.json`；`<stateRoot>/delegations/claude-code/config/.credentials.json`（Claude Code 在专用目录里自己保存的登录，AGT-12；只对 Claude Code 自己的运行放行） | 仅 `danger-full-access`（常设或一次性提权） | 拒  |

- 文件工具：`write` / `edit` 对三类都返回 `FS_PROTECTED_PATH`，任何模式、任何提权都一样；`read` 对 `state` / `config` 返回 `FS_PROTECTED_PATH`，对 `credential` 在受限模式下返回 `FS_SANDBOX_DENIED` 并提示带 `sandbox_permissions="danger-full-access"` 重试。判断按真实路径（符号链接、大小写、`/System/Volumes/Data` 别名），再按文件身份（硬链接）。
- 搜索工具：搜索根落在表内时报 `SEARCH_PROTECTED_PATH`，从上级目录搜索时略过表内条目；`credential` 只在 `danger-full-access` 下可搜，搜索不提供提权。
- Seatbelt：受限 profile 在所有放行规则之后追加 `(deny file-read* file-write* …)`（`state`、`config`）与凭据规则（受限模式读写都拒，`danger-full-access` 只拒写）；`config` 用以 Emperor Home 真实路径开头的正则匹配。Emperor Home 和凭据路径的各级父目录追加 `(deny file-write* (literal …))`，防止把整个目录改名移出规则（目录里照常可以新建文件）。宿主通过 `SandboxExecutionPolicy.writableFiles` 授给外部子智能体的单个文件（AGT-03 的 Codex `auth.json`）在凭据规则之后重新放行读写，所以 Emperor 启动的 Codex 进程仍能读取并原地刷新用户的 `auth.json`；Agent 自己的 Shell 没有这项授权。`state` / `config` 规则排在放行之后，宿主授权也打不开它们。
- 已知影响：默认预设下 Agent 的 Shell 读不到 `~/.ssh`，经 SSH 的 git、`aws`、`gcloud`、带私有仓库凭据的 `docker` 需要一次提权或在用户终端运行；委派给 Claude Code / Codex 的子进程同样读不到这些位置（它们不能提权）。Claude 的 `.credentials.json` 由 Core 进程读取后以环境变量传入子进程，不受影响。MCP stdio server 与插件 Hook 的进程同样受这张表约束（统一进程隔离）。
- 不在表里、但在 Agent 默认可写根之外的 Emperor 文件：`processes/unsandboxed-consent.v1.json`（沙箱外运行 MCP server 的同意记录）、`delegations/consent.json`（「以后都允许」）与 `delegations/credentials.json`（加密的 Claude Code 令牌），以及插件状态文件。常设 `danger-full-access` 的 Shell 能写到它们。

配置里的秘密不再明文落盘（SEC-06）：

- 端口 `SecretSealer`（`security/secret-sealer.ts`）：`seal(plain, context) → "el1:<base64>"`、`open(sealed, context)`、`available`。实现基于 `security/local-secret-store.ts` 的 `LocalSecretStore`（AES-256-GCM，密钥文件 `<stateRoot>/computer-use/secrets/local.key`，从不使用钥匙串）；`context` 进入关联数据，值换到别的字段就解不开。桌面主进程把凭据库同一个 `LocalSecretStore` 实例包成 sealer 传给 Core（`KeptServicesOptions.secretSealer`）；没有主进程时（ACP、headless）Core 用同一个密钥文件自建（`createLocalKeySealer`），连「密钥丢失而凭据库仍有密文时不新建密钥」这条规则也一样（读 `vault.json` 判断）。
- `model_config.json`：每条 `apiKey` 以 `model_config.json#models/<entryId>/apiKey` 为上下文加密。读取时解开，运行时视图与模型路由只见明文；明文 Key 照常读取，第一次保存时加密，加密前把原文件复制为 `model_config.json.pre-seal-<时间>`（0600）。解不开的条目（密钥丢失或被替换）`apiKey` 读作 null、记入 `ModelConfig.credentialsNeedingReentry`，设置页显示「凭据需要重新输入」，可用性判定给出同样的提示；文件不被隔离，其余条目照常可用，密文保留到重新填写或用户明确清除为止。sealer 不可用时（凭据库仍需旧密钥）明文保持明文并记日志，不阻塞保存。
- `mcp_config.json`：`headers`、`env` 中名字匹配 `/(key|token|secret|authorization|password)/i` 的值以 `mcp_config.json#servers/<名>/<headers|env>/<字段>` 为上下文加密；只引用环境变量的值（`${VAR}`、`Bearer ${VAR}`）不加密。连接时解开；解不开的值在连接时丢弃（server 报认证失败，不发送密文），在编辑器往返与具名修改里原样保留。第一次加密时同样保留 `mcp_config.json.pre-seal-<时间>`。
- 设置页的 Key 只以 `***` 加末 4 位到达 renderer，编辑器占位显示「已保存 ···1234」。
- 本地密钥文件与其目录的检查（SEC-09）：须为当前用户所有且 `(mode & 0o077) === 0`，任意只属于本人的权限（如 `chmod -R 700` 后的 0700）都可用；组或其他人有权限时为 `key-permissions`，sealer 不可用、凭据库停用，直到用户在密码管理器点「修复权限」（`LocalSecretStore.repairPermissions`，只改权限，属主或内容不对的仍是 `key-invalid`）。新密钥 `link(2)` 发布后 fsync 所在目录。凭据库导入备份时只在没有本地密钥的地方安装备份里的密钥（`installKey`），从不覆盖已有密钥，所以已加密的模型 Key 与 MCP 令牌不会因为导入而解不开。

## Git 控制文件与 Emperor 内部 Git

仓库自己的 Git 配置可以让 git 运行任意程序（filter、diff textconv 与外部 diff、merge driver、credential helper、gpg 签名程序、sshCommand、hooks 等）。Emperor 有两道约束：

- **Emperor 自己执行的 git**（回合快照、审查面板、worktree、委派快照与整合、PR 浏览）都经过 `HardenedGitRunner`：不读系统与全局配置（`GIT_CONFIG_NOSYSTEM`、`GIT_CONFIG_GLOBAL=/dev/null`），hooks 指向 `/dev/null`，禁用 fsmonitor 与 `ext::` 协议；执行前列出仓库生效配置（含 include）里所有会执行程序的键，逐个用 `-c` 换成中性值（textconv 换成 `cat`，签名开关换成 `false`，其余置空）；diff、log、show 一律带 `--no-ext-diff`。仓库配置因此不能借 Emperor 的 git 在沙箱外运行程序。中性值按键选取：`false`（`filter.*.required`、`*.gpgsign`、fsmonitor）、`/dev/null`（hooksPath、attributesFile）、`cat`（pager、textconv）、`git-upload-pack` / `git-receive-pack`（uploadpack / receivepack）、`ssh`（`ssh.variant`），其余置空；另外总带 `--no-pager`，`GIT_PAGER` / `PAGER` 为 `cat`，`GIT_TERMINAL_PROMPT=0`。git 进程只拿到白名单里的环境变量（`PATH`、`HOME`、临时目录、语言等，外加调用方点名的 `GIT_INDEX_FILE`、`GIT_AUTHOR_*` 等），`HOME` / `XDG_*` 指向 `<stateRoot>/git/runtime-home`；fetch、pull、push、clone、ls-remote、submodule 只有调用方声明 `network: true` 时才允许。已知局限：配置扫描按工作目录缓存 1.5 秒，这段时间里新加进仓库配置的键不会被中和；只有工作目录或其上级有 `.git` 时才扫描。
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
- 工具目录在 Plan 模式下保持不变，以维持请求缓存；普通文件与 Shell 工具没有统一的 Plan guard，实际写入仍受当前沙箱模式约束。有硬性限制的只有：电脑操作工具（观察可用，交互、跳转、传输和高影响动作拒绝）；外部子智能体只能以 `shared-readonly` 做只读审查，要写的以 `PLAN_MODE_UNSUPPORTED` 拒绝；工作流里的子智能体只读；以及下文 mutation guard 的 403。
- Composer 在目标进行中切到计划模式时，先取消这个目标（`composerLifecycle.ts`，原因 `user_switch_to_plan`），再开启 Plan 模式。
- 起始页（还没发出第一条消息的草稿）上的计划模式与权限预设属于草稿本身，界面不调用 Core（FIX-13）。Core 在为草稿创建会话时让它们生效：`chat.submit`、`goals.start` 的 `draftSession.plan` / `draftSession.preset`，以及输入命令时 `sessions.create` 的 `plan` / `preset`。预设与默认预设一样作为创建时的事实记入（`host.pinPermissionPreset`，不通知模型），计划模式随后提交（新会话没有进行中的回合，立即写入 `plan/mode`），两者都在 `session_created` 发出和第一轮之前，所以第一步就在 Plan 模式里。`goals.start` 只带预设，不带计划模式（计划和目标互斥）。
- `exit_plan_mode` 通过问题服务发起审阅，Core 的选项为 `Approve` 与 `Keep planning`，界面显示为「批准并执行」「继续规划」，右上角 ×「忽略」。批准离开 Plan 模式，从下一步开始执行计划；继续规划保留 Plan 模式，把用户的反馈（`control.commentPlan`）以工具错误 `PLAN_REJECTED` 返回给模型。用户关闭审阅（改为输入自己的话）时保持 Plan 模式，工具返回成功结果并直接结束本轮（`turn/end` 原因为 `plan-dismissed`），不再为“等待用户”多请求一次模型；审阅通道不可用时同样保持 Plan 模式，原因作为工具错误返回给模型。
- turn 运行中请求的切换会排队，在下一个 step 边界以一条 `plan/mode` 事件生效；用户发起的切换会以通知告知模型。

Plan 模式与权限预设相互独立：在 Plan 模式中切换预设，只改变之后的写入范围。

## 电脑操作授权

`ComputerUseService` 是内置浏览器、外部浏览器和桌面驱动的唯一执行入口。总开关默认关闭，各驱动另有开关；关闭的驱动保留工具，调用返回 `CAPABILITY_DISABLED`。开启后，目标由当前会话持有，动作需要有效租约、目标 generation 和观察 revision。普通文件或 Shell 权限预设本身不授予 GUI 目标控制权；反过来，电脑操作总开关也不限制 Shell。

总开关打开后由 AI 连续操作（2026-09-29 起）：普通观察、交互、跳转和传输自动允许，身份的 `fullAccess` 就是总开关本身，与 Shell 预设独立。不再有逐项授权模式、人工暂停 / 接管 / 交还和控制浮层；旧版本保存的 `scoped` 设置在升级时让总开关关闭一次，并在设置页说明原因。只有三类情况暂停：高影响动作和凭据代填弹出 `grant_` 确认卡（每次都问，只允许这一次；凭据的绑定、字段类型与本地加密可用性在弹卡前检查，用户拒绝一次代填只记住该站点的代填），以及模型通过 `ask_user_question` 提问。子智能体可执行普通动作，但不能弹卡：高影响动作和凭据代填返回 `PERMISSION_REQUIRED`（原因 `subagent-cannot-ask`），由父任务处理。

保护名单只有内置的系统名单（`protected-apps.ts`：授权弹窗与密码框、钥匙串访问、“密码”、系统设置、登录窗口和 Emperor 自身），不可配置；保护的应用从列表中隐藏且返回 `TARGET_FORBIDDEN`，其余应用都可以操作。用户追加的保护、高风险与不截图名单已于 2026-10-01 取消：`config.json` 里的旧 `appLists` 不校验、写回一次去掉，其中的保护应用记入 `retired-protected-apps.json`，供设置页提示一次（`computerUse.acknowledgeRetiredApps`）。

`computerUseGate` 在工具执行前准备授权决定，`UiActionPolicy` 处理风险等级和主体，驱动在副作用前再次检查目标身份和版本。授权询问使用 `grant_` 交互，决定和动作状态进入 session log；无应答方、取消或关闭总开关均按拒绝处理。动作日志区分 prepared、dispatched 与 settled；若已经派发而结果无法确认，返回 `OUTCOME_UNKNOWN`，恢复时不重放该动作。

**任务结束释放。** 根会话的 turn 结束且其下没有运行中的后台子智能体时（或此后最后一个子智能体结束时），宿主调用 `releaseTask`：中止并等待在途动作（已派发的记 `OUTCOME_UNKNOWN`，不重放）；桌面窗口依次停录制流、`input.releaseAll`、`front.restore`（仅本任务激活过的窗口，须在解绑前）、`target.release`；内置浏览器标签页保留页面，只让 ref 失效，下一任务可用 `browser_tab_select` 取回；外部 Chrome 标签页只解除认领，保持扩展连接；once 授权撤销。全部完成后目标同时进入 `released` 状态，预览整组消失；session log 记录 `ui/target-released` 与 `ui/task-released`。旧句柄返回 `STALE_TARGET`（原因 `released-at-task-end`），与“窗口已关闭”区分。释放失败的目标禁止新动作并带 `releaseFailed`，桌面失败时断开 Helper 连接以终止录制流。`ask_user_question` 在 turn 内阻塞，等待回答不会触发释放；关闭总开关、删除会话走同一流程，随后关闭剩余的内置页面。

应用窗口重载期间 Agent 目标暂停，窗口加载完成后由主进程恢复；这期间页面打开的弹窗随之暂停和恢复。紧急停止（快捷键、程序坞菜单、菜单栏图标，以及已删除的 `computerUse.stop` / `computerUse.resume` 操作）与授权挂起已于 2026-10-01 取消：要让 Agent 停下，停止回合或关闭总开关；旧会话日志里的 `emergency-stop` 事件仍可读取。具体使用和已开放范围见[电脑操作（实验）](../user/computer-use.md)。

## CoreApi mutation guard

`packages/core/src/api/mutation-guard.ts` 只保护**属于某个对话**的、由界面发起的写入：给子智能体发消息、应用或丢弃它的成果（`delegations.*`，按任务所属的主会话判断），以及把后台进程转给别的属主（`processes.reparent`）。这个对话有待处理的提问、权限或计划审批时返回 409（`mutation_blocked_pending`），处于 Plan 模式时返回 403（`mutation_blocked_plan`）。守卫直接读控制状态（v3）：Plan 模式看 `plan` 标志，`mode` 在 v3 里是权限预设。

设置是全局的，不看窗口背后显示的是哪个对话、它处于什么状态（FIX-10）：模型、MCP、Skills、插件、Hooks、定时任务、子智能体、浏览器与电脑操作、存储清理、会话默认值、任务预算、网络工具和用户配置随时可以保存。停止也总是可用：`tasks.cancel`、`processes.cancel`、取消环境安装不经守卫。Plan 模式约束的是 Agent（见上文的工具与子智能体限制），不是用户自己的设置。

守卫与 CoreApi 的其他拒绝（例如进程不属于这个会话 `mutation_forbidden`、状态冲突 `mutation_conflict`）都是 `EmperorError`，错误码与中文说明经 IPC 原样到达界面，不会显示成「发生内部错误」。会话不存在、已删除或是草稿 id（`InvalidSessionError`，`host.agentFor` / `host.scopeFor` 同样抛它）是 `invalid_session`，界面显示「会话不存在或已被删除。」；没有指明会话的 `SESSION_REQUIRED` 只说「请先打开一个会话再试。」，操作名留在错误的 `operation` 字段里。Git 写操作另外通过 workspace mutation coordinator 按 worktree 串行。

## 用户直控 Terminal

右侧工作台的「终端」（Terminal）是用户直接操作的系统 Shell，不属于 Agent 工具调用，不经过沙箱或审批，也不进入聊天记录、模型上下文或 session log。Core 仍校验 owner session、项目初始 cwd 和 terminal ID，并在 session 或应用关闭时清理。

## 修改时必须同步

- 新预设或旋钮：`harness/approval/presets.ts`、`commands/builtins.ts` 的 `PERMISSION_PRESET_VALUES`、renderer 权限选择器和用户文档。
- 新受限工具：复用 `harness/sandbox/escalation.ts` 的 `escalationFields` 与 `approveEscalation()`，不要自建审批通道。
- 新的直接读写路径的工具：按 `classifyProtectedPath()` 处理受保护路径表；新增表项同时影响 Seatbelt profile、文件与搜索工具。
- 新的配置秘密：经 `SecretSealer` 加密并给出稳定的 `context`，不要直接调用 `LocalSecretStore`，也不要用钥匙串。
- 修改应用配置而非 workspace 文件的工具：参照 `skill_manage` / `mcp_config`，在写入前按沙箱模式判断并调用注入的 `ApprovalService.request()`，拒绝、取消或通道不可用时抛出 `ToolError`。
- 新沙箱后端或新的受限进程：只改 `sandbox/policy.ts`（策略、生成器、runner 选择）并补 golden；Shell 的 profile 变化必须仍满足「相对 SEC-08 之前只多 `deny`」，否则说明原因并更新 `__golden__/*.pre-sec08.sb`。Emperor 启动的新进程经 `OwnedProcessRuntime` 与一个 `ContainmentPolicy` 运行，写明 `fallback`，不要自建 profile 或无沙箱回退。
- 新交互类型：`harness/host/interactions.ts`、`harness/projection/interactions.ts`、`control.*` operation 与 renderer 底部面板。

## 外部子智能体权限

外部启动不接受任意 env/argv/owner；原生进程采用私有环境和 OS 边界。根与全部活动祖先权限取交集；Plan 模式下只能启动只读审查，要写的拒绝；权限收窄会中断根会话所有进行中的外部轮次（包括只读的）并解除 Goal 自动续跑。stop/close 等待受管资源，无法证明停止时保留 writer 隔离。[边界与认证](external-agent-delegation.md#工作区进程与认证)。
