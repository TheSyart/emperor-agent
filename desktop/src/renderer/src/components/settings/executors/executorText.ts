/**
 * What 设置 › 子智能体 says about Claude Code and Codex (AGT-10): one status
 * word, the sentence under it, the sign-in state and the plain-language
 * capability lines of the detail page. Pure functions over Core's facts, so
 * the main page, the detail page and their tests read the same words.
 */
import type {
  ExecutorAuthState,
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

/** Claude Code runs the binary bundled with Emperor unless switched. */
export function usesBundledClaude(profile: ExecutorProfile): boolean {
  return (
    profile.backend === 'claude-code' && profile.executableSource !== 'system'
  )
}

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
  if (!profile.enabled) return '已关闭'
  if (facts.loading) return '检测中…'
  if (facts.probeError) return '检测失败'
  const probe = facts.probe
  if (!probe) return '未检测'
  if (probe.diagnostic === 'executor version probe failed') return '检测失败'
  if (probe.diagnostic === 'AUTH_EXPIRED' || probe.auth?.problem === 'expired')
    return '令牌已过期'
  if (probe.diagnostic === 'AUTH_REQUIRED') return '需要登录令牌'
  if (probe.status === 'available' && probe.auth?.expiresSoon)
    return '令牌即将过期'
  if (probe.diagnostic === 'AUTH_ROUTE_UNAVAILABLE') return '凭据不可用'
  if (probe.status === 'available' && probe.compatibility === 'unverified')
    return '可能不兼容'
  return {
    available: '子智能体就绪',
    missing: '未找到命令行程序',
    needs_auth: '需要登录令牌',
    incompatible: '版本不兼容',
    containment_unavailable: '运行环境不可用',
  }[probe.status]
}

export type StatusTone = 'ok' | 'warn' | 'neutral'

export function statusTone(
  profile: ExecutorProfile,
  facts: ExecutorFacts,
): StatusTone {
  if (!profile.enabled) return 'neutral'
  if (
    hasIssue(facts) ||
    compatibilityWarning(profile, facts) ||
    facts.probe?.auth?.expiresSoon
  )
    return 'warn'
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
      probe.diagnostic === 'AUTH_EXPIRED')
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
  if (probe.status === 'needs_auth' || probe.diagnostic === 'AUTH_REQUIRED')
    return profile.authRef.kind === 'model-route'
      ? '所选模型的凭据读不到，请在「设置 › 模型」里检查这条配置。'
      : '请在终端运行 codex login，登录后重新检测。'
  if (probe.status === 'missing')
    return usesBundledClaude(profile)
      ? 'Emperor 内置的 Claude Code 缺失，请重新安装 Emperor，或在「高级」里改用本机安装的 claude。'
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
        : '可以升级本机 claude，或在「高级」里关掉「使用本机安装的 claude」，改用 Emperor 内置版本。')
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
  profile: ExecutorProfile,
  facts: ExecutorFacts,
): string {
  const probe = facts.probe
  if (!probe?.executableVersion) return '未知'
  if (profile.backend !== 'claude-code') return probe.executableVersion
  return (
    probe.executableVersion +
    (probe.executableSource === 'system' ? '（本机）' : '（随 Emperor 内置）')
  )
}

// ── Claude Code 登录 (AGT-02) ──────────────────────────────────────────
// Sources, in Core's order: Emperor's own token, ~/.claude/settings.json,
// .credentials.json, the environment, the login shell. Never the Keychain.

const KIND_LABEL = {
  'oauth-token': '订阅账号',
  'api-key': 'API Key',
  'auth-token': '网关令牌',
} as const

const SOURCE_LABEL = {
  settings: '来自 ~/.claude/settings.json',
  'credentials-file': '来自 ~/.claude/.credentials.json',
  environment: '来自启动 Emperor 时的环境变量',
  'login-shell': '来自登录 shell 的环境变量（如 ~/.zshrc）',
  'model-route': '使用已有模型配置',
} as const

function minutesLeft(auth: ExecutorAuthState): number {
  return Math.max(1, Math.ceil(((auth.expiresAt ?? 0) - Date.now()) / 60_000))
}

export function hasEmperorToken(facts: ExecutorFacts): boolean {
  const auth = facts.probe?.auth
  return auth?.source === 'emperor' || auth?.problem === 'unreadable'
}

export function signInText(facts: ExecutorFacts): string {
  const auth = facts.probe?.auth
  if (!auth)
    return facts.probe?.localAuthChecked ? '本机登录配置可读' : '尚未检测'
  if (auth.source === 'emperor')
    return `已设置 · 末 4 位 ${auth.last4 ?? ''}（${KIND_LABEL[auth.kind ?? 'oauth-token']}）`
  if (auth.source)
    return [
      SOURCE_LABEL[auth.source],
      ...(auth.kind && auth.source !== 'model-route'
        ? [KIND_LABEL[auth.kind]]
        : []),
      ...(auth.expiresSoon ? [`${minutesLeft(auth)} 分钟内过期`] : []),
    ].join(' · ')
  return auth.problem === 'expired'
    ? '.credentials.json 里的令牌已过期'
    : auth.problem === 'unreadable'
      ? '保存在 Emperor 的令牌已无法读取'
      : '未登录'
}

export const SIGN_IN_ALERT_TITLE = {
  missing: '尚未登录',
  expired: '令牌已过期',
  unreadable: '令牌无法读取',
  soon: '令牌即将过期',
} as const

export type SignInAlert = keyof typeof SIGN_IN_ALERT_TITLE

/** What the sign-in has to tell: no sign-in, or one about to expire. */
export function signInAlert(
  profile: ExecutorProfile,
  facts: ExecutorFacts,
): SignInAlert | '' {
  const auth = facts.probe?.auth
  if (authIssue(profile, facts))
    return auth?.problem === 'expired' || auth?.problem === 'unreadable'
      ? auth.problem
      : 'missing'
  return facts.probe?.status === 'available' && auth?.expiresSoon ? 'soon' : ''
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
  if (!profile.enabled) return '会使用你自己的订阅额度或 API 计费，需要时再打开'
  const alert = signInAlert(profile, facts)
  if (alert === 'missing')
    return '订阅账号请在终端运行 claude setup-token，把令牌粘贴进来'
  if (alert === 'expired' || alert === 'unreadable')
    return '请重新设置令牌（终端运行 claude setup-token）'
  if (alert === 'soon') return '令牌即将过期，长任务可能中途失败'
  const detail = statusDetail(profile, facts)
  if (detail) return detail
  const warning = compatibilityWarning(profile, facts)
  if (warning) return warning
  if (!facts.probe) return facts.loading ? '正在检测…' : '尚未检测'
  const probe = facts.probe
  const version = probe.executableVersion
    ? (profile.backend === 'claude-code' && probe.executableSource !== 'system'
        ? '内置 '
        : '') + probe.executableVersion
    : '版本未知'
  return profile.backend === 'codex'
    ? `${version} · 沿用你的模型与供应商配置`
    : `${version} · ${shortSignIn(facts)}`
}

/** Claude's sign-in in a few words, for the one-line row. */
function shortSignIn(facts: ExecutorFacts): string {
  const auth = facts.probe?.auth
  if (!auth) return '沿用本机登录'
  if (auth.source === 'emperor') return `令牌末 4 位 ${auth.last4 ?? ''}`
  if (auth.source === 'model-route') return '使用已有模型配置'
  return '沿用本机登录'
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
