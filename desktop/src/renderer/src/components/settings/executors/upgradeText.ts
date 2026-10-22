/**
 * What 设置 › 子智能体 says about versions and 升级 (AGT-13), word for word
 * from the approved design: the row line, the top notice, the
 * confirmation, a failure, the detail page's 版本 group and the nav dot.
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

/** The row while an upgrade waits or runs. */
export function runningLine(run: ExecutorUpgradeView, now: number): string {
  if (run.state === 'running')
    return `正在升级到 ${run.target}… 已用 ${seconds(now - run.startedAt)}`
  if (run.waitingFor)
    return `等 ${run.waitingFor} 个子任务结束后升级到 ${run.target}…`
  if (run.queued) return `等另一个升级完成后升级到 ${run.target}…`
  return `正在准备升级到 ${run.target}…`
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
  if (failedRun(version, run)) return { text: `${base} · 升级没有完成` }
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
  return { text: `${base} · 已是最新${recent ? ' · 刚刚升级' : ''}` }
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
  const why: Record<NonNullable<ExecutorUpgradeView['reason']>, string> = {
    permission: `没有写入 ${run.path ?? '安装目录'} 的权限`,
    network: '连不上网络，没有下载到新版本',
    timeout: '10 分钟没有完成，已停止',
    start: '升级命令没能启动',
    'not-upgraded': `命令已结束，但重新检测到的仍是 ${run.installed ?? run.from ?? '原来的版本'}`,
    exit:
      run.exitCode !== undefined
        ? `命令以退出码 ${run.exitCode} 结束`
        : '命令意外结束',
  }
  const tail = '你可以在终端里自己运行下面这条命令，完成后点「重新检测」：'
  return {
    title: `${NAME[run.backend]} 升级失败：${why[run.reason ?? 'exit']}`,
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
