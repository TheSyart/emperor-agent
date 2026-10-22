import { execFile } from 'node:child_process'
import { accessSync, constants, existsSync } from 'node:fs'
import { delimiter } from 'node:path'
import { logger } from '../../util/log'
import type { CodexProtocol } from './compatibility'
import type { ExecutorDispatchGate } from './dispatch-gate'
import {
  EXECUTOR_PACKAGES,
  detectInstallSource,
  installLocation,
  upgradeCommand,
  type ExecutorInstallSource,
  type UpgradeCommand,
} from './install-source'
import {
  claudeUpgradeTarget,
  codexUpgradeTarget,
  type PublishedVersionStore,
} from './published-versions'
import {
  DelegationError,
  type ExecutorProbe,
  type ExecutorProfile,
  type ExecutorUpgradeView,
  type ExecutorVersionView,
  type ExecutorVersionsView,
  type ExternalBackend,
} from './types'
import {
  classifyUpgradeFailure,
  startUpgradeProcess,
  type UpgradeOutcome,
  type UpgradeRun,
} from './upgrade-process'

const log = logger.child({ component: 'executors' })

const NAMES: Record<ExternalBackend, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
}
const DAY_MS = 24 * 60 * 60 * 1000
/** Opening 设置 › 子智能体 checks again after this long. */
const PAGE_CHECK_MS = 60_000
const LOG_LINES = 200
/** Variables an upgrade command never needs: credentials, Emperor's own. */
const DROPPED =
  /^(?:ANTHROPIC_|CLAUDE_CODE_OAUTH|OPENAI_|CODEX_|AZURE_OPENAI_|EMPEROR_)/

export interface ExecutorUpgradeServiceOptions {
  /** `<delegations>`: the version cache lives here. */
  root: string
  /** The user's home: commands run there; ~ in their output. */
  home: string
  profiles: () => readonly ExecutorProfile[]
  /** The executable a profile runs (PATH, the login shell's PATH). */
  locate: (profile: ExecutorProfile) => Promise<string | undefined>
  /** The last probe of a profile, for its installed version. */
  lastProbe: (profile: ExecutorProfile) => ExecutorProbe | null
  /** Probes again and keeps the result (重新检测). */
  probe: (profileId: string) => Promise<ExecutorProbe>
  /** The executors' environment (PATH with the usual install folders). */
  environment: () => NodeJS.ProcessEnv
  /** Claude Code's dedicated config folder: `claude install` records go there, never ~/.claude. */
  claudeConfigDir?: () => string
  published: PublishedVersionStore
  /** Test hook: the verified Codex protocols (default: KNOWN_CODEX_PROTOCOLS). */
  codexProtocols?: readonly CodexProtocol[]
  /** Its subtasks running now. */
  activeRuns: (backend: ExternalBackend) => number
  gate: ExecutorDispatchGate
  /** Host events: `executor_upgrade` (an upgrade, or the versions). */
  emit: (event: Record<string, unknown>) => void
  /** The once-a-day check at startup may run here (the packaged app, or a test registry). */
  automatic: boolean
  /** What `brew upgrade` would install. */
  homebrewVersion?: (source: ExecutorInstallSource) => Promise<string | null>
  pollMs?: number
  graceMs?: number
  timeoutMs?: number
  startupDelayMs?: number
  now?: () => number
}

interface Entry {
  view: ExecutorVersionView
  plan?: UpgradeCommand
}

interface Run {
  view: ExecutorUpgradeView
  cancelled: boolean
  process?: UpgradeRun
  done: Promise<void>
  wake?: () => void
  flush?: ReturnType<typeof setTimeout>
}

const finished = (run: Run) =>
  run.view.state !== 'waiting' && run.view.state !== 'running'

/**
 * 设置 › 子智能体's versions and 升级 (AGT-13): what is installed and how,
 * what npm has, what 升级 installs; and the upgrade itself — after the
 * user confirmed, with the command of the install source, one command at
 * a time, never two upgrades of one executor. The executor takes no new
 * delegations meanwhile, and the upgrade waits for its running subtasks.
 * Afterwards it probes again; a failure says why and gives the command.
 */
