/**
 * The offline self-check of an installed Claude Code or Codex (VER-04).
 *
 * After 升级 or 退回, when a probe finds another version than last time,
 * on 「重新检查」, and before a task goes to a version never checked, Emperor
 * starts the CLI once in a private folder (`<delegations>/self-check/<id>`,
 * removed afterwards) and reads only what it reports at startup. No prompt
 * is sent, so no model is called: Claude Code gets a dummy key and its
 * Messages API on a stand-in on 127.0.0.1 (which also spares the ~20 s its
 * startup otherwise spends retrying api.anthropic.com, VER-01); Codex gets
 * a private CODEX_HOME without a login.
 *
 * - Claude Code: started with no builtin turned off (a raw ledger), the
 *   run's own preflight (preflightClaudePlugins) turns off what it ships
 *   and checks that they are off, then mcpServerStatus(). Builtins learned
 *   go to Emperor's ledger. A plugin that is not builtin, one that stays
 *   on, an MCP server or hooks not applied make the version incompatible.
 * - Codex: the probe's protocol digest (one Emperor did not verify is a
 *   warning, not a block: AGT-13 runs it as 「可能不兼容」, and only a run
 *   that really fails counts against the version), `codex features list`
 *   with Emperor's overrides against the recorded defaults (a new feature
 *   on by default is noted, not blocking), and the app-server opened the
 *   way a run opens it.
 *
 * The result goes into ExecutorHealthStore (versions[v].selfCheck). The
 * user's ~/.claude, ~/.codex and Emperor's own Claude login folder are
 * never read or written.
 */
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { delimiter, join } from 'node:path'
import {
  startup as sdkStartup,
  type Options,
  type Query,
  type WarmQuery,
} from '@anthropic-ai/claude-agent-sdk'
import { logger } from '../../util/log'
import { ClaudeExecutorAdapter } from './adapters/claude'
import { CODEX_FEATURES, CodexExecutorAdapter } from './adapters/codex'
import { BuiltinPluginLedger } from './claude-builtin-plugins'
import { installClaudeSecurity } from './claude-keychain'
import {
  CODEX_FEATURE_DEFAULTS,
  CODEX_REMOVED_FEATURES,
  KNOWN_CLAUDE_VERSIONS,
  type VerifiedClaudeVersion,
} from './compatibility'
import type {
  ExecutorHealthStore,
  SelfCheckIssue,
  SelfCheckResult,
} from './executor-health'
import { describeUnapprovedExtensions, sanitizeFailureMessage } from './failure'
import { ManagedAgentProcess } from './process'
import type { ExecutorRegistry } from './registry'
import {
  DelegationError,
  ExecutorRefusal,
  type ExecutorAdapter,
  type ExecutorOpenInput,
  type ExecutorProbe,
  type ExecutorProfile,
  type ExternalBackend,
} from './types'

export type { SelfCheckIssue, SelfCheckResult } from './executor-health'

const log = logger.child({ component: 'executors' })

/** Why it runs (for core.log). */
export type SelfCheckReason =
  'upgrade' | 'rollback' | 'version_changed' | 'manual' | 'dispatch'

/** The longest a self-check may take; a task waits at most this long. */
export const SELF_CHECK_TIMEOUT_MS = 15_000
/** A version change checks again at most once in this time. */
export const SELF_CHECK_DEDUPE_MS = 30_000
/** Not a real key: the self-check never reaches a model. */
export const SELF_CHECK_KEY = 'sk-ant-api03-offline-probe'
/** How long a stopped check may take to let go of its folder. */
const STOP_WAIT_MS = 2_000
/** Each control request after startup. */
const CONTROL_TIMEOUT_MS = 5_000

const NAME: Record<ExternalBackend, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
}

export interface ExecutorSelfCheckOptions {
  /** `<delegations>`: the private folders go under `self-check/`. */
  root: string
  registry: Pick<ExecutorRegistry, 'probe' | 'locate'>
  /** The executors' environment: only its PATH and LANG are used. */
  environment: () => NodeJS.ProcessEnv
  health: Pick<ExecutorHealthStore, 'recordSelfCheck' | 'selfCheckOf'>
  /** Emperor's builtin plugin ledger: what Claude Code ships is learned. */
  ledger: BuiltinPluginLedger
  processes?: ManagedAgentProcess
  /** A check started or ended: the settings page reads the versions again. */
  changed?: (profileId: string) => void
  /**
   * false: no check starts by itself (background() does nothing, gate()
   * only reads a stored result); 重新检查 still runs. Default true.
   */
  automatic?: boolean
  /** Test hook: the Agent SDK's startup (the fake SDK). */
  claudeStartup?: (
    options: Options,
  ) => Promise<Pick<WarmQuery, 'query' | 'close'>>
  /** Test hook: runs `codex features list` and returns its output. */
  codexFeatures?: (
    executable: string,
    args: string[],
    env: Record<string, string>,
  ) => Promise<string>
  /** Test hook: what opens the app-server (default: the run's adapter). */
  codexAdapter?: Pick<ExecutorAdapter, 'open'>
  /** Test hook: the verified Claude Code releases. */
  claudeVersions?: readonly VerifiedClaudeVersion[]
  timeoutMs?: number
  /** How long gate() waits for a check before the task goes on. */
  gateTimeoutMs?: number
  dedupeMs?: number
  now?: () => number
}

