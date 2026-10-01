/**
 * Editor dictation in the main process (VO-01): one dictation at a time,
 * through the dictation helper (./helper-process). Main makes up each
 * session id, passes on the helper's events for that session only, in
 * sequence order and with at most one final result, and ends the dictation
 * itself when the helper dies, breaks the protocol or stops answering.
 */
import { randomUUID } from 'node:crypto'
import type {
  DictationEndReason,
  DictationErrorCode,
  DictationEvent,
  DictationStartRequest,
  DictationStartResult,
  DictationStatus,
} from '../../shared/ipc-contract'
import {
  DictationHelperProcess,
  spawnDictationHelper,
  type DictationSpawn,
  type HelperGone,
} from './helper-process'
import {
  DICTATION_MAX_SECONDS,
  validDevice,
  validLocale,
  type HelperSessionEvent,
} from './protocol'

/** Where one dictation's events go: the window that started it. */
export interface DictationListener {
  /** false: nobody is listening any more, and the dictation is cancelled. */
  deliver(event: DictationEvent): boolean
  /** The dictation is over, whichever way it ended. */
  closed?(): void
}

export interface DictationServiceOptions {
  readonly platform?: NodeJS.Platform
  /** The helper's executable, or null when this build has none. */
  readonly executable: () => string | null
  /** Packaged builds: check the helper's signature before its first launch. */
  readonly verify?: (executable: string) => Promise<void>
  readonly spawn?: DictationSpawn
  /** The helper's environment; by default a few variables of Emperor's. */
  readonly env?: NodeJS.ProcessEnv
  readonly randomId?: () => string
  /** Longest dictation, in seconds (default 300, at most 600). */
  readonly maxSeconds?: number
  readonly handshakeMs?: number
  readonly statusTimeoutMs?: number
  /** A start may wait on macOS asking for permission (default 2 minutes). */
  readonly startTimeoutMs?: number
  readonly stopTimeoutMs?: number
  readonly cancelTimeoutMs?: number
  /** An idle helper is let go after this long (default 5 minutes). */
  readonly idleExitMs?: number
  readonly log?: (message: string) => void
}

/** Variables the helper may see; nothing else of Emperor's environment. */
const HELPER_ENVIRONMENT = [
  'HOME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LOGNAME',
  'PATH',
  'TMPDIR',
  'USER',
  // Experiment E-D2: `speech-analyzer` selects macOS 26's SpeechAnalyzer.
  'EMPEROR_DICTATION_ENGINE',
]

export function helperEnvironment(
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const name of HELPER_ENVIRONMENT)
    if (source[name] !== undefined) env[name] = source[name]
  return env
}

/** Dictation cannot run here; the message is for the user. */
class Unavailable extends Error {}

type Phase = 'starting' | 'running' | 'stopping' | 'cancelling'

interface Session {
  readonly id: string
  readonly listener: DictationListener
  phase: Phase
  lastSeq: number
  hasFinal: boolean
  timer: ReturnType<typeof setTimeout> | undefined
}

const CRASH_WINDOW_MS = 60_000
const CRASH_LIMIT = 3
/** The helper ends a dictation at its maximum; main waits this much longer. */
const MAX_DURATION_GRACE_MS = 15_000

function refused(
  code: DictationErrorCode,
  message: string,
): DictationStartResult {
  return { ok: false, code, message }
}

export class DictationService {
  private readonly platform: NodeJS.Platform
  private readonly spawn: DictationSpawn
  private readonly env: NodeJS.ProcessEnv
  private readonly randomId: () => string
  private readonly maxSeconds: number
  private readonly log: (message: string) => void
  private helper: DictationHelperProcess | undefined
  private launching: Promise<DictationHelperProcess> | undefined
  private session: Session | undefined
  private verified = false
  private crashes: number[] = []
  private idleTimer: ReturnType<typeof setTimeout> | undefined
  private disposed = false

  constructor(private readonly options: DictationServiceOptions) {
    this.platform = options.platform ?? process.platform
    this.spawn = options.spawn ?? spawnDictationHelper
    this.env = options.env ?? helperEnvironment(process.env)
    this.randomId = options.randomId ?? randomUUID
    this.maxSeconds = Math.min(
      DICTATION_MAX_SECONDS,
      Math.max(1, Math.floor(options.maxSeconds ?? 300)),
    )
    this.log = options.log ?? ((message) => console.warn(message))
  }