export class ExecutorUpgradeService {
  private readonly runs = new Map<string, Run>()
  private holder: Run | null = null
  private queue: Array<() => void> = []
  private lastCheck = -Infinity
  private startup?: ReturnType<typeof setTimeout>
  private readonly brewVersions = new Map<string, Promise<string | null>>()
  private readonly now: () => number
  constructor(readonly options: ExecutorUpgradeServiceOptions) {
    this.now = options.now ?? Date.now
  }

  /** The check once a day, at startup (not while running for days). */
  start(): void {
    if (!this.options.automatic || !this.options.published.due(DAY_MS)) return
    this.startup = setTimeout(
      () => void this.check().catch(() => undefined),
      this.options.startupDelayMs ?? 30_000,
    )
    this.startup.unref?.()
  }

  async close(): Promise<void> {
    if (this.startup) clearTimeout(this.startup)
    await Promise.all(
      [...this.runs.values()]
        .filter((run) => !finished(run))
        .map((run) => this.stop(run)),
    )
  }

  private async check(): Promise<void> {
    this.lastCheck = this.now()
    this.brewVersions.clear()
    await this.options.published.check()
    this.options.emit({
      event: 'executor_upgrade',
      versions: await this.view(),
    })
  }

  /** `refresh`: true asks npm now; 'auto' (the page opened) unless it just did. */
  async versions(
    input: { refresh?: boolean | 'auto' } = {},
  ): Promise<ExecutorVersionsView> {
    if (
      input.refresh === true ||
      (input.refresh === 'auto' && this.now() - this.lastCheck >= PAGE_CHECK_MS)
    )
      await this.check()
    return this.view()
  }

  /** 稍后: no notice or dot for the versions offered now. */
  async dismiss(): Promise<ExecutorVersionsView> {
    const entries = await this.entries()
    this.options.published.dismiss(
      Object.fromEntries(
        entries
          .filter((e) => e.view.enabled && e.view.target && e.plan?.oneClick)
          .map((e) => [e.view.profileId, e.view.target!]),
      ),
    )
    const view = await this.view(entries)
    this.options.emit({ event: 'executor_upgrade', versions: view })
    return view
  }

  private external(): ExecutorProfile[] {
    return this.options
      .profiles()
      .filter((p) => p.backend === 'claude-code' || p.backend === 'codex')
  }

  private async entries(): Promise<Entry[]> {
    return Promise.all(this.external().map((p) => this.entry(p)))
  }

  private async view(entries?: Entry[]): Promise<ExecutorVersionsView> {
    const list = entries ?? (await this.entries())
    const snapshot = this.options.published.read()
    const dismissed = this.options.published.dismissed()
    const offered = list.filter(
      (e) => e.view.enabled && e.view.target && e.plan?.oneClick,
    )
    return {
      checkedAt: snapshot.checkedAt,
      checking: this.options.published.checking,
      error: snapshot.error,
      executors: list.map((e) => e.view),
      upgrades: [...this.runs.values()].map((run) => structuredClone(run.view)),
      dismissed:
        offered.length > 0 &&
        offered.every((e) => dismissed[e.view.profileId] === e.view.target),
    }
  }

