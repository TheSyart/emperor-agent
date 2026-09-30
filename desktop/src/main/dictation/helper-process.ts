/**
 * The dictation helper as Emperor's child process: JSON lines over its
 * stdin and stdout (./protocol), a hello handshake, status requests, and one
 * notice when the process becomes unusable. Only Emperor holds the pipes;
 * closing stdin makes the helper cancel whatever runs and exit.
 */
import { spawn as nodeSpawn } from 'node:child_process'
import {
  DICTATION_PROTOCOL_VERSION,
  DictationProtocolError,
  LineDecoder,
  encodeRequest,
  parseHelperEvent,
  type HelperRequest,
  type HelperSessionEvent,
  type HelperStatus,
} from './protocol'

/** What Emperor needs of a child process (Node's `ChildProcess` fits). */
export interface DictationChild {
  readonly stdin: {
    write(chunk: string): boolean
    end(): void
    on(event: 'error', listener: (error: Error) => void): unknown
  }
  readonly stdout: {
    on(event: 'data', listener: (chunk: Buffer) => void): unknown
  }
  readonly stderr: {
    on(event: 'data', listener: (chunk: Buffer) => void): unknown
  }
  kill(signal?: NodeJS.Signals): boolean
  on(
    event: 'exit',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
}

export type DictationSpawn = (
  executable: string,
  options: { env: NodeJS.ProcessEnv },
) => DictationChild

export const spawnDictationHelper: DictationSpawn = (executable, { env }) =>
  nodeSpawn(executable, [], { stdio: ['pipe', 'pipe', 'pipe'], env })

/** Why the helper can no longer be used. Reported once. */
export interface HelperGone {
  /** Emperor closed or killed it on purpose. */
  readonly expected: boolean
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  /** Set when Emperor gave up on it: bad output, no answer, no start. */
  readonly reason?: string
  /** The end of what it wrote to stderr, for the log. */
  readonly stderr: string
}

const STDERR_TAIL_BYTES = 4096
const CLOSE_GRACE_MS = 3000

interface Waiter<T> {
  resolve(value: T): void
  reject(error: Error): void
}

export class DictationHelperProcess {
  private readonly decoder = new LineDecoder()
  private readonly statusWaiters: Array<
    Waiter<HelperStatus> & { timer: ReturnType<typeof setTimeout> }
  > = []
  private hello: Waiter<string> | undefined
  private stderrTail = ''
  private expecting = false
  private goneInfo: HelperGone | undefined

  private constructor(
    private readonly child: DictationChild,
    private readonly handlers: {
      event(event: HelperSessionEvent): void
      gone(gone: HelperGone): void
    },
  ) {
    child.stdout.on('data', (chunk) => this.read(chunk))
    child.stderr.on('data', (chunk) => {
      this.stderrTail = (this.stderrTail + chunk.toString('utf8')).slice(
        -STDERR_TAIL_BYTES,
      )
    })
    // A write after the helper died fails with EPIPE; the exit reports it.
    child.stdin.on('error', () => undefined)
    child.on('error', (error) =>
      this.finish({ code: null, signal: null, reason: error.message }),
    )
    child.on('exit', (code, signal) => this.finish({ code, signal }))
  }

  static spawn(options: {
    executable: string
    spawn: DictationSpawn
    env: NodeJS.ProcessEnv
    onEvent(event: HelperSessionEvent): void
    onGone(gone: HelperGone): void
  }): DictationHelperProcess {
    return new DictationHelperProcess(
      options.spawn(options.executable, { env: options.env }),
      { event: options.onEvent, gone: options.onGone },
    )
  }

  get gone(): boolean {
    return this.goneInfo !== undefined
  }

