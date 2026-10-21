/**
 * What 设置 › 子智能体 says about Claude Code and Codex (AGT-10): one status
 * word, the sentence under it, the sign-in state and the plain-language
 * capability lines of the detail page. Pure functions over Core's facts, so
 * the main page, the detail page and their tests read the same words.
 */
import type {
  ExecutorProbe,
  ExecutorProfile,
  ExecutorRuntimeFacts,
  NativeCapabilityEvidence,
  NativeCapabilityStatus,
} from '@emperor/core/runtime-contract'

/** What Core last reported about one profile. */
export interface ExecutorFacts {
  readonly probe?: ExecutorProbe | null
  /** A probe that failed outright (the message). */
  readonly probeError?: string
  readonly runtime?: ExecutorRuntimeFacts
  readonly consent?: 'always' | null
  /** A first read is still running. */
  readonly loading?: boolean
}

export function executorName(backend: ExecutorProfile['backend']): string {
  return backend === 'codex' ? 'Codex' : 'Claude Code'
}

/** The official install command (code.claude.com/docs/en/setup, macOS). */
export const CLAUDE_INSTALL_COMMAND =
  'curl -fsSL https://claude.ai/install.sh | bash'

/** A Claude profile that signs in on its own (not through a model route). */
export function signsInHere(profile: ExecutorProfile): boolean {
  return (
    profile.backend === 'claude-code' &&
    profile.authRef.kind === 'managed-cli-login'
  )
}

/** The status in a few words. */
export function statusLabel(
  profile: ExecutorProfile,
  facts: ExecutorFacts,
): string {
  // Emperor brings no Claude Code (AGT-12): say so whether it is on or off.
  if (claudeMissing(profile, facts)) return '未安装'
  if (!profile.enabled) return '已关闭'
  if (facts.loading) return '检测中…'
  if (facts.probeError) return '检测失败'
  const probe = facts.probe
  if (!probe) return '未检测'
  if (
    probe.diagnostic === 'executor version probe failed' ||
    probe.diagnostic === 'AUTH_STATUS_FAILED'
  )
    return '检测失败'
  if (probe.diagnostic === 'AUTH_ROUTE_UNAVAILABLE') return '凭据不可用'
  if (probe.status === 'needs_auth' || probe.diagnostic === 'AUTH_REQUIRED')
    return signsInHere(profile) ? '未登录' : '需要登录'
  if (probe.status === 'available' && probe.compatibility === 'unverified')
    return '可能不兼容'
  return {
    available: '子智能体就绪',
    missing: '未找到命令行程序',
    needs_auth: '需要登录',
    incompatible: '版本不兼容',
    containment_unavailable: '运行环境不可用',
  }[probe.status]
}

/** Claude Code is not installed (Emperor ships none, AGT-12). */
export function claudeMissing(
  profile: ExecutorProfile,
  facts: ExecutorFacts,
): boolean {
  return (
    profile.backend === 'claude-code' &&
    !facts.loading &&
    facts.probe?.status === 'missing'
  )
}

export type StatusTone = 'ok' | 'warn' | 'neutral'

export function statusTone(
  profile: ExecutorProfile,
  facts: ExecutorFacts,
): StatusTone {
  if (!profile.enabled) return 'neutral'
  if (hasIssue(facts) || compatibilityWarning(profile, facts)) return 'warn'
  return facts.probe?.status === 'available' ? 'ok' : 'neutral'
}

/** The probe failed or found something to fix. */
export function hasIssue(facts: ExecutorFacts): boolean {
  return (
    !!facts.probeError || (!!facts.probe && facts.probe.status !== 'available')
  )
}

/** Claude's sign-in is what is missing: its own help replaces the generic one. */
export function authIssue(
  profile: ExecutorProfile,
  facts: ExecutorFacts,
): boolean {
  const probe = facts.probe
  return (
    signsInHere(profile) &&
    !!probe &&
    (probe.status === 'needs_auth' ||
      probe.diagnostic === 'AUTH_REQUIRED' ||
      probe.diagnostic === 'AUTH_STATUS_FAILED')
  )
}

