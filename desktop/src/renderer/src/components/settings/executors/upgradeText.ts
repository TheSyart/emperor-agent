/**
 * What 设置 › 子智能体 says about versions and 升级 (AGT-13), word for word
 * from the approved design: the row line, the top notice, the
 * confirmation, a failure, the detail page's 版本 group and the nav dot.
 * 退回 to the last good version (VER-03, BUG-00 preview § 8) runs the same
 * way and says 退回 wherever an upgrade says 升级. The offline self-check
 * (VER-04, preview § 8): 自检通过 / 不兼容 / 尚未验证 on the 本机版本 line,
 * why under it, and 重新检查.
 * Pure functions over Core's `executors.versions`.
 */
import type {
  ExecutorUpgradeView,
  ExecutorVersionView,
  ExecutorVersionsView,
} from '@emperor/core/runtime-contract'

type Backend = ExecutorVersionView['backend']
const NAME: Record<Backend, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
}

const INSTALL: Record<ExecutorVersionView['install']['kind'], string> = {
  npm: 'npm 全局安装',
  homebrew: 'Homebrew',
  'claude-native': 'Claude 官方安装器',
  desktop: 'Codex 桌面版自带',
  unknown: '认不出安装方式',
}

/** 安装方式 in words. */
export function installText(version: ExecutorVersionView): string {
  return INSTALL[version.install.kind]
}

/** 升级, or 退回 for a rollback (VER-03). */
export function runVerb(run: ExecutorUpgradeView | null | undefined): string {
  return run?.kind === 'rollback' ? '退回' : '升级'
}

/** The row's badge while it runs. */
export function runBadge(run: ExecutorUpgradeView | null | undefined): string {
  return `${runVerb(run)}中`
}

/** Waiting or running. */
export function activeRun(
  run: ExecutorUpgradeView | null | undefined,
): run is ExecutorUpgradeView {
  return run?.state === 'waiting' || run?.state === 'running'
}

/** A failed upgrade still worth saying (the version is not there yet). */
export function failedRun(
  version: ExecutorVersionView | null | undefined,
  run: ExecutorUpgradeView | null | undefined,
): ExecutorUpgradeView | null {
  return run?.state === 'failed' && version?.installed !== run.target
    ? run
    : null
}

/** The row offers 升级 (a command to copy counts; a desktop app's copy does not). */
export function upgradeOffered(
  version: ExecutorVersionView | null | undefined,
  run: ExecutorUpgradeView | null | undefined,
): boolean {
  return (
    !!version?.enabled &&
    !!version.installed &&
    !!version.target &&
    !!version.upgrade &&
    version.upgrade.manual !== 'desktop' &&
    !activeRun(run)
  )
}

function seconds(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(total / 60)
  return m ? `${m} 分 ${String(total % 60).padStart(2, '0')} 秒` : `${total} 秒`
}

/** The row while an upgrade (or a rollback) waits or runs. */
export function runningLine(run: ExecutorUpgradeView, now: number): string {
  const verb = runVerb(run)
  if (run.state === 'running')
    return `正在${verb}到 ${run.target}… 已用 ${seconds(now - run.startedAt)}`
  if (run.waitingFor)
    return `等 ${run.waitingFor} 个子任务结束后${verb}到 ${run.target}…`
  if (run.queued) return `等另一个升级完成后${verb}到 ${run.target}…`
  return `正在准备${verb}到 ${run.target}…`
}

/** x.y.z: `a` is newer than `b`. */
function newer(a: string, b: string): boolean {
  const [x, y] = [a, b].map((v) => v.split('.').map(Number))
  for (let i = 0; i < 3; i++)
    if ((x![i] ?? 0) !== (y![i] ?? 0)) return (x![i] ?? 0) > (y![i] ?? 0)
  return false
}

/**
 * npm has a newer release and nothing is offered: the one the user went
 * back from, which 升级 skips until a newer one comes (VER-03).
 */
export function heldBack(version: ExecutorVersionView): boolean {
  return (
    !version.target &&
    !version.unverified &&
    !!version.installed &&
    !!version.latest &&
    newer(version.latest, version.installed)
  )
}

/** 刚刚升级 for ten minutes after it succeeded. */
const RECENT_MS = 10 * 60_000

/**
 * The row's line when the executor is ready: `lead · 本机 x` and what is
 * new; `highlight` is the offer (可升级到 y), shown in gold.
 */