  async status(): Promise<DictationStatus> {
    try {
      const helper = await this.ensureHelper()
      const status = await helper.status(this.options.statusTimeoutMs ?? 10_000)
      this.scheduleIdle()
      return {
        supported: true,
        available: true,
        engine: status.engine,
        permissions: status.permissions,
        devices: status.devices,
        locales: status.locales,
        systemLocale: status.systemLocale,
        active: this.session !== undefined,
      }
    } catch (error) {
      return {
        supported: this.platform === 'darwin',
        available: false,
        reason:
          error instanceof Unavailable
            ? error.message
            : '无法连接 Emperor Dictation Helper',
        engine: null,
        permissions: { microphone: 'unknown', speech: 'unknown' },
        devices: [],
        locales: [],
        systemLocale: null,
        active: this.session !== undefined,
      }
    }
  }

  /**
   * Starts a dictation and answers its session id. What happens next
   * (permission prompts, the language check, results) arrives as events.
   */
  async start(
    request: DictationStartRequest,
    listener: DictationListener,
  ): Promise<DictationStartResult> {
    const locale = request.locale ?? null
    const device = request.device ?? null
    if (locale !== null && !validLocale(locale))
      return refused('invalid_request', '语言代码无效')
    if (device !== null && !validDevice(device))
      return refused('invalid_request', '麦克风设备无效')
    if (this.session) return refused('busy', '已有一段听写正在进行')
    const session: Session = {
      id: this.randomId(),
      listener,
      phase: 'starting',
      lastSeq: 0,
      hasFinal: false,
      timer: undefined,
    }
    this.session = session
    let helper: DictationHelperProcess
    try {
      helper = await this.ensureHelper()
    } catch (error) {
      if (this.session === session) this.session = undefined
      return refused(
        'unavailable',
        error instanceof Unavailable
          ? error.message
          : '无法连接 Emperor Dictation Helper',
      )
    }
    if (this.session !== session) return refused('failed', '听写已取消')
    this.clearIdle()
    helper.send({
      type: 'start',
      session: session.id,
      locale,
      device,
      maxSeconds: this.maxSeconds,
    })
    this.arm(session, this.options.startTimeoutMs ?? 120_000, () => {
      this.helper?.send({ type: 'cancel', session: session.id })
      this.finish(session, {
        code: 'timeout',
        message: '听写没有按时开始（可能在等待系统授权）',
      })
    })
    return { ok: true, session: session.id }
  }

  /** Ends the audio; the final result and the end follow as events. */
  stop(id: string): boolean {
    const session = this.session
    if (!session || session.id !== id) return false
    if (session.phase === 'stopping' || session.phase === 'cancelling')
      return true
    session.phase = 'stopping'
    this.helper?.send({ type: 'stop', session: id })
    this.arm(session, this.options.stopTimeoutMs ?? 15_000, () => {
      this.finish(session, { code: 'timeout', message: '听写没有按时结束' })
      this.replaceHelper()
    })
    return true
  }

  /** Drops the dictation without a final result. */
  cancel(id: string): boolean {
    const session = this.session
    if (!session || session.id !== id) return false
    if (session.phase === 'cancelling') return true
    session.phase = 'cancelling'
    this.helper?.send({ type: 'cancel', session: id })
    this.arm(session, this.options.cancelTimeoutMs ?? 5_000, () => {
      this.finish(session, undefined, 'cancelled')
      this.replaceHelper()
    })
    return true
  }

  /** Emperor is quitting: cancel what runs and let the helper exit. */
  dispose(): void {
    this.disposed = true
    const session = this.session
    if (session) {
      this.helper?.send({ type: 'cancel', session: session.id })
      this.finish(session, undefined, 'cancelled')
    }
    this.clearIdle()
    this.closeHelper()
  }

  private async ensureHelper(): Promise<DictationHelperProcess> {
    if (this.disposed) throw new Unavailable('听写已关闭')
    if (this.platform !== 'darwin')
      throw new Unavailable('听写目前只支持 macOS')
    if (this.helper) return this.helper
    if (this.launching) return await this.launching
    if (this.suspended())
      throw new Unavailable('Emperor Dictation Helper 反复异常退出，请稍后再试')
    const executable = this.options.executable()
    if (!executable) throw new Unavailable('没有找到 Emperor Dictation Helper')
    this.launching = this.launch(executable).finally(() => {
      this.launching = undefined
    })
    return await this.launching
  }

  private async launch(executable: string): Promise<DictationHelperProcess> {
    if (this.options.verify && !this.verified) {
      try {
        await this.options.verify(executable)
      } catch (error) {
        this.log(`Emperor Dictation Helper signature: ${String(error)}`)
        throw new Unavailable(
          'Emperor Dictation Helper 的签名与 Emperor 不一致',
        )
      }
      this.verified = true
    }
    const helper: DictationHelperProcess = DictationHelperProcess.spawn({
      executable,
      spawn: this.spawn,
      env: this.env,
      onEvent: (event) => {
        if (this.helper === helper) this.onHelperEvent(event)
      },
      onGone: (gone) => this.onHelperGone(helper, gone),
    })
    try {
      await helper.handshake(this.options.handshakeMs ?? 10_000)
    } catch {
      throw new Unavailable('Emperor Dictation Helper 无法启动')
    }
    if (helper.gone) throw new Unavailable('Emperor Dictation Helper 无法启动')
    if (this.disposed) {
      helper.close()
      throw new Unavailable('听写已关闭')
    }
    this.helper = helper
    return helper
  }