/** What is wrong and how to fix it, in one sentence (empty: nothing). */
export function statusDetail(
  profile: ExecutorProfile,
  facts: ExecutorFacts,
): string {
  if (facts.probeError) return `检测失败：${facts.probeError}`
  const probe = facts.probe
  if (!probe) return ''
  if (probe.diagnostic === 'executor version probe failed')
    return '读不到命令行程序的版本，请检查可执行权限和本机运行环境后重新检测。'
  if (probe.diagnostic === 'AUTH_ROUTE_UNAVAILABLE')
    return '所选模型的凭据读不到，请在「设置 › 模型」里检查这条配置。'
  if (probe.diagnostic === 'AUTH_STATUS_FAILED')
    return '读不到 Claude Code 的登录状态（claude auth status 没有正常结束），请重新检测。'
  if (probe.status === 'needs_auth' || probe.diagnostic === 'AUTH_REQUIRED')
    return profile.authRef.kind === 'model-route'
      ? '所选模型的凭据读不到，请在「设置 › 模型」里检查这条配置。'
      : profile.backend === 'claude-code'
        ? '请点「登录 Claude Code」，在 macOS 的「终端」里登录一次。'
        : '请在终端运行 codex login，登录后重新检测。'
  if (probe.status === 'missing')
    return profile.backend === 'claude-code'
      ? `没有找到 claude。在终端运行 ${CLAUDE_INSTALL_COMMAND} 安装后重新检测`
      : '没有找到命令行程序，请检查本机安装，或在详情里更正路径。'
  if (probe.status === 'incompatible') {
    const name = profile.backend === 'codex' ? 'Codex' : 'claude'
    const installed = probe.executableVersion ?? '版本未知'
    if (!probe.requiredVersion)
      return `本机 ${name}（${installed}）不在支持范围内，请检查版本。`
    return (
      `本机 ${name} ${installed} 不在支持范围内，需要 ${probe.requiredVersion}。` +
      (profile.backend === 'codex'
        ? '请安装对应版本后重新检测。'
        : '请在终端运行 claude update 升级后重新检测。')
    )
  }
  if (probe.status === 'containment_unavailable')
    return '本机运行环境不可用，请检查后重新检测。'
  return ''
}

/** Runnable, but the CLI's protocol only matched by version (AGT-01). */
export function compatibilityWarning(
  profile: ExecutorProfile,
  facts: ExecutorFacts,
): string {
  const probe = facts.probe
  if (probe?.status !== 'available' || probe.compatibility !== 'unverified')
    return ''
  const name = profile.backend === 'codex' ? 'Codex' : 'claude'
  return `本机 ${name} ${probe.executableVersion ?? ''} 的协议与已验证的 ${probe.protocolVersion ?? '版本'} 不同，可能不兼容；仍可运行，失败时会注明可能是版本原因。`
}

export function versionText(
  _profile: ExecutorProfile,
  facts: ExecutorFacts,
): string {
  return facts.probe?.executableVersion ?? '未知'
}

// ── Claude Code 登录 (AGT-12) ──────────────────────────────────────────
// Claude Code signs in with its own login (登录 Claude Code, in macOS
// Terminal); `auth` is what `claude auth status` says, plus the API
// credential Emperor passes, which outranks that login. Emperor never
// reads or keeps the login itself.

const SOURCE_LABEL = {
  settings: '来自 ~/.claude/settings.json',
  environment: '来自启动 Emperor 时的环境变量',
  'login-shell': '来自登录 shell 的环境变量（如 ~/.zshrc）',
} as const