  private async entry(profile: ExecutorProfile): Promise<Entry> {
    const { backend } = profile
    const probe = this.options.lastProbe(profile)
    const installed = probe?.executableVersion ?? null
    let source: ExecutorInstallSource | undefined
    if (probe && probe.status !== 'missing') {
      const executable = await this.options
        .locate(profile)
        .catch(() => undefined)
      if (executable)
        source = detectInstallSource(executable, backend, {
          home: this.options.home,
          path: this.options.environment().PATH,
        })
    }
    const published =
      this.options.published.read().packages[EXECUTOR_PACKAGES[backend]]
    let target: string | null
    let unverified: string | null = null
    let verified: string[] = []
    if (backend === 'claude-code')
      target = claudeUpgradeTarget(installed, published?.latest ?? null)
    else
      ({ target, unverified, verified } = codexUpgradeTarget(
        installed,
        published,
        ...(this.options.codexProtocols ? [this.options.codexProtocols] : []),
      ))
    // An upgrade of what is installed; installing is the user's.
    if (!installed) target = null
    let plan: UpgradeCommand | undefined
    if (target && source)
      plan = upgradeCommand(source, backend, target, {
        ...(source.homebrew
          ? { homebrewVersion: await this.homebrewVersion(source) }
          : {}),
      })
    return {
      plan,
      view: {
        profileId: profile.id,
        backend,
        enabled: profile.enabled,
        installed,
        install: {
          kind: source?.kind ?? 'unknown',
          location: source ? installLocation(source) : null,
        },
        latest: published?.latest ?? null,
        verified,
        target,
        unverified,
        upgrade: plan
          ? {
              oneClick: plan.oneClick,
              command: plan.command,
              ...(plan.manual ? { manual: plan.manual } : {}),
            }
          : null,
        activeRuns: this.options.activeRuns(backend),
      },
    }
  }

  private homebrewVersion(
    source: ExecutorInstallSource,
  ): Promise<string | null> {
    const brew = source.homebrew!
    const key = `${brew.cask ? 'cask' : 'formula'}:${brew.name}`
    let pending = this.brewVersions.get(key)
    if (!pending) {
      pending = (this.options.homebrewVersion ?? brewInfoVersion)(source).catch(
        () => null,
      )
      this.brewVersions.set(key, pending)
    }
    return pending
  }

  /** 升级: starts it (after the user confirmed); a second click joins it. */
  async upgrade(input: {
    profileId: string
    target: string
  }): Promise<{ upgrade: ExecutorUpgradeView }> {
    const running = this.runs.get(input.profileId)
    if (running && !finished(running))
      return { upgrade: structuredClone(running.view) }
    const profile = this.external().find((p) => p.id === input.profileId)
    if (!profile)
      throw new DelegationError(
        'EXECUTOR_NOT_FOUND',
        'unknown executor profile',
      )
    const { view, plan } = await this.entry(profile)
    if (
      !plan?.oneClick ||
      !plan.argv ||
      !plan.command ||
      view.target !== input.target
    )
      throw new DelegationError(
        'EXECUTOR_UPGRADE_UNAVAILABLE',
        'this version is not offered as a one-click upgrade',
      )
    const again = this.runs.get(input.profileId)
    if (again && !finished(again))
      return { upgrade: structuredClone(again.view) }
    const waiting = this.options.activeRuns(profile.backend)
    const run: Run = {
      cancelled: false,
      done: Promise.resolve(),
      view: {
        profileId: profile.id,
        backend: profile.backend,
        from: view.installed,
        target: input.target,
        command: plan.command,
        state: 'waiting',
        ...(waiting ? { waitingFor: waiting } : {}),
        startedAt: this.now(),
        log: [`$ ${plan.command}`],
      },
    }
    this.runs.set(profile.id, run)
    this.options.gate.hold(profile.backend)
    log.info('executor upgrade started', {
      profileId: profile.id,
      from: view.installed,
      target: input.target,
      source: view.install.kind,
    })
    run.done = this.drive(run, profile, plan).catch((error) => {
      log.warn('executor upgrade failed unexpectedly', {
        profileId: profile.id,
        error: error instanceof Error ? error.message : String(error),
      })
      if (!finished(run)) this.end(run, { state: 'failed', reason: 'exit' })
    })
    this.update(run)
    return { upgrade: structuredClone(run.view) }
  }

  /** 取消: before the command runs it never starts; while it runs, its group is stopped. */
  async cancel(input: {
    profileId: string
  }): Promise<{ upgrade: ExecutorUpgradeView | null }> {
    const run = this.runs.get(input.profileId)
    if (!run) return { upgrade: null }
    if (!finished(run)) await this.stop(run)
    return { upgrade: structuredClone(run.view) }
  }