interface Found {
  issues: SelfCheckIssue[]
  adapted?: NonNullable<SelfCheckResult['adapted']>
}

/** Blocking → incompatible; builtins turned off → adapted; failed → error. */
function statusOf(found: Found): SelfCheckResult['status'] {
  if (found.issues.some((i) => i.blocking)) return 'incompatible'
  if (found.adapted?.builtinPluginsDisabled.length) return 'adapted'
  if (
    found.issues.some((i) => i.code === 'timeout' || i.code === 'start_failed')
  )
    return 'error'
  return 'ok'
}

function within<T>(run: () => Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    Promise.resolve().then(run),
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('timed out')), ms)
      timer.unref?.()
    }),
  ]).finally(() => clearTimeout(timer))
}

const message = (error: unknown) =>
  sanitizeFailureMessage(
    error instanceof Error ? error.message : String(error),
    [SELF_CHECK_KEY],
    200,
  )

/** Answers every request with an error: no model behind it. */
async function messagesStandIn(): Promise<{
  url: string
  requests: () => number
  close: () => Promise<void>
}> {
  let requests = 0
  const server = createServer((request, response) => {
    requests++
    request.resume()
    response.writeHead(503, { 'content-type': 'application/json' })
    response.end(
      '{"type":"error","error":{"type":"overloaded_error","message":"Emperor self-check: no model here"}}',
    )
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    requests: () => requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.()
        server.close(() => resolve())
      }),
  }
}

/** `codex features list`: name → on. */
function parseFeatureList(output: string): Record<string, boolean> {
  const effective: Record<string, boolean> = {}
  for (const line of output.split('\n')) {
    const [name, , state] = line.trim().split(/\s{2,}/)
    if (name && (state === 'true' || state === 'false'))
      effective[name] = state === 'true'
  }
  return effective
}

/** Emperor's overrides as `codex features … list` arguments. */
export function codexFeatureListArgs(): string[] {
  return [
    'features',
    ...Object.entries(CODEX_FEATURES).flatMap(([name, on]) => [
      '-c',
      `features.${name}=${on}`,
    ]),
    'list',
  ]
}

function runFeatureList(
  executable: string,
  args: string[],
  env: Record<string, string>,
): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(
      executable,
      args,
      { env, timeout: 10_000, maxBuffer: 1024 * 1024, shell: false },
      (error, stdout) => (error ? reject(error) : resolve(String(stdout))),
    ),
  )
}

export class ExecutorSelfCheck {
  private readonly inflight = new Map<string, Promise<SelfCheckResult>>()
  private readonly started = new Map<string, number>()
  private readonly controllers = new Set<AbortController>()
  private readonly processes: ManagedAgentProcess
  private readonly now: () => number
  private closed = false
  constructor(readonly options: ExecutorSelfCheckOptions) {
    this.processes = options.processes ?? new ManagedAgentProcess()
    this.now = options.now ?? Date.now
  }

  /** A self-check of this profile runs now. */
  running(profileId: string): boolean {
    return this.inflight.has(profileId)
  }

  /** Checks now; a second call while one runs gets the same result. */
  run(
    profile: ExecutorProfile,
    reason: SelfCheckReason,
  ): Promise<SelfCheckResult> {
    const going = this.inflight.get(profile.id)
    if (going) return going
    const pending = this.check(profile, reason).finally(() => {
      this.inflight.delete(profile.id)
      this.options.changed?.(profile.id)
    })
    this.inflight.set(profile.id, pending)
    this.options.changed?.(profile.id)
    return pending
  }