/** Emperor keeps the user's own API key (使用 API Key). */
export function hasEmperorKey(facts: ExecutorFacts): boolean {
  const auth = facts.probe?.auth
  return auth?.source === 'emperor' || auth?.problem === 'unreadable'
}

/** claude's own sign-in is in effect (退出登录 applies). */
export function signedInWithClaude(facts: ExecutorFacts): boolean {
  const auth = facts.probe?.auth
  return (
    !!auth &&
    !auth.source &&
    (auth.method === 'claude.ai' || auth.method === 'api_key')
  )
}

/** Which credential claude uses, in one line. */
export function signInText(facts: ExecutorFacts): string {
  const auth = facts.probe?.auth
  if (
    facts.probe?.diagnostic === 'AUTH_STATUS_FAILED' ||
    auth?.problem === 'status-failed'
  )
    return '读不到 Claude Code 的登录状态（claude auth status 没有正常结束），请重新检测。'
  if (!auth) return facts.probe?.localAuthChecked ? '已登录' : '尚未检测'
  if (auth.source === 'model-route') return '使用已有模型配置'
  if (auth.source) {
    const from =
      auth.source === 'emperor'
        ? `Emperor 保存 · 末 4 位 ${auth.last4 ?? ''}`
        : SOURCE_LABEL[auth.source]
    if (auth.endpoint) return `使用第三方端点 ${auth.endpoint} · ${from}`
    return `${auth.kind === 'auth-token' ? '使用网关令牌' : '使用 API Key'} · ${from}`
  }
  switch (auth.method) {
    case 'claude.ai':
      return ['已登录 Claude 账号', auth.email, auth.organization]
        .filter(Boolean)
        .join(' · ')
    case 'api_key':
      return '已登录 Console 账号（按用量计费）'
    case 'oauth_token':
      return '使用 Claude Code 自己配置的令牌'
    case 'api_key_helper':
      return '使用 Claude Code 的 apiKeyHelper'
    case 'third_party':
      return '使用云服务商（Bedrock、Vertex 或 Foundry）'
    case undefined:
      return facts.probe?.localAuthChecked ? '已登录' : '尚未检测'
    default:
      return auth.problem === 'unreadable'
        ? '保存在 Emperor 的 API Key 已无法读取'
        : '尚未登录'
  }
}

/**
 * The credential Emperor passes outranks claude's own login (claude's
 * order: a gateway token, then an API key, then its sign-in): what to undo
 * to sign in with a Claude account instead. Empty when nothing outranks it.
 */
export function precedenceText(facts: ExecutorFacts): string {
  switch (facts.probe?.auth?.source) {
    case 'emperor':
      return 'API Key 优先于 Claude Code 自己的登录。要改用 Claude 账号，先移除这里的 API Key。'
    case 'settings':
      return '~/.claude/settings.json 里的凭据优先于 Claude Code 自己的登录。要改用 Claude 账号，在那里去掉它。'
    case 'environment':
      return '启动 Emperor 时环境变量里的凭据优先于 Claude Code 自己的登录。要改用 Claude 账号，去掉这个环境变量后重新启动 Emperor。'
    case 'login-shell':
      return '登录 shell（如 ~/.zshrc）里导出的凭据优先于 Claude Code 自己的登录。要改用 Claude 账号，去掉那一行后重新启动 Emperor。'
    default:
      return ''
  }
}

/** Claude Code needs 登录 Claude Code (or the status could not be read). */
export function needsSignIn(
  profile: ExecutorProfile,
  facts: ExecutorFacts,
): boolean {
  return !!profile.enabled && authIssue(profile, facts)
}

export function consentText(facts: ExecutorFacts): string {
  return facts.consent === 'always'
    ? '已选择「以后都允许」：交给它之前不再询问。关闭后再打开会恢复询问。'
    : '第一次把任务交给它之前，会在对话里征得你的同意（本次允许 / 以后都允许 / 不允许）。'
}