  private async stop(run: Run): Promise<void> {
    run.cancelled = true
    run.wake?.()
    this.wakeQueue()
    await run.process?.cancel()
    await run.done
  }

  private wakeQueue() {
    for (const wake of this.queue.splice(0)) wake()
  }

  private async drive(
    run: Run,
    profile: ExecutorProfile,
    plan: UpgradeCommand,
  ): Promise<void> {
    const { backend } = profile
    let installing = false
    try {
      // Its running subtasks finish first; then one command at a time.
      for (;;) {
        while (!run.cancelled) {
          const count = this.options.activeRuns(backend)
          if (!count) break
          if (run.view.waitingFor !== count) {
            run.view.waitingFor = count
            this.update(run)
          }
          await new Promise<void>((resolve) => {
            run.wake = resolve
            setTimeout(resolve, this.options.pollMs ?? 1000).unref?.()
          })
        }
        if (run.cancelled) return this.end(run, { state: 'cancelled' })
        if (this.holder && this.holder !== run) {
          if (!run.view.queued) {
            run.view.queued = true
            this.update(run)
          }
          await new Promise<void>((resolve) => this.queue.push(resolve))
          continue
        }
        // A follow-up may have started while it waited in the queue.
        if (this.options.activeRuns(backend)) continue
        break
      }
      this.holder = run
      this.options.gate.installing(backend)
      installing = true
      delete run.view.waitingFor
      delete run.view.queued
      const blocked = plan.writes?.find((dir) => !writable(dir))
      if (blocked)
        return this.end(run, {
          state: 'failed',
          reason: 'permission',
          path: blocked,
          manualCommand: plan.command!,
          ...(run.view.from ? { installed: run.view.from } : {}),
        })
      run.view.state = 'running'
      this.update(run)
      const started = await startUpgradeProcess({
        argv: plan.argv!,
        env: this.commandEnvironment(plan, backend),
        cwd: existsSync(this.options.home) ? this.options.home : '/',
        home: this.options.home,
        onLine: (line) => this.line(run, line),
        ...(this.options.timeoutMs
          ? { timeoutMs: this.options.timeoutMs }
          : {}),
        ...(this.options.graceMs ? { graceMs: this.options.graceMs } : {}),
      })
      run.process = started
      if (run.cancelled) void started.cancel()
      const outcome = await started.done
      this.line(run, `正在重新检测 ${NAMES[backend]}…`)
      let probe: ExecutorProbe | undefined
      try {
        probe = await this.options.probe(profile.id)
      } catch {
        probe = undefined
      }
      this.end(run, this.outcome(run, plan, outcome, probe), probe)
    } finally {
      if (installing) this.options.gate.installing(backend, false)
      if (this.holder === run) this.holder = null
      this.wakeQueue()
      this.options.gate.release(backend)
      void this.view()
        .then((versions) =>
          this.options.emit({ event: 'executor_upgrade', versions }),
        )
        .catch(() => undefined)
    }
  }

  private outcome(
    run: Run,
    plan: UpgradeCommand,
    outcome: UpgradeOutcome,
    probe: ExecutorProbe | undefined,
  ): Partial<ExecutorUpgradeView> {
    const installed = probe?.executableVersion
    const base = {
      ...(installed ? { installed } : {}),
      ...(outcome.exitCode !== null ? { exitCode: outcome.exitCode } : {}),
    }
    const failed = {
      ...base,
      state: 'failed' as const,
      manualCommand: plan.command!,
    }
    if (outcome.ended === 'cancelled') return { ...base, state: 'cancelled' }
    if (outcome.ended === 'timeout') return { ...failed, reason: 'timeout' }
    if (outcome.ended === 'start') return { ...failed, reason: 'start' }
    if (outcome.exitCode === 0)
      return installed === run.view.target
        ? { ...base, state: 'succeeded' }
        : { ...failed, reason: 'not-upgraded' }
    const reason = classifyUpgradeFailure(outcome.output)
    return {
      ...failed,
      reason,
      ...(reason === 'permission' && plan.writes?.[0]
        ? { path: plan.writes[0] }
        : {}),
    }
  }