  /** In the background, at most once in 30 s per profile. */
  background(profile: ExecutorProfile, reason: SelfCheckReason): void {
    if (this.options.automatic === false || this.closed) return
    if (this.inflight.has(profile.id)) return
    const at = this.now()
    const last = this.started.get(profile.id)
    if (
      last !== undefined &&
      at - last < (this.options.dedupeMs ?? SELF_CHECK_DEDUPE_MS)
    )
      return
    this.started.set(profile.id, at)
    void this.run(profile, reason).catch(() => undefined)
  }

  /**
   * Before a task goes to `version`: its stored result, or a check now. A
   * check that takes longer than the limit lets the task go on (null) and
   * finishes in the background.
   */
  async gate(
    profile: ExecutorProfile,
    version: string | undefined,
    signal?: AbortSignal,
  ): Promise<SelfCheckResult | null> {
    if (!version) return null
    const stored = this.options.health.selfCheckOf(profile.id, version)
    if (stored) return stored
    if (this.options.automatic === false || this.closed) return null
    const pending = this.run(profile, 'dispatch')
    let timer: ReturnType<typeof setTimeout> | undefined
    let stop: (() => void) | undefined
    try {
      return await Promise.race([
        pending,
        new Promise<null>((resolve) => {
          timer = setTimeout(
            () => resolve(null),
            this.options.gateTimeoutMs ?? SELF_CHECK_TIMEOUT_MS,
          )
          timer.unref?.()
        }),
        new Promise<never>((_resolve, reject) => {
          stop = () =>
            reject(new DelegationError('ABORTED', 'stopped during self-check'))
          if (signal?.aborted) stop()
          else signal?.addEventListener('abort', stop, { once: true })
        }),
      ])
    } finally {
      clearTimeout(timer)
      if (stop) signal?.removeEventListener('abort', stop)
    }
  }

  /** Every check started so far has ended. */
  async idle(): Promise<void> {
    while (this.inflight.size)
      await Promise.allSettled([...this.inflight.values()])
  }

  async close(): Promise<void> {
    this.closed = true
    for (const controller of this.controllers) controller.abort()
    await this.idle()
  }

