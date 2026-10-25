/**
 * Core error codes in Chinese (UI-S10, docs/design/writing.md). What the
 * interface shows for a failed Core call:
 *
 * - Core's own message when it is Chinese — most are, and they name the
 *   exact file, server or branch;
 * - otherwise the text of its code below (MCP, Skills and argument checks
 *   still speak English), followed by the first line of a tool's own output
 *   for git and gh;
 * - otherwise a general sentence. A bare code is never shown.
 *
 * The code, Core's message and the IPC error id stay on the error as
 * `detail`, for copying. errors/messages.test.ts reads every code Core can
 * send from its sources and fails when one is missing here.
 */

export interface CoreErrorFacts {
  readonly code?: string
  readonly message?: string
  readonly errorId?: string
}

export const ERROR_MESSAGES: Readonly<Record<string, string>> = {
  // Core (errors.ts) and IPC
  validation_error: '输入不符合要求，请检查后重试。',
  invalid_core_arguments: '这次请求的参数不正确，请刷新后重试。',
  parse_error: '无法解析返回的内容。',
  store_corrupt: '数据文件已损坏，已改用备份或空数据。',
  data_file_newer: '这个数据文件来自更新版本的 Emperor，当前版本只能读取。',
  operation_retired: '这个操作在当前版本中已停用。',
  context_overflow: '对话超出了模型的上下文长度，请压缩或开始新对话。',
  model_configuration_required: '还没有可用模型，请先配置模型。',
  model_cost_cap_exceeded: '本轮模型费用上限已用尽，请提高上限或开始新一轮。',
  model_provider_auth: '模型认证失败：API Key 无效或没有权限。',
  model_provider_rate_limit: '模型服务触发限流，请稍后重试。',
  model_provider_transient: '模型服务暂时不可用或网络超时，请稍后重试。',
  model_provider_permanent:
    '模型请求失败，请检查模型 ID、API 地址和提供方配置。',
  model_provider_unknown: '模型调用失败，请检查模型配置或稍后重试。',
  SESSION_REQUIRED: '请先打开一个会话再试。',
  invalid_session: '会话不存在或已被删除。',
  interaction_not_pending: '这个问题已经回答过或已失效。',
  turn_paused: '这一轮已暂停。',
  turn_busy: '已有一轮正在运行，请等它结束。',
  cancelled: '操作已取消。',
  interrupted: '操作被中断。',
  persistence_conflict: '数据已被其他操作修改，请刷新后重试。',
  persistence_corrupt: '会话数据已损坏，无法读取。',
  persistence_io: '无法读写会话数据，请检查磁盘空间与权限。',
  persistence_terminal: '会话数据已停止写入，请重新打开 Emperor。',
  process_lease_conflict: '另一个 Emperor 进程正在使用这份数据。',
  process_owner_invalid: '这个后台进程不属于当前会话。',
  command_parse_error: '命令格式不正确。',
  command_invocation_store_corrupt: '命令记录已损坏，已重新开始记录。',
  containment_refused: '操作系统的执行边界拒绝了这个操作。',

  // 定时任务
  scheduler_closed: '定时任务服务已停止。',
  scheduler_queue_capacity: '待执行的定时任务太多，请稍后再试。',
  scheduler_run_cancelled: '这次定时任务已取消。',
  scheduler_run_duplicate: '这个定时任务正在运行。',

  // 目标
  goal_not_found: '当前会话中没有这个目标。',
  goal_objective_invalid: '目标不能为空。',

  // 子智能体（DelegationError）
  INTEGRATION_CONFLICT: '工作区或 Git 索引已改变，请重新生成整合预览。',
  STALE_REVISION: '任务状态已经变化，请刷新后重试。',
  ACCEPTANCE_REQUIRED: '成果或预览还没有通过当前的验证，请重新验证。',
  REQUIRED_DELEGATION_UNVERIFIED: '目标还有必需的子任务没有通过验证。',
  PERMISSION_DENIED: '当前会话没有执行这个操作的权限。',
  PERMISSION_REVOKED: '上级任务的权限已收窄，请检查任务详情。',
  PLAN_MODE_UNSUPPORTED: '计划模式下子智能体只能做只读审查。',
  OUTCOME_UNKNOWN: '还不能确认子智能体已经停止，请检查保留的成果与原生历史。',
  DELIVERY_UNKNOWN: '消息是否送达还不确定，请先查看原生历史，避免重复发送。',
  AUTH_REQUIRED:
    'Claude Code 还没有登录，请在「设置 › 子智能体 › Claude Code」点「登录 Claude Code」。',
  AUTH_EXPIRED:
    'Claude Code 的登录已失效或过期，请在「设置 › 子智能体 › Claude Code」重新登录。',
  AUTH_STATUS_FAILED:
    '读不到 Claude Code 的登录状态，请在「设置 › 子智能体」重新检测。',
  AUTH_SIGN_OUT_FAILED: 'Claude Code 没有退出登录，请稍后重试。',
  EXECUTOR_MISSING:
    '找不到 Claude Code / Codex 的命令行程序，请先安装，或在「设置 › 子智能体」更正路径。',
  EXECUTOR_DISABLED: '请先在「设置 › 子智能体」里启用它。',
  EXECUTOR_INCOMPATIBLE: '命令行程序的版本不在支持范围内。',
  EXECUTOR_UPGRADING:
    '它正在升级，升级完成前不接新的子任务；可以改用本地子智能体。',
  EXECUTOR_UPGRADE_UNAVAILABLE:
    '这个版本不能在这里一键升级，请在「设置 › 子智能体」重新检测后再试。',
  EXECUTOR_ROLLBACK_UNAVAILABLE:
    '这个版本不能在这里一键退回，请在「设置 › 子智能体」重新检测后再试。',
  EXECUTOR_SELF_CHECK_FAILED:
    '这个版本自检不兼容，请在「设置 › 子智能体」退回上一个正常版本，或点「重新检查」。',
  CONTAINMENT_UNAVAILABLE:
    '操作系统的执行边界不可用，请在「设置 › 子智能体」查看诊断。',
  PROTOCOL_FRAMING: '子智能体返回了无法识别的数据。',
  SESSION_LOG_UNRECOVERABLE: '子智能体的会话记录已损坏，无法恢复。',
  EXTERNAL_OPERATION_FAILED:
    '子智能体的操作没有成功，请刷新任务详情并检查保留的日志。',
  subagent_worktree_unavailable: '无法为子智能体创建隔离 worktree。',
  subagent_not_live: '这个子智能体已经结束，不能再发消息。',
  mutation_blocked_pending:
    '这个对话有等你回复的提问或计划审批，先处理它再试。',
  mutation_blocked_plan: '这个对话处于计划模式，先批准计划或退出计划模式再试。',
  mutation_forbidden: '这项操作不属于当前对话，已拒绝。',
  mutation_conflict: '当前对话的状态不允许这项操作，请稍后再试。',

  // 工作区与文件
  workspace_project_required: '当前会话没有绑定项目。',
  workspace_session_invalid: '当前会话不拥有这个项目工作区。',
  workspace_path_invalid: '路径必须位于当前项目内。',
  workspace_path_missing: '文件或目录不存在。',
  workspace_path_not_directory: '目标路径不是目录。',
  workspace_path_not_file: '目标路径不是文件。',
  workspace_media_unsupported: '这个文件不能在应用里播放。',
  workspace_agent_running: '这个工作区有 Agent 正在运行，等它结束后再试。',
  turn_already_reverted: '这些改动已经撤销过。',
  turn_file_not_recorded: '这份改动记录里没有这个文件。',
  turn_file_unknown: '这个文件不在这份改动记录里。',
  turn_files_unavailable: '没有可查看或撤销的改动记录。',
  turn_snapshot_dropped: '这份改动记录的快照已经清理。',

  // 终端
  terminal_unavailable: '当前环境不能打开终端。',
  terminal_capacity_reached: '这个会话打开的终端已达上限。',
  terminal_exited: '终端进程已退出。',
  terminal_input_too_large: '一次输入的内容太长。',
  terminal_owner_invalid: '终端不存在或不属于当前会话。',

  // Git
  git_unavailable: '当前环境中没有可用的 Git。',
  git_command_failed: 'Git 命令失败',
  git_argument_invalid: 'Git 参数不合法。',
  git_repository_invalid: '这里不是可用的 Git 仓库。',
  git_active_writer: 'Agent 正在修改项目，Git 操作已暂停。',
  git_confirmation_required: '这个操作需要你明确确认。',
  git_env_not_allowed: 'Git 命令不接受这个环境变量。',
  git_network_not_authorized: '这个 Git 操作需要联网，请先允许。',
  git_output_too_large: 'Git 输出超过安全读取上限，请在终端里处理。',
  git_repository_wide_operation:
    '当前项目是仓库的子目录，不能执行整个仓库范围的操作。',
  git_staged_outside_project:
    '仓库中有当前项目之外的暂存改动，请先在终端里处理。',
  git_status_stale: '仓库状态已变化，请刷新后重试。',
  git_status_too_large: 'Git 状态超过安全读取上限。',
  git_status_truncated: 'Git 状态超过安全读取上限，不能操作 Pull Request。',
  git_transient_state: '仓库正处于未完成的 Git 操作中（例如合并或变基）。',
  git_worktree_already_active: '当前会话已经在临时 worktree 中。',
  git_worktree_has_changes: '临时 worktree 还有未处理的改动，不能删除。',
  git_worktree_lease_corrupt:
    'worktree 租约已损坏，已停止自动操作以免误删目录。',
  git_worktree_not_owned: '只能处理 Emperor 创建的 worktree。',
  git_worktree_path_invalid: '临时 worktree 路径不可用。',
  git_worktree_unavailable: '当前不能管理 worktree。',
  git_gh_unavailable: '当前环境中没有可用的 GitHub CLI（gh）。',
  git_gh_failed: 'GitHub CLI 命令失败',
  git_gh_invalid_response: 'GitHub CLI 返回了无效数据。',
  git_pr_invalid_state: 'Pull Request 当前的状态不允许这个操作。',
  git_pr_not_mergeable: 'Pull Request 还不能合并，或必要的检查没有通过。',
  git_pr_push_required: '本地分支还没有完整推送，请先推送。',
  git_pr_result_missing: 'GitHub 没有返回刚创建或更新的 Pull Request。',

  // Pull Request 页
  pull_request_argument_invalid: 'Pull Request 参数不合法。',
  pull_request_not_found: '找不到这个 Pull Request。',
  pull_request_forbidden: '当前账户没有读取这个仓库的权限。',
  pull_request_gh_missing:
    '当前环境中没有可用的 GitHub CLI（gh），请在诊断中安装。',
  pull_request_gh_unauthenticated:
    'GitHub CLI 还没有登录，请在终端运行 gh auth login。',
  pull_request_gh_failed: 'GitHub CLI 命令失败',
  pull_request_invalid_response: 'GitHub CLI 返回了无效数据。',
  pull_request_output_too_large: 'GitHub CLI 返回的数据超过安全读取上限。',
  pull_request_rate_limited: 'GitHub 暂时限流，请稍后再试。',
  github_plugin_disabled: 'GitHub 插件已停用，请在「能力 › 插件」里启用。',

  // 引用与附件
  reference_unknown: '引用已失效，请重新打开消息。',
  reference_session_mismatch: '当前会话不拥有这个引用。',
  reference_source_invalid: '引用来源无效。',
  reference_target_invalid: '引用目标无效。',
  reference_target_changed: '文件位置已改变，请重新打开引用。',
  reference_outside_project: '引用不能指向项目之外。',
  reference_protocol_denied: '不支持这种引用地址。',
  reference_action_denied: '这个引用不允许这个操作。',
  reference_url_invalid: '网站地址无效。',
  reference_url_credentials_denied: '网站地址不能包含账号或密码。',
  reference_attachment_invalid: '附件引用无效。',
  reference_attachment_unknown: '附件不存在或已被移除。',
  reference_image_unavailable: '图片文件不可用。',
  reference_image_unsupported: '这个文件不能预览为图片。',
  reference_image_outside_workspace: '图片不属于当前会话的工作区。',

  // MCP
  mcp_server_not_found: '没有配置这个 MCP 服务器。',
  mcp_config_invalid: 'MCP 服务器配置不正确。',
  mcp_import_invalid: '无法导入这份 MCP 配置。',
  mcp_unavailable: 'MCP 服务器不可用。',
  mcp_connection_failed: '无法连接 MCP 服务器。',
  mcp_transport_timeout: 'MCP 服务器响应超时。',
  mcp_auth_failed: 'MCP 服务器认证失败。',
  mcp_protocol_error: 'MCP 服务器返回了无法处理的数据。',
  mcp_restart_exhausted: 'MCP 服务器多次重启失败，已停止重试。',
  mcp_aborted: 'MCP 请求已取消。',
  mcp_sandbox_refused: '进程沙箱拒绝启动这个 MCP 服务器。',
  mcp_sandbox_consent_required: '进程沙箱不可用，需要你决定是否继续启动。',

  // Skill
  skill_not_found: '找不到这个 Skill。',
  skill_read_only: '这个 Skill 是只读的，可以复制到个人 Skill 后修改。',
  skill_exists: '同名 Skill 已经存在。',
  skill_invalid: 'Skill 文件不正确，请检查 SKILL.md。',
  skill_import_failed: '无法导入这个 Skill。',
  skill_scope_unavailable: '这个位置现在不能存放 Skill。',

  // 插件
  plugin_not_found: '找不到这个插件。',
  plugin_toggle_unavailable: '这台电脑上不能启用这个插件。',
  plugin_managed_uninstall_denied: '随 Emperor 提供的插件不能卸载，可以停用。',
  plugin_preview_manifest_missing: '插件包里没有插件清单。',
  plugin_preview_manifest_invalid: '插件清单格式不正确。',
  plugin_preview_multiple_roots: '插件包里有多个插件目录。',
  plugin_preview_identity_mismatch: '插件包与清单中的插件不一致。',
  plugin_preview_schema_unsupported: '不支持这个版本的插件清单。',
  plugin_preview_name_invalid: '插件名称不合法。',
  plugin_preview_path_unsafe: '插件包里有不安全的路径。',
  plugin_preview_too_large: '插件包太大。',
  plugin_preview_archive_invalid: '插件压缩包已损坏或格式不支持。',
  plugin_preview_duplicate_member: '插件包里有重复的文件。',
  plugin_preview_member_invalid: '插件包里有无法读取的文件。',

  // 备份
  home_backup_invalid: '备份文件不正确或已损坏。',

  // 检查更新（REL-02）
  update_unsupported: '这个版本不检查更新。',
  update_check_disabled: '检查更新已关闭，可在「设置 › 常规 › 更新」打开。',
  update_feed_invalid: '测试更新源只能指向本机，已忽略。',
  update_network_failed: '连接 GitHub 失败，稍后会自动重试。',
  update_blocked_url: '更新地址不在 GitHub 的发布地址范围内，已拒绝。',
  update_bad_response: 'GitHub 返回的版本列表无法识别。',
  update_too_large: '下载的内容比发布时声明的大，已停止并删除。',
  update_not_available: '现在没有可下载的新版本。',
  update_checksum_missing:
    'SHA256SUMS.txt 里没有这个安装包的校验值，已停止下载。',
  update_checksum_mismatch:
    '安装包的 SHA-256 与 SHA256SUMS.txt 不符，已拒绝并删除下载的文件。',
  update_attestation_failed:
    'GitHub 来源证明核验失败，已拒绝并删除下载的文件。',
  update_download_missing: '下载的安装包已不在原来的位置，请重新下载。',

  // 开发环境配置
  catalog_invalid: '内置环境工具目录校验失败，当前版本无法安全配置环境。',
  unsupported_platform: '当前操作系统不在环境配置的支持范围内。',
  unsupported_arch: '当前处理器架构不在环境配置的支持范围内。',
  unsupported_requirement: '项目需要的工具不在可自动安装的范围内。',
  plan_stale: '环境已经变化，请重新检查后再安装。',
  job_active: '已有一项安装正在进行。',
  confirmation_required: '安装前需要你确认。',
  license_not_accepted: '需要先接受许可协议。',
  network_unavailable: '网络不可用，请检查网络连接。',
  proxy_failed: '代理连接失败，请检查代理设置。',
  disk_space_insufficient: '磁盘空间不足。',
  download_failed: '下载失败，请重试。',
  redirect_blocked: '下载地址跳转到了不受信任的位置，已停止。',
  integrity_failed: '下载的文件校验失败，已丢弃。',
  publisher_mismatch: '安装包的发布者与预期不符，已停止安装。',
  elevation_declined: '没有获得安装所需的权限。',
  installer_failed: '安装程序运行失败，请查看安装日志。',
  post_install_probe_failed: '安装完成后没有检测到这个工具。',
}

/** Codes whose message is a tool's own output: its first line follows the text. */
const TOOL_OUTPUT = new Set([
  'git_command_failed',
  'git_gh_failed',
  'pull_request_gh_failed',
])

const CJK = /[一-鿿]/
const GENERAL = '操作没有完成。错误详情可以复制给开发者。'
const INTERNAL = '发生内部错误，请查看日志。'

/** What the interface shows for a failed Core call. */
export function coreErrorText(error: CoreErrorFacts): string {
  const message = error.message?.trim() ?? ''
  if (CJK.test(message)) return message
  const known = error.code ? ERROR_MESSAGES[error.code] : undefined
  if (known) {
    const first = message.split('\n')[0]?.trim()
    return error.code && TOOL_OUTPUT.has(error.code) && first
      ? `${known}：${first}`
      : known
  }
  return error.code ? GENERAL : INTERNAL
}

/** The copyable detail: the code, Core's own message and the IPC error id. */
export function coreErrorDetail(error: CoreErrorFacts): string {
  return [error.code, error.message, error.errorId]
    .filter((part): part is string => Boolean(part))
    .join(' · ')
}