  private commandEnvironment(
    plan: UpgradeCommand,
    backend: ExternalBackend,
  ): Record<string, string> {
    const ambient = this.options.environment()
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(ambient))
      if (value !== undefined && !DROPPED.test(key)) env[key] = value
    env.PATH = [plan.path, ambient.PATH].filter(Boolean).join(delimiter)
    Object.assign(env, {
      NO_COLOR: '1',
      npm_config_update_notifier: 'false',
      npm_config_fund: 'false',
      npm_config_audit: 'false',
      npm_config_progress: 'false',
      ...plan.env,
    })
    const config = this.options.claudeConfigDir?.()
    if (backend === 'claude-code' && config) env.CLAUDE_CONFIG_DIR = config
    return env
  }

  private line(run: Run, line: string) {
    const lines = run.view.log
    lines.push(line)
    // The command stays first; the latest output after it.
    if (lines.length > LOG_LINES) lines.splice(1, lines.length - LOG_LINES)
    run.flush ??= setTimeout(() => {
      run.flush = undefined
      if (!finished(run)) this.update(run)
    }, 250)
  }

  private end(
    run: Run,
    patch: Partial<ExecutorUpgradeView>,
    probe?: ExecutorProbe,
  ) {
    if (run.flush) clearTimeout(run.flush)
    run.flush = undefined
    Object.assign(run.view, patch, { finishedAt: this.now() })
    delete run.view.waitingFor
    delete run.view.queued
    log.info('executor upgrade ended', {
      profileId: run.view.profileId,
      state: run.view.state,
      ...(run.view.reason ? { reason: run.view.reason } : {}),
      ...(run.view.exitCode !== undefined
        ? { exitCode: run.view.exitCode }
        : {}),
      ...(run.view.installed ? { installed: run.view.installed } : {}),
    })
    this.update(run, probe)
  }

  private update(run: Run, probe?: ExecutorProbe) {
    this.options.emit({
      event: 'executor_upgrade',
      upgrade: structuredClone(run.view),
      ...(probe ? { probe } : {}),
    })
  }
}

/** A folder that exists and this user cannot write. */
function writable(dir: string): boolean {
  if (!existsSync(dir)) return true
  try {
    accessSync(dir, constants.W_OK)
    return true
  } catch {
    return false
  }
}

/** `brew info --json=v2`: the version `brew upgrade` installs (no update first). */
function brewInfoVersion(
  source: ExecutorInstallSource,
): Promise<string | null> {
  const brew = source.homebrew
  if (!brew?.brew) return Promise.resolve(null)
  return new Promise((resolve) => {
    execFile(
      brew.brew!,
      ['info', '--json=v2', brew.cask ? '--cask' : '--formula', brew.name],
      {
        timeout: 20_000,
        maxBuffer: 4 * 1024 * 1024,
        env: {
          ...process.env,
          HOMEBREW_NO_AUTO_UPDATE: '1',
          HOMEBREW_NO_ANALYTICS: '1',
          PATH: [process.env.PATH, '/usr/bin', '/bin']
            .filter(Boolean)
            .join(delimiter),
        },
      },
      (error, stdout) => {
        if (error) return resolve(null)
        try {
          const data = JSON.parse(String(stdout)) as {
            formulae?: Array<{ versions?: { stable?: string } }>
            casks?: Array<{ version?: string }>
          }
          const version = brew.cask
            ? data.casks?.[0]?.version
            : data.formulae?.[0]?.versions?.stable
          resolve(typeof version === 'string' ? version.split(',')[0]! : null)
        } catch {
          resolve(null)
        }
      },
    )
  })
}