  /** Resolves the helper's engine name once it speaks our protocol. */
  handshake(timeoutMs: number): Promise<string> {
    if (this.goneInfo) return Promise.reject(new Error('helper is gone'))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => this.abort('the helper did not answer hello'),
        timeoutMs,
      )
      this.hello = {
        resolve: (engine) => {
          clearTimeout(timer)
          resolve(engine)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      }
      this.send({ type: 'hello', protocol: DICTATION_PROTOCOL_VERSION })
    })
  }

  /** Permissions, devices and locales as the helper sees them now. */
  status(timeoutMs: number): Promise<HelperStatus> {
    if (this.goneInfo) return Promise.reject(new Error('helper is gone'))
    return new Promise((resolve, reject) => {
      // Answers are matched in order, so a late one would answer the wrong
      // request: a helper that does not answer in time is replaced.
      const timer = setTimeout(
        () => this.abort('the helper did not answer status'),
        timeoutMs,
      )
      this.statusWaiters.push({ resolve, reject, timer })
      this.send({ type: 'status' })
    })
  }

  send(request: HelperRequest): void {
    if (this.goneInfo) return
    this.child.stdin.write(encodeRequest(request))
  }

  /** Let it finish on its own: EOF cancels a dictation and exits. */
  close(): void {
    if (this.goneInfo) return
    this.expecting = true
    this.child.stdin.end()
    const timer = setTimeout(() => this.child.kill('SIGKILL'), CLOSE_GRACE_MS)
    timer.unref?.()
  }

  kill(): void {
    if (this.goneInfo) return
    this.expecting = true
    this.child.kill('SIGKILL')
  }

  private read(chunk: Buffer): void {
    if (this.goneInfo) return
    let lines: string[]
    try {
      lines = this.decoder.push(chunk)
    } catch (error) {
      this.abort((error as Error).message)
      return
    }
    for (const line of lines) {
      if (this.goneInfo) return
      try {
        this.dispatch(parseHelperEvent(line))
      } catch (error) {
        if (!(error instanceof DictationProtocolError)) throw error
        this.abort(`unreadable helper output: ${error.message}`)
      }
    }
  }

  private dispatch(event: ReturnType<typeof parseHelperEvent>): void {
    switch (event.type) {
      case 'hello': {
        const hello = this.hello
        if (!hello) return
        // Aborting rejects the pending handshake.
        if (event.protocol !== DICTATION_PROTOCOL_VERSION) {
          this.abort(`helper speaks protocol ${event.protocol}`)
          return
        }
        this.hello = undefined
        hello.resolve(event.engine)
        return
      }
      case 'status': {
        const waiter = this.statusWaiters.shift()
        if (!waiter) return
        clearTimeout(waiter.timer)
        const { type: _type, ...status } = event
        waiter.resolve(status)
        return
      }
      case 'error':
        // Not about a dictation: the helper refused a request of ours.
        if (event.session === null) {
          if (this.hello) this.abort(`helper refused hello: ${event.message}`)
          return
        }
        this.handlers.event(event)
        return
      default:
        this.handlers.event(event)
    }
  }

  /** Emperor gives up on the helper: report it, then make sure it is gone. */
  private abort(reason: string): void {
    if (this.goneInfo) return
    this.finish({ code: null, signal: null, reason })
    this.child.kill('SIGKILL')
  }

  private finish(exit: {
    code: number | null
    signal: NodeJS.Signals | null
    reason?: string
  }): void {
    if (this.goneInfo) return
    const gone: HelperGone = {
      expected: this.expecting && exit.reason === undefined,
      code: exit.code,
      signal: exit.signal,
      ...(exit.reason === undefined ? {} : { reason: exit.reason }),
      stderr: this.stderrTail,
    }
    this.goneInfo = gone
    const error = new Error(exit.reason ?? 'helper exited')
    this.hello?.reject(error)
    this.hello = undefined
    for (const waiter of this.statusWaiters.splice(0)) {
      clearTimeout(waiter.timer)
      waiter.reject(error)
    }
    this.handlers.gone(gone)
  }
}