export function rowUpgradeLine(
  lead: string,
  version: ExecutorVersionView,
  run: ExecutorUpgradeView | null | undefined,
  now: number,
): { text: string; highlight?: string } {
  const base = [lead, `本机 ${version.installed ?? '版本未知'}`]
    .filter(Boolean)
    .join(' · ')
  if (failedRun(version, run))
    return { text: `${base} · ${runVerb(run)}没有完成` }
  if (version.selfCheck?.status === 'incompatible')
    return { text: `${base} · 自检不兼容` }
  if (version.target && version.upgrade?.manual === 'desktop')
    return { text: `${base} · ${version.target} 随桌面版更新` }
  if (version.target && version.upgrade)
    return { text: base, highlight: `可升级到 ${version.target}` }
  if (version.unverified)
    return {
      text: `${base} · 已是验证过的最新版 · ${version.unverified} 尚未验证`,
    }
  if (!version.latest) return { text: base }
  const recent =
    run?.state === 'succeeded' &&
    run.finishedAt !== undefined &&
    now - run.finishedAt < RECENT_MS
  const just = recent ? ` · 刚刚${runVerb(run)}` : ''
  if (heldBack(version))
    return { text: `${base} · 已从 ${version.latest} 退回，暂不升级${just}` }
  return { text: `${base} · 已是最新${just}` }
}

/**
 * The detail page's 退回 (VER-03): the last good version, when the
 * installed one failed for its version; a desktop app's copy only says why
 * not.
 */
export function rollbackOffered(
  version: ExecutorVersionView | null | undefined,
  run: ExecutorUpgradeView | null | undefined,
): boolean {
  return (
    !!version?.enabled &&
    !!version.installed &&
    !!version.rollback &&
    !activeRun(run)
  )
}

/** The 退回 button, or why there is none (a desktop app's copy). */
export function rollbackAction(version: ExecutorVersionView): {
  label: string | null
  note: string | null
} {
  const offer = version.rollback
  if (!offer) return { label: null, note: null }
  if (offer.manual === 'desktop')
    return {
      label: null,
      note: `${NAME[version.backend]} 随桌面版更新，不能在这里退回。`,
    }
  return { label: `退回 ${offer.target}（上次正常）`, note: null }
}

type Tone = 'ok' | 'warn' | 'error' | 'neutral'

/** Claude Code installed above every verified release (by hand). */
function installedUnverified(version: ExecutorVersionView): boolean {
  return (
    version.backend === 'claude-code' &&
    version.verified.length > 0 &&
    !!version.installed &&
    !version.verified.includes(version.installed)
  )
}

/**
 * Beside 本机版本 (VER-04): what the self-check found (正在自检… while it
 * runs) and, for Claude Code, 尚未验证 — the installed version, or the
 * newer release 升级 does not offer yet. Codex keeps its own 尚未验证 line.
 */
export function selfCheckBadges(
  version: ExecutorVersionView,
): Array<{ text: string; tone: Tone }> {
  const badges: Array<{ text: string; tone: Tone }> = []
  const status = version.selfCheck?.status
  if (version.selfChecking) badges.push({ text: '正在自检…', tone: 'neutral' })
  else if (status === 'ok' || status === 'adapted')
    badges.push({ text: '自检通过', tone: 'ok' })
  else if (status === 'incompatible')
    badges.push({ text: '不兼容', tone: 'error' })
  else if (status === 'error')
    badges.push({ text: '自检没有完成', tone: 'neutral' })
  if (version.backend !== 'claude-code' || status === 'incompatible')
    return badges
  if (installedUnverified(version))
    badges.push({ text: '尚未验证', tone: 'warn' })
  else if (version.unverified)
    badges.push({ text: `${version.unverified} 尚未验证`, tone: 'warn' })
  return badges
}

/** Under 本机版本 (VER-04): why, in the tertiary colour. */
export function selfCheckNotes(version: ExecutorVersionView): string[] {
  const check = version.selfCheck
  const notes: string[] = []
  if (check?.status === 'incompatible') {
    const issue = check.issues.find((i) => i.blocking)
    if (issue) notes.push(issue.detail)
  } else if (check?.status === 'error') {
    if (check.issues[0]) notes.push(check.issues[0].detail)
  } else if (check) {
    const off = check.adapted?.builtinPluginsDisabled ?? []
    if (off.length) {
      const since = [
        ...new Set(off.map((s) => check.adapted?.since?.[s]).filter(Boolean)),
      ]
      notes.push(
        `已自动关闭内置插件 ${off.map((s) => s.replace(/@builtin$/u, '')).join('、')}${since.length === 1 ? `（${since[0]} 起自带）` : ''}`,
      )
    }
  }
  if (version.backend === 'claude-code' && check?.status !== 'incompatible') {
    if (installedUnverified(version))
      notes.push(
        check && check.status !== 'error'
          ? '这个版本 Emperor 还没验证；自检通过，可以使用。'
          : '这个版本 Emperor 还没验证。',
      )
    else if (version.unverified)
      notes.push('已是 Emperor 验证过的最新版；更新的版本验证后才会推荐升级')
  }
  return notes
}