  private async check(
    profile: ExecutorProfile,
    reason: SelfCheckReason,
  ): Promise<SelfCheckResult> {
    const checkedAt = this.now()
    const started = Date.now()
    const name = NAME[profile.backend]
    let probe: ExecutorProbe | undefined
    try {
      probe = await this.options.registry.probe(profile)
    } catch {
      probe = undefined
    }
    const version = probe?.executableVersion
    const base = {
      backend: profile.backend,
      version: version ?? 'unknown',
      checkedAt,
      modelCalls: 0 as const,
    }
    // A version it cannot read is not checked (the probe says why).
    if (!probe || !version)
      return {
        ...base,
        status: 'error',
        issues: [
          {
            code: 'start_failed',
            detail: `读不到 ${name} 的版本号，没有自检。`,
            blocking: false,
          },
        ],
      }
    const dir = join(this.options.root, 'self-check', randomUUID())
    const controller = new AbortController()
    this.controllers.add(controller)
    const timeoutMs = this.options.timeoutMs ?? SELF_CHECK_TIMEOUT_MS
    let timer: ReturnType<typeof setTimeout> | undefined
    let found: Found
    try {
      for (const sub of ['home', 'config', 'codex', 'tmp', 'workspace', 'bin'])
        mkdirSync(join(dir, sub), { recursive: true, mode: 0o700 })
      const work =
        profile.backend === 'claude-code'
          ? this.claude(profile, probe, dir, controller.signal, timeoutMs)
          : this.codex(profile, probe, dir, controller.signal)
      const outcome = await Promise.race([
        work,
        new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => resolve('timeout'), timeoutMs)
          timer.unref?.()
        }),
      ])
      if (outcome === 'timeout') {
        controller.abort()
        // Let it stop and let go of its folder, but never wait for long.
        await Promise.race([
          work.catch(() => undefined),
          new Promise((resolve) => setTimeout(resolve, STOP_WAIT_MS)),
        ])
        found = {
          issues: [
            {
              code: 'timeout',
              detail: `${name} ${version} 的自检超过 ${Math.round(timeoutMs / 1000)} 秒没有完成。`,
              blocking: false,
            },
          ],
        }
      } else found = outcome
    } catch (error) {
      found = {
        issues: [
          {
            code: 'start_failed',
            detail: `${name} ${version} 的自检没能启动：${message(error)}`,
            blocking: false,
          },
        ],
      }
    } finally {
      clearTimeout(timer)
      this.controllers.delete(controller)
      rmSync(dir, { recursive: true, force: true })
    }
    const result: SelfCheckResult = {
      ...base,
      status: statusOf(found),
      ...(found.adapted?.builtinPluginsDisabled.length
        ? { adapted: found.adapted }
        : {}),
      issues: found.issues,
    }
    this.options.health.recordSelfCheck(profile.id, version, result)
    log.info('executor self-check', {
      profileId: profile.id,
      version,
      reason,
      status: result.status,
      issues: result.issues.map((i) => i.code),
      ms: Date.now() - started,
    })
    return result
  }

  private claudeEnvironment(
    dir: string,
    messagesUrl: string,
  ): Record<string, string> {
    const ambient = this.options.environment()
    const home = join(dir, 'home')
    // Its keychain lookups answer "not found" (FIX-19): no dialog, no login.
    installClaudeSecurity(join(dir, 'bin'))
    return {
      PATH: [join(dir, 'bin'), ambient.PATH].filter(Boolean).join(delimiter),
      ...(ambient.LANG ? { LANG: ambient.LANG } : {}),
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: join(home, '.config'),
      XDG_CACHE_HOME: join(home, '.cache'),
      CLAUDE_CONFIG_DIR: join(dir, 'config'),
      TMPDIR: join(dir, 'tmp'),
      CLAUDE_CODE_TMPDIR: join(dir, 'tmp'),
      ANTHROPIC_API_KEY: SELF_CHECK_KEY,
      ANTHROPIC_BASE_URL: messagesUrl,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      DISABLE_AUTOUPDATER: '1',
      NO_PROXY: '127.0.0.1,localhost',
      no_proxy: '127.0.0.1,localhost',
    }
  }

  private openInput(
    profile: ExecutorProfile,
    executable: string,
    dir: string,
    environment: Record<string, string>,
    signal: AbortSignal,
    version: string,
  ): ExecutorOpenInput {
    return {
      delegationId: 'dlg-self-check',
      profile: { ...profile, executablePath: executable },
      cwd: join(dir, 'workspace'),
      environment,
      runtimeRoot: dir,
      policy: {
        mode: 'read-only',
        workspaceRoot: join(dir, 'workspace'),
        runtimeStateRoots: [
          join(dir, 'home'),
          join(dir, 'config'),
          join(dir, 'codex'),
          join(dir, 'tmp'),
        ],
        privateTempRoot: join(dir, 'tmp'),
      },
      boundaryReceiptId: 'self-check',
      generation: 1,
      signal,
      executableVersion: version,
    }
  }

  private async claude(
    profile: ExecutorProfile,
    probe: ExecutorProbe,
    dir: string,
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<Found> {
    const version = probe.executableVersion!
    const messages = await messagesStandIn()
    // Nothing off at launch: the preflight shows what this release ships.
    const raw = new BuiltinPluginLedger(undefined, { seed: false })
    const start =
      this.options.claudeStartup ??
      ((options: Options) =>
        sdkStartup({ options, initializeTimeoutMs: timeoutMs }))
    let query: Partial<Query> | undefined
    const adapter = new ClaudeExecutorAdapter({
      processes: this.processes,
      ledger: raw,
      startup: async (options) => {
        const warm = await start(options)
        return {
          close: () => warm.close(),
          query: (prompts) => (query = warm.query(prompts) as Query),
        }
      },
    })
    const executable =
      (await this.options.registry.locate(profile).catch(() => undefined)) ??
      profile.executablePath
    let session: Awaited<ReturnType<ClaudeExecutorAdapter['open']>> | undefined
    try {
      session = await adapter.open(
        this.openInput(
          profile,
          executable,
          dir,
          this.claudeEnvironment(dir, messages.url),
          signal,
          version,
        ),
      )
      const issues: SelfCheckIssue[] = []
      try {
        const servers = (
          await within(() => query!.mcpServerStatus!(), CONTROL_TIMEOUT_MS)
        ).map((s) => String(s.name))
        if (servers.length)
          issues.push({
            code: 'mcp_server',
            detail: describeUnapprovedExtensions({ kind: 'mcp', servers }),
            blocking: true,
          })
      } catch {
        /* An older claude without mcpServerStatus: the init gate stays. */
      }
      const disabled = raw.disabled()
      if (!disabled.length) return { issues }
      this.options.ledger.learn(
        disabled.map((source) => ({
          name: source.replace(/@builtin$/u, ''),
          path: 'builtin',
          source,
        })),
        version,
      )
      const known = this.options.claudeVersions ?? KNOWN_CLAUDE_VERSIONS
      return {
        issues,
        adapted: {
          builtinPluginsDisabled: disabled,
          since: Object.fromEntries(
            disabled.map((source) => [
              source,
              known.find((k) => k.builtinPlugins.includes(source))?.version ??
                this.options.ledger.firstSeen(source) ??
                version,
            ]),
          ),
        },
      }
    } catch (error) {
      if (error instanceof ExecutorRefusal)
        return {
          issues: [
            {
              code: error.issue,
              detail: error.reason ?? error.message,
              blocking: true,
            },
          ],
        }
      throw error
    } finally {
      await session?.close().catch(() => undefined)
      await messages.close()
      if (messages.requests())
        log.warn('executor self-check: a request reached the stand-in', {
          profileId: profile.id,
          version,
          requests: messages.requests(),
        })
    }
  }

  private async codex(
    profile: ExecutorProfile,
    probe: ExecutorProbe,
    dir: string,
    signal: AbortSignal,
  ): Promise<Found> {
    const version = probe.executableVersion!
    const issues: SelfCheckIssue[] = []
    if (probe.status === 'incompatible')
      return {
        issues: [
          {
            code: 'protocol_unknown',
            detail: `Codex ${version} 不在 Emperor 支持的范围（${probe.requiredVersion ?? '已验证的版本'}）。`,
            blocking: true,
          },
        ],
      }
    if (probe.compatibility === 'unverified')
      issues.push(
        probe.protocolCheck === 'unreadable'
          ? {
              code: 'start_failed',
              detail: `Codex ${version} 没能生成协议说明，无法核对它的协议。`,
              blocking: false,
            }
          : {
              // Runnable, as AGT-13 decided: a warning, never a block.
              code: 'protocol_unknown',
              detail: `Codex ${version} 的协议与 Emperor 验证过的 ${probe.protocolVersion ?? '版本'} 不同，可能不兼容。`,
              blocking: false,
            },
      )
    const ambient = this.options.environment()
    const environment: Record<string, string> = {
      PATH: ambient.PATH ?? '',
      ...(ambient.LANG ? { LANG: ambient.LANG } : {}),
      HOME: join(dir, 'home'),
      USERPROFILE: join(dir, 'home'),
      XDG_CONFIG_HOME: join(dir, 'home', '.config'),
      XDG_CACHE_HOME: join(dir, 'home', '.cache'),
      CODEX_HOME: join(dir, 'codex'),
      TMPDIR: join(dir, 'tmp'),
    }
    const executable =
      (await this.options.registry.locate(profile).catch(() => undefined)) ??
      profile.executablePath
    // Features on by default that Emperor never reviewed (not blocking).
    const defaults = CODEX_FEATURE_DEFAULTS[probe.protocolVersion ?? '']
    const removed = CODEX_REMOVED_FEATURES[probe.protocolVersion ?? ''] ?? []
    try {
      const effective = parseFeatureList(
        await (this.options.codexFeatures ?? runFeatureList)(
          executable,
          codexFeatureListArgs(),
          environment,
        ),
      )
      if (defaults) {
        // A removed feature keeps its recorded value: Codex ignores the
        // override (VER-07), and the contract test pins what that leaves on.
        const expected = (feature: string) =>
          feature in CODEX_FEATURES && !removed.includes(feature)
            ? CODEX_FEATURES[feature]
            : defaults[feature] === true
        const extra = Object.keys(effective)
          .filter((feature) => effective[feature] && !expected(feature))
          .sort()
        if (extra.length)
          issues.push({
            code: 'feature_default_on',
            detail: `Codex ${version} 默认打开了 Emperor 没有核对过的功能：${extra.slice(0, 5).join('、')}${extra.length > 5 ? ` 等 ${extra.length} 个` : ''}。`,
            blocking: false,
          })
      }
    } catch {
      /* Codex 0.153 has no `features list`: that check is skipped. */
    }
    // The app-server, opened the way a run opens it; no turn.
    try {
      const adapter =
        this.options.codexAdapter ??
        new CodexExecutorAdapter({ processes: this.processes })
      const session = await adapter.open(
        this.openInput(profile, executable, dir, environment, signal, version),
      )
      await session.close().catch(() => undefined)
    } catch (error) {
      if (signal.aborted) throw error
      issues.push(
        error instanceof DelegationError &&
          error.code === 'EXECUTOR_INCOMPATIBLE'
          ? {
              code: 'protocol_unknown',
              detail: `Codex ${version} 的握手与 Emperor 验证过的不同：${message(error)}`,
              blocking: true,
            }
          : {
              code: 'start_failed',
              detail: `Codex ${version} 的 app-server 没能启动：${message(error)}`,
              blocking: false,
            },
      )
    }
    return { issues }
  }
}