  private onHelperEvent(event: HelperSessionEvent): void {
    const session = this.session
    if (!session || event.session !== session.id) return
    const seq = event.seq
    if (seq === null) {
      // About this dictation but outside its sequence: a refused start.
      if (event.type === 'error' && event.code !== 'not_found')
        this.finish(session, { code: event.code, message: event.message })
      return
    }
    if (seq <= session.lastSeq) return
    // After the final the microphone is closed: no more text or loudness.
    if (
      (event.type === 'final' ||
        event.type === 'partial' ||
        event.type === 'level') &&
      session.hasFinal
    )
      return
    if (event.type === 'final') session.hasFinal = true
    session.lastSeq = seq
    if (event.type === 'started' && session.phase === 'starting') {
      session.phase = 'running'
      this.arm(session, this.maxSeconds * 1000 + MAX_DURATION_GRACE_MS, () =>
        this.stop(session.id),
      )
    }
    const delivered = this.deliver(session, {
      ...event,
      session: session.id,
      seq,
    } as DictationEvent)
    if (event.type === 'ended') this.close(session)
    else if (!delivered) {
      this.helper?.send({ type: 'cancel', session: session.id })
      this.close(session)
    }
  }

  private onHelperGone(helper: DictationHelperProcess, gone: HelperGone): void {
    if (!gone.expected) {
      this.recordCrash()
      const detail = gone.reason ?? `code ${gone.code}, signal ${gone.signal}`
      const tail = gone.stderr.trim().split('\n').slice(-3).join(' | ')
      this.log(
        `Emperor Dictation Helper stopped: ${detail}${tail ? ` (${tail})` : ''}`,
      )
    }
    if (this.helper !== helper) return
    this.helper = undefined
    this.clearIdle()
    const session = this.session
    if (session)
      this.finish(session, {
        code: 'helper_exited',
        message: '听写组件意外退出',
      })
  }

  private deliver(session: Session, event: DictationEvent): boolean {
    try {
      return session.listener.deliver(event)
    } catch {
      return false
    }
  }

  /** Main ends the dictation itself: an error when it failed, then the end. */
  private finish(
    session: Session,
    error: { code: DictationErrorCode; message: string } | undefined,
    reason: DictationEndReason = 'error',
  ): void {
    if (this.session !== session) return
    if (error)
      this.deliver(session, {
        type: 'error',
        session: session.id,
        seq: ++session.lastSeq,
        code: error.code,
        message: error.message,
      })
    this.deliver(session, {
      type: 'ended',
      session: session.id,
      seq: ++session.lastSeq,
      reason,
    })
    this.close(session)
  }

  private close(session: Session): void {
    if (this.session !== session) return
    clearTimeout(session.timer)
    session.timer = undefined
    this.session = undefined
    try {
      session.listener.closed?.()
    } finally {
      this.scheduleIdle()
    }
  }

  /** One watchdog per dictation: the latest phase's replaces the last. */
  private arm(session: Session, ms: number, fire: () => void): void {
    clearTimeout(session.timer)
    session.timer = setTimeout(() => {
      session.timer = undefined
      if (this.session === session) fire()
    }, ms)
  }

  /** A helper that stopped answering is killed; the next use starts another. */
  private replaceHelper(): void {
    const helper = this.helper
    this.helper = undefined
    helper?.kill()
  }

  private closeHelper(): void {
    const helper = this.helper
    this.helper = undefined
    helper?.close()
  }

  private scheduleIdle(): void {
    this.clearIdle()
    if (this.disposed || this.session || !this.helper) return
    const idleExitMs = this.options.idleExitMs ?? 5 * 60_000
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined
      if (!this.session) this.closeHelper()
    }, idleExitMs)
    this.idleTimer.unref?.()
  }

  private clearIdle(): void {
    clearTimeout(this.idleTimer)
    this.idleTimer = undefined
  }

  private recordCrash(): void {
    const now = Date.now()
    this.crashes = [
      ...this.crashes.filter((at) => now - at < CRASH_WINDOW_MS),
      now,
    ]
  }

  /** Three unexpected exits within a minute: wait until that minute is over. */
  private suspended(): boolean {
    const now = Date.now()
    this.crashes = this.crashes.filter((at) => now - at < CRASH_WINDOW_MS)
    return this.crashes.length >= CRASH_LIMIT
  }
}