/**
 * Under 本机版本, in the warning colour (VER-04): what the self-check
 * noted without blocking — a Codex protocol that differs from the verified
 * one (可能不兼容, still runnable), a feature on by default Emperor never
 * reviewed.
 */
export function selfCheckWarnings(version: ExecutorVersionView): string[] {
  const check = version.selfCheck
  if (!check || check.status === 'incompatible' || check.status === 'error')
    return []
  return check.issues.filter((i) => !i.blocking).map((i) => i.detail)
}

/**
 * The 版本 group's main button: an upgrade, its progress, or 已是最新 as
 * designed (AGT-13) — but not a disabled 已是最新 beside 退回 or a version
 * the self-check refused (VER-04).
 */
export function primaryShown(
  version: ExecutorVersionView,
  run: ExecutorUpgradeView | null | undefined,
): boolean {
  if (activeRun(run) || upgradeOffered(version, run)) return true
  return !version.rollback && version.selfCheck?.status !== 'incompatible'
}

/** The line about the auto-updater: prose, the export as code, the end. */
export interface CodeNote {
  before: string
  code: string
  after: string
}

/** 退回's confirmation (or, without one click, the command to run). */
export function rollbackContent(version: ExecutorVersionView): {
  title: string
  lead: string
  commands: string[]
  points: string[]
  note: CodeNote | null
  action: string | null
} {
  const offer = version.rollback!
  const name = NAME[version.backend]
  const commands = offer.command ? [offer.command] : []
  // Only claude updates itself; Codex does not.
  const note: CodeNote | null =
    version.backend === 'claude-code'
      ? {
          before:
            '你在终端里直接用 claude 时，它可能自动更新回新版本；需要时可在 shell 配置里加 ',
          code: 'export DISABLE_AUTOUPDATER=1',
          after: '。',
        }
      : null
  if (!offer.oneClick)
    return {
      title: `退回 ${name} 到 ${offer.target}`,
      lead:
        offer.manual === 'homebrew'
          ? `${offer.because}。Homebrew 装不了旧版本，Emperor 不替你退回。在终端里运行下面这条命令（会另装一份，PATH 里靠前的那份生效），完成后点「重新检测」：`
          : `${offer.because}。Emperor 认不出 ${name} 的安装方式，不能替你退回。在终端里运行下面这条命令，完成后点「重新检测」：`,
      commands,
      points: [],
      note,
      action: null,
    }
  return {
    title: `退回 ${name} ${offer.target}？`,
    lead: `${offer.because}。退回会用你安装 ${name} 的同一方式运行：`,
    commands,
    points: [],
    note,
    action: '退回',
  }
}

/** One-click offers of executors that are on, unless an upgrade runs. */
function offers(versions: ExecutorVersionsView): ExecutorVersionView[] {
  return versions.executors.filter(
    (v) =>
      v.enabled &&
      v.installed &&
      v.target &&
      v.upgrade?.oneClick &&
      !activeRun(versions.upgrades.find((u) => u.profileId === v.profileId)),
  )
}

/** 「Claude Code 和 Codex 有新版本」 at the top; null: nothing to say. */
export function noticeContent(versions: ExecutorVersionsView | null): {
  title: string
  body: string
  action: string
  profileIds: string[]
} | null {
  if (!versions || versions.dismissed) return null
  if (versions.upgrades.some((u) => activeRun(u))) return null
  const offered = offers(versions)
  if (!offered.length) return null
  const changes = offered
    .map((v) => `${NAME[v.backend]} ${v.installed} → ${v.target}`)
    .join('；')
  const held = versions.executors
    .filter((v) => v.enabled && v.unverified && !offered.includes(v))
    .map(
      (v) =>
        `${NAME[v.backend]} ${v.unverified} 已发布，但 Emperor 还没验证，暂不升级。`,
    )
  const kinds = [...new Set(offered.map((v) => v.install.kind))]
  const how = kinds.length === 1 ? `（${INSTALL[kinds[0]!]}）` : ''
  const them = offered.length > 1 ? '它们' : '它'
  const body = held.length
    ? `${changes}。${held.join('')}`
    : `${changes}。用你安装${them}时的方式${how}升级，不改动登录和设置。`
  return {
    title: `${offered.map((v) => NAME[v.backend]).join(' 和 ')} 有新版本`,
    body,
    action:
      offered.length > 1 ? '全部升级' : `升级 ${NAME[offered[0]!.backend]}`,
    profileIds: offered.map((v) => v.profileId),
  }
}

const running = (count: number) =>
  count ? `；正在运行的 ${count} 个会先跑完` : ''