/**
 * The sentence under the name on the main page: why it cannot run, or what
 * it runs with. The whole row says it when a sign-in is missing (AGT-10).
 */
export function rowSummary(
  profile: ExecutorProfile,
  facts: ExecutorFacts,
): string {
  if (claudeMissing(profile, facts)) return statusDetail(profile, facts)
  if (!profile.enabled) return '会使用你自己的订阅额度或 API 计费，需要时再打开'
  if (needsSignIn(profile, facts))
    return facts.probe?.diagnostic === 'AUTH_STATUS_FAILED'
      ? '读不到 Claude Code 的登录状态，请重新检测'
      : '在 macOS 的「终端」里登录一次，登录由 Claude Code 自己保存'
  const detail = statusDetail(profile, facts)
  if (detail) return detail
  const warning = compatibilityWarning(profile, facts)
  if (warning) return warning
  if (!facts.probe) return facts.loading ? '正在检测…' : '尚未检测'
  const version = facts.probe.executableVersion ?? '版本未知'
  return profile.backend === 'codex'
    ? `${version} · 沿用你的模型与供应商配置`
    : `${version} · ${shortSignIn(facts)}`
}

/** Claude's sign-in in a few words, for the one-line row. */
function shortSignIn(facts: ExecutorFacts): string {
  const auth = facts.probe?.auth
  if (!auth) return '已登录'
  if (auth.source === 'model-route') return '使用已有模型配置'
  if (auth.endpoint) return `第三方端点 ${auth.endpoint}`
  if (auth.source === 'emperor') return `API Key 末 4 位 ${auth.last4 ?? ''}`
  if (auth.source) return '使用 API Key'
  if (auth.method === 'claude.ai') return '已登录 Claude 账号'
  if (auth.method === 'api_key') return '已登录 Console 账号'
  return '已登录'
}

// ── 能力 (detail page) ─────────────────────────────────────────────────

const CAPABILITY_STATUS: Record<NativeCapabilityStatus, string> = {
  unverified: '还没有验证',
  verifying: '正在验证',
  available: '已验证',
  unavailable: '不可用',
  unsupported: '当前接入不支持',
  stale: '验证已失效，下次运行时重新验证',
}

export function capabilityOf(
  profile: ExecutorProfile,
  facts: ExecutorFacts,
  kind: 'search' | 'imageGeneration',
): NativeCapabilityEvidence {
  return (
    facts.runtime?.nativeCapabilities[kind] ?? {
      status:
        profile.backend === 'claude-code' && kind === 'imageGeneration'
          ? ('unsupported' as const)
          : ('unverified' as const),
    }
  )
}

/** 「这个模型支持联网搜索：已验证」 — one line per capability it may have. */
export function capabilityLines(
  profile: ExecutorProfile,
  facts: ExecutorFacts,
): Array<{
  kind: 'search' | 'imageGeneration'
  status: NativeCapabilityStatus
  text: string
}> {
  return (['search', 'imageGeneration'] as const)
    .map((kind) => ({ kind, fact: capabilityOf(profile, facts, kind) }))
    .filter(({ fact }) => fact.status !== 'unsupported')
    .map(({ kind, fact }) => ({
      kind,
      status: fact.status,
      text:
        (kind === 'search' ? '联网搜索' : '生成图片') +
        '：' +
        CAPABILITY_STATUS[fact.status] +
        (fact.searchMode === 'live'
          ? '（实时）'
          : fact.searchMode === 'cached'
            ? '（缓存结果）'
            : '') +
        (fact.checkedAt
          ? ` · ${new Date(fact.checkedAt).toLocaleString()}`
          : ''),
    }))
}

const MODEL_SOURCE: Record<string, string> = {
  cli: '本机发现',
  configuration: '本机配置',
  cache: '缓存',
  builtin: '内置参考',
  custom: '自定义',
}

export function modelSourceName(source: string): string {
  return MODEL_SOURCE[source] ?? source
}