/** The confirmation (or, without one click, the command to run). */
export function confirmContent(items: readonly ExecutorVersionView[]): {
  title: string
  lead: string
  commands: string[]
  points: string[]
  action: string | null
} {
  const commands = items.map((v) => v.upgrade?.command ?? '').filter(Boolean)
  const [only] = items
  if (items.length === 1 && only && !only.upgrade?.oneClick)
    return {
      title: `升级 ${NAME[only.backend]} 到 ${only.target}`,
      lead:
        only.upgrade?.manual === 'homebrew'
          ? `Homebrew 现在提供的不是 ${only.target}，Emperor 不替你升级。在终端里先运行 brew update，再运行下面这条命令，完成后点「重新检测」：`
          : `Emperor 认不出 ${NAME[only.backend]} 的安装方式，不能替你升级。在终端里运行下面这条命令，完成后点「重新检测」：`,
      commands,
      points: [],
      action: null,
    }
  if (items.length === 1 && only) {
    const name = NAME[only.backend]
    return {
      title: `升级 ${name} 到 ${only.target}？`,
      lead: 'Emperor 会用你当初安装它的方式升级，运行：',
      commands,
      points:
        only.backend === 'codex'
          ? [
              '不改动你的 Codex 登录和设置（~/.codex），Codex 桌面版不受影响',
              `升级期间不派新的 Codex 子任务${running(only.activeRuns)}`,
              '升级后 Emperor 会重新检测，失败时可以按提示自己在终端里装回去',
            ]
          : [
              '不改动你的 Claude 登录和设置；Emperor 那份专用登录也保留',
              `升级期间不派新的 Claude Code 子任务${running(only.activeRuns)}`,
              '升级后 Emperor 会重新检测它的能力',
            ],
      action: '升级',
    }
  }
  const activeRuns = items.reduce((n, v) => n + v.activeRuns, 0)
  return {
    title: `升级 ${items.map((v) => NAME[v.backend]).join(' 和 ')}？`,
    lead: 'Emperor 会用你当初安装它们的方式依次升级，运行：',
    commands,
    points: [
      '不改动你的 Claude、Codex 登录和设置（包括 ~/.codex 和 Emperor 那份专用登录），Codex 桌面版不受影响',
      `升级期间不派新的子任务${running(activeRuns)}`,
      '升级后 Emperor 会重新检测，失败时可以按提示自己在终端里装回去',
    ],
    action: '全部升级',
  }
}

/** A failed upgrade: why, what to do, the command. */
export function failureContent(run: ExecutorUpgradeView): {
  title: string
  body: string
  command: string | null
} {
  const verb = runVerb(run)
  const why: Record<NonNullable<ExecutorUpgradeView['reason']>, string> = {
    permission: `没有写入 ${run.path ?? '安装目录'} 的权限`,
    network:
      run.kind === 'rollback'
        ? `连不上网络，没有下载到 ${run.target}`
        : '连不上网络，没有下载到新版本',
    timeout: '10 分钟没有完成，已停止',
    start: `${verb}命令没能启动`,
    'not-upgraded': `命令已结束，但重新检测到的仍是 ${run.installed ?? run.from ?? '原来的版本'}`,
    exit:
      run.exitCode !== undefined
        ? `命令以退出码 ${run.exitCode} 结束`
        : '命令意外结束',
  }
  const tail = '你可以在终端里自己运行下面这条命令，完成后点「重新检测」：'
  return {
    title: `${NAME[run.backend]} ${verb}失败：${why[run.reason ?? 'exit']}`,
    body:
      run.reason === 'permission'
        ? `Emperor 不会用管理员权限运行。${tail}`
        : run.reason === 'exit'
          ? '可以点「查看过程」看命令输出；也可以在终端里自己运行下面这条命令，完成后点「重新检测」：'
          : tail,
    command: run.manualCommand ?? null,
  }
}

function ago(at: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - at) / 60_000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `${hours} 小时前` : `${Math.floor(hours / 24)} 天前`
}

/** Under 检查更新: when it last checked; it reads only public numbers. */
export function checkedText(
  versions: ExecutorVersionsView,
  now: number,
): string {
  if (versions.checking) return '正在检查…'
  const when =
    versions.checkedAt === null ? null : `${ago(versions.checkedAt, now)}检查过`
  if (versions.error)
    return when ? `这次没有连上 npm · ${when}` : '没有连上 npm，稍后再检查'
  return `${when ?? '还没有检查过'} · 只读取公开的版本号`
}

/** The dot on 子智能体 in the nav. */
export function attentionNeeded(
  versions: ExecutorVersionsView | null,
): boolean {
  if (!versions) return false
  if (noticeContent(versions)) return true
  return versions.upgrades.some((run) =>
    failedRun(
      versions.executors.find((v) => v.profileId === run.profileId),
      run,
    ),
  )
}

export function executorTitle(backend: Backend): string {
  return NAME[backend]
}
