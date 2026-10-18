import {
  spawn,
  execFile,
  execFileSync,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { existsSync, writeFileSync, readFileSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  Transform,
  type TransformCallback,
  type Readable,
  type Writable,
} from 'node:stream'
import { LocalSandbox, type SandboxBackend } from '../sandbox/backend'
import type { SandboxExecutionPolicy } from '../sandbox/policy'
import { DelegationError } from './types'
import { redactExecutorText } from './redaction'
const execute = promisify(execFile)
export interface ManagedProcessSpec {
  onSpawn?: (
    identity: import('./process-types').OwnedProcessIdentity,
  ) => Promise<void>
  onObserved?: (
    descendants: import('./process-types').OwnedDescendant[],
  ) => void
  onExit?: (receipt: ProcessExitReceipt) => void
  executable: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  policy: SandboxExecutionPolicy
  signal?: AbortSignal
  maxFrameBytes?: number
  secretValues?: readonly string[]
}
import type { ProcessExitReceipt } from './process-types'
export type { ProcessExitReceipt } from './process-types'
export interface AgentSpawnedProcess {
  stdin: Writable
  stdout: Readable
  stderr: Readable
  readonly killed: boolean
  readonly exitCode: number | null
  kill(signal: NodeJS.Signals): boolean
  on: ChildProcessWithoutNullStreams['on']
  once: ChildProcessWithoutNullStreams['once']
  off: ChildProcessWithoutNullStreams['off']
}
export interface ManagedProcessHandle {
  child: ChildProcessWithoutNullStreams
  spawnedProcess: AgentSpawnedProcess
  stdin: Writable
  stdout: Readable
  stderr: Readable
  identity: { pid: number | null; startedAt: number; fingerprint: string }
  started: Promise<void>
  closed: Promise<ProcessExitReceipt>
  diagnostics(): string
  captureDescendants(): Promise<void>
  interrupt(): Promise<void>
  terminate(): Promise<void>
}
class FrameLimit extends Transform {
  private pending = 0
  constructor(private readonly limit: number) {
    super({ highWaterMark: 64 * 1024 })
  }
  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    done: TransformCallback,
  ): void {
    let start = 0
    for (let i = 0; i < chunk.length; i++)
      if (chunk[i] === 10) {
        this.pending += i - start
        if (this.pending > this.limit) {
          done(
            new DelegationError(
              'OUTPUT_LIMIT',
              'protocol frame exceeded byte limit',
            ),
          )
          return
        }
        this.pending = 0
        start = i + 1
      }
    this.pending += chunk.length - start
    if (this.pending > this.limit) {
      done(
        new DelegationError(
          'OUTPUT_LIMIT',
          'protocol frame exceeded byte limit',
        ),
      )
      return
    }
    done(null, chunk)
  }
}
function fingerprint(pid: number): string {
  if (process.platform === 'win32') return String(pid) // The held ChildProcess handle remains the authority on Windows.
  try {
    return execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf8',
      timeout: 1000,
    })
      .trim()
      .replace(/\s+/g, ' ')
  } catch {
    return ''
  }
}
interface ProcessRow {
  pid: number
  parent: number
  group: number
  state: string
  birth: string
}
async function processTable(): Promise<Map<number, ProcessRow> | null> {
  if (process.platform === 'win32') return null
  try {
    const { stdout } = await execute(
      '/bin/ps',
      ['-axo', 'pid=,ppid=,pgid=,stat=,lstart='],
      {
        timeout: 1000,
        maxBuffer: 4 * 1024 * 1024,
      },
    )
    const rows = new Map<number, ProcessRow>()
    for (const line of stdout.trim().split('\n')) {
      const fields = line.trim().split(/\s+/),
        pid = Number(fields[0])
      if (fields.length < 9 || !Number.isSafeInteger(pid)) continue
      rows.set(pid, {
        pid,
        parent: Number(fields[1]),
        group: Number(fields[2]),
        state: fields[3]!,
        birth: fields.slice(4).join(' '),
      })
    }
    return rows
  } catch {
    return null
  }
}
export async function* readJsonLines(
  stream: Readable,
  maxBytes = 4 * 1024 * 1024,
): AsyncGenerator<Record<string, unknown>> {
  let pending = Buffer.alloc(0)
  const decode = (bytes: Buffer) => {
    if (bytes.length > maxBytes)
      throw new DelegationError(
        'OUTPUT_LIMIT',
        'protocol frame exceeded byte limit',
      )
    let value: unknown
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      value = JSON.parse(text)
    } catch {
      throw new DelegationError(
        'PROTOCOL_INVALID',
        'malformed UTF-8 or JSON protocol frame',
      )
    }
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new DelegationError('PROTOCOL_INVALID', 'expected JSON object')
    return value as Record<string, unknown>
  }
  for await (const piece of stream) {
    const chunk = Buffer.isBuffer(piece) ? piece : Buffer.from(piece)
    let start = 0
    for (let i = 0; i < chunk.length; i++)
      if (chunk[i] === 10) {
        const line = Buffer.concat([pending, chunk.subarray(start, i)])
        pending = Buffer.alloc(0)
        start = i + 1
        if (line.length) yield decode(line)
      }
    pending = Buffer.concat([pending, chunk.subarray(start)])
    if (pending.length > maxBytes)
      throw new DelegationError(
        'OUTPUT_LIMIT',
        'protocol frame exceeded byte limit',
      )
  }
  if (pending.length) yield decode(pending)
}
function boundaryScanner(): string {
  const suffix = `native/build/${process.platform}-${process.arch}/delegation-scan`
  const candidates = [
    ...((process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
      ? [
          join(
            (process as NodeJS.Process & { resourcesPath: string })
              .resourcesPath,
            'native/delegation-scan',
          ),
        ]
      : []),
    // CommonJS bundles (the Electron e2e harness) have no import.meta.url.
    ...(import.meta.url
      ? [resolve(dirname(fileURLToPath(import.meta.url)), '../../../', suffix)]
      : []),
    resolve(process.cwd(), 'packages/core', suffix),
    resolve(process.cwd(), '../packages/core', suffix),
    resolve(process.cwd(), suffix),
  ]
  const found = candidates.find((path) => existsSync(path))
  if (!found)
    throw new DelegationError(
      'CONTAINMENT_UNAVAILABLE',
      'macOS delegation scanner missing; build the native helper before running external agents',
    )
  return found
}
async function boundaryPids(boundary: {
  tag: string
  scannerPath: string
}): Promise<number[] | null> {
  if (!/^[a-f0-9-]{36}$/.test(boundary.tag)) return null
  if (
    ['denied', 'allowed'].some((kind) => {
      try {
        return (
          readFileSync(
            `/private/tmp/emperor-boundary-${boundary.tag}-${kind}`,
            'utf8',
          ) !== boundary.tag
        )
      } catch {
        return true
      }
    })
  )
    return null
  try {
    const result = await execute(boundary.scannerPath, [boundary.tag], {
      timeout: 2000,
      maxBuffer: 64 * 1024,
      encoding: 'utf8',
    })
    const pids = result.stdout.split('\n').filter(Boolean).map(Number)
    return pids.length <= 1024 &&
      pids.every((pid) => Number.isSafeInteger(pid) && pid > 1)
      ? pids
      : null
  } catch {
    return null
  }
}
export class ManagedAgentProcess {
  private readonly sandbox: SandboxBackend
  constructor(
    private readonly options: {
      sandbox?: SandboxBackend
      identityMatches?: (handle: ManagedProcessHandle) => boolean
      observeProcesses?: () => Promise<Map<number, ProcessRow> | null>
    } = {},
  ) {
    this.sandbox = options.sandbox ?? new LocalSandbox()
  }
  async open(spec: ManagedProcessSpec): Promise<ManagedProcessHandle> {
    const h = this.spawn(spec)
    await h.started
    return h
  }
  spawn(spec: ManagedProcessSpec): ManagedProcessHandle {
    if (spec.signal?.aborted)
      throw new DelegationError('ABORTED', 'process start cancelled')
    const boundary =
      process.platform === 'darwin'
        ? { tag: randomUUID(), scannerPath: boundaryScanner() }
        : undefined
    if (boundary)
      for (const kind of ['denied', 'allowed'])
        writeFileSync(
          `/private/tmp/emperor-boundary-${boundary.tag}-${kind}`,
          boundary.tag,
          { mode: 0o600, flag: 'wx' },
        )
    const policy = {
      ...spec.policy,
      ...(boundary ? { processBoundaryTag: boundary.tag } : {}),
    }
    let argv = [spec.executable, ...spec.args]
    if (spec.policy.mode !== 'danger-full-access') {
      try {
        argv = this.sandbox.confine(argv, {
          ...policy,
          mode: spec.policy.mode,
        }).argv
      } catch {
        throw new DelegationError(
          'CONTAINMENT_UNAVAILABLE',
          'requested process boundary is unavailable',
        )
      }
    }
    if (boundary && policy.mode === 'danger-full-access')
      argv = [
        '/usr/bin/sandbox-exec',
        '-p',
        `(version 1)(allow default)(deny file-read-data (literal "/private/tmp/emperor-boundary-${boundary.tag}-denied"))`,
        ...argv,
      ]
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd: spec.cwd,
      env: {
        ...spec.env,
        ...(spec.policy.privateTempRoot
          ? {
              TMPDIR: spec.policy.privateTempRoot,
              TMP: spec.policy.privateTempRoot,
              TEMP: spec.policy.privateTempRoot,
            }
          : {}),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      detached: process.platform !== 'win32',
      windowsHide: true,
    })
    const identity = {
      pid: child.pid ?? null,
      startedAt: Date.now(),
      fingerprint: '',
      ...(boundary ? { boundary } : {}),
    }
    const output = new FrameLimit(spec.maxFrameBytes ?? 4 * 1024 * 1024)
    child.stdout.pipe(output)
    const secrets =
      spec.secretValues ??
      Object.entries(spec.env)
        .filter(([k, v]) => v && /KEY|TOKEN|SECRET/i.test(k))
        .map(([, v]) => v!)
    let stderr = Buffer.alloc(0),
      failureCode: string | undefined,
      done = false,
      signalled = false,
      confirmedGroup = false,
      shutdownDeadline = 0
    const timers: ReturnType<typeof setTimeout>[] = []
    let settle!: (receipt: ProcessExitReceipt) => void
    const closed = new Promise<ProcessExitReceipt>((resolve) => {
      settle = resolve
    })
    const started = new Promise<void>((resolve, reject) => {
      child.once('spawn', () => {
        identity.pid = child.pid ?? null
        identity.fingerprint = child.pid ? fingerprint(child.pid) : ''
        Promise.resolve()
          .then(() => spec.onSpawn?.({ ...identity }))
          .then(resolve, (error) => {
            failureCode = 'OWNERSHIP_PERSIST_FAILED'
            reject(error)
            void terminate().catch(() => {
              failureCode = 'OUTCOME_UNKNOWN'
            })
          })
      })
      child.once('error', reject)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = Buffer.concat([stderr, chunk]).subarray(-(80 * 1024))
    })
    child.stdin.on('error', () => {
      /* EPIPE is represented by the process exit receipt. */
    })
    const matches = () => {
      if (optionsIdentity()) return true
      return false
    }
    const descendants = new Map<number, string>()
    let proofFailed = false
    let scan: Promise<Map<number, ProcessRow> | null> | undefined
    const scanTree = (): Promise<Map<number, ProcessRow> | null> => {
      if (scan) return scan
      const operation = (async () => {
        const rows = await (this.options.observeProcesses ?? processTable)()
        if (!rows) {
          proofFailed = true
          return null
        }
        const previousSize = descendants.size
        if (boundary) {
          const marked = await boundaryPids(boundary)
          if (!marked) {
            proofFailed = true
            return null
          }
          for (const pid of marked) {
            const row = rows.get(pid)
            if (row && pid !== child.pid && !row.state.startsWith('Z'))
              descendants.set(pid, row.birth)
          }
        }
        const owned = new Set<number>()
        const root = child.pid ? rows.get(child.pid) : undefined
        if (
          root?.birth === identity.fingerprint &&
          (!this.options.identityMatches ||
            this.options.identityMatches(handle))
        )
          owned.add(root.pid)
        for (const [pid, birth] of descendants)
          if (rows.get(pid)?.birth === birth) owned.add(pid)
        for (let changed = true; changed;) {
          changed = false
          for (const row of rows.values()) {
            if (owned.has(row.pid) || row.state.startsWith('Z')) continue
            if (owned.has(row.parent)) {
              if (descendants.size >= 1024) {
                proofFailed = true
                continue
              }
              descendants.set(row.pid, row.birth)
              owned.add(row.pid)
              changed = true
            }
          }
        }
        if (descendants.size !== previousSize) {
          try {
            spec.onObserved?.(
              [...descendants].map(([pid, fingerprint]) => ({
                pid,
                fingerprint,
              })),
            )
          } catch {
            proofFailed = true
            failureCode = 'OWNERSHIP_PERSIST_FAILED'
            try {
              signal('SIGTERM')
            } catch {
              /* receipt will retain the writer lease */
            }
          }
        }
        return rows
      })()
      scan = operation
      void operation.then(
        () => {
          if (scan === operation) scan = undefined
        },
        () => {
          proofFailed = true
          if (scan === operation) scan = undefined
        },
      )
      return operation
    }
    const captureDescendants = async (): Promise<void> => {
      await scanTree()
    }
    const stopDescendants = async (kind: NodeJS.Signals): Promise<void> => {
      const rows = await scanTree()
      if (!rows) return
      // Children may call setsid/setpgid. Signal held descendant identities,
      // independently of the root group, before their parents disappear.
      for (const [pid, birth] of [...descendants].reverse()) {
        const row = rows.get(pid)
        if (!row || row.state.startsWith('Z') || row.birth !== birth) continue
        if (fingerprint(pid) !== birth) continue
        try {
          process.kill(pid, kind)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH')
            proofFailed = true
        }
      }
    }
    const watch = setInterval(() => {
      if (!done) void scanTree()
    }, 100)
    watch.unref()
    const optionsIdentity = () =>
      this.options.identityMatches
        ? this.options.identityMatches(handle)
        : Boolean(
            child.pid &&
            child.exitCode === null &&
            child.signalCode === null &&
            identity.fingerprint &&
            fingerprint(child.pid) === identity.fingerprint,
          )
    const signal = (
      kind: NodeJS.Signals,
      afterConfirmation = false,
    ): boolean => {
      if (done) return false
      if (
        afterConfirmation &&
        confirmedGroup &&
        (child.exitCode !== null || child.signalCode !== null)
      )
        return false
      if (!matches() && !(afterConfirmation && confirmedGroup))
        throw new DelegationError(
          'OUTCOME_UNKNOWN',
          'process identity cannot be verified; no signal sent',
        )
      try {
        if (process.platform === 'win32') child.kill(kind)
        else process.kill(-child.pid!, kind)
        signalled = true
        confirmedGroup = true
        return true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
        throw error
      }
    }
    const scheduleKill = () => {
      timers.push(
        setTimeout(async () => {
          if (!done)
            try {
              await stopDescendants('SIGKILL')
              signal('SIGKILL', true)
            } catch {
              failureCode = 'OUTCOME_UNKNOWN'
            }
        }, 2000),
      )
    }
    const terminate = async () => {
      if (done) return
      shutdownDeadline = Math.max(shutdownDeadline, Date.now() + 2500)
      await stopDescendants('SIGTERM')
      if (child.exitCode === null && child.signalCode === null)
        signal('SIGTERM', confirmedGroup)
      scheduleKill()
      await closed
    }
    const interrupt = async () => {
      if (done) return
      shutdownDeadline = Date.now() + 7500
      await stopDescendants('SIGINT')
      signal('SIGINT')
      timers.push(
        setTimeout(() => {
          if (!done)
            void terminate().catch(() => {
              failureCode = 'OUTCOME_UNKNOWN'
            })
        }, 5000),
      )
      await closed
    }
    const finish = async (code: number | null, sig: NodeJS.Signals | null) => {
      if (done) return
      let quiescent = !proofFailed && process.platform !== 'win32'
      if (child.pid && process.platform !== 'win32') {
        // A scan already in flight can describe the group before the exit.
        // Drain it before starting the bounded final observation window.
        if (scan) await scan
        const until = Math.max(
          shutdownDeadline,
          Date.now() + (confirmedGroup ? 2500 : 100),
        )
        while (true) {
          const rows = await scanTree()
          if (rows === null) {
            quiescent = false
            break
          }
          const activeDescendants = [...descendants].filter(([pid, birth]) => {
            const row = rows.get(pid)
            return row?.birth === birth && !row.state.startsWith('Z')
          })
          const groupMembers = [...rows.values()].filter(
            (row) => row.group === child.pid && !row.state.startsWith('Z'),
          )
          if (activeDescendants.length === 0 && groupMembers.length === 0) break
          if (Date.now() >= until) {
            quiescent = false
            break
          }
          await new Promise((r) => setTimeout(r, 20))
        }
      }
      if (done) return
      done = true
      clearInterval(watch)
      timers.forEach(clearTimeout)
      spec.signal?.removeEventListener('abort', abort)
      if (!quiescent) failureCode = 'OUTCOME_UNKNOWN'
      // Keep the tiny marker pair with the ownership proof. Independent
      // recovery readers can still be observing this exit; deleting here
      // races their final scan and turns a proven stop into unknown.
      if (proofFailed) {
        quiescent = false
        failureCode = 'OUTCOME_UNKNOWN'
      }
      const receipt: ProcessExitReceipt = {
        pid: child.pid ?? null,
        exitCode: code,
        signal: sig,
        quiescent,
        ...(failureCode ? { failureCode } : {}),
      }
      try {
        spec.onExit?.(receipt)
      } catch {
        receipt.quiescent = false
        receipt.failureCode = 'OWNERSHIP_PERSIST_FAILED'
      }
      settle(receipt)
    }
    const abort = () => {
      void terminate().catch(() => {
        failureCode = 'OUTCOME_UNKNOWN'
      })
    }
    const spawnedProcess: AgentSpawnedProcess = {
      stdin: child.stdin,
      stdout: output,
      stderr: child.stderr,
      get killed() {
        return signalled
      },
      get exitCode() {
        return child.exitCode
      },
      kill: (kind) => {
        try {
          return signal(kind)
        } catch {
          return false
        }
      },
      on: child.on.bind(child),
      once: child.once.bind(child),
      off: child.off.bind(child),
    }
    const handle: ManagedProcessHandle = {
      child,
      spawnedProcess,
      stdin: child.stdin,
      stdout: output,
      stderr: child.stderr,
      identity,
      started,
      closed,
      diagnostics: () =>
        Buffer.from(redactExecutorText(stderr.toString('utf8'), secrets))
          .subarray(-64 * 1024)
          .toString('utf8'),
      captureDescendants,
      terminate,
      interrupt,
    }
    output.on('error', (error) => {
      if ((error as { code?: string }).code === 'OUTPUT_LIMIT') {
        failureCode = 'OUTPUT_LIMIT'
        void terminate().catch(() => {
          failureCode = 'OUTCOME_UNKNOWN'
        })
      }
    })
    child.once('exit', (code, sig) => {
      void finish(code, sig)
    })
    child.once('error', () => {
      failureCode = 'SPAWN_ERROR'
      void finish(null, null)
    })
    spec.signal?.addEventListener('abort', abort, { once: true })
    return handle
  }
}

/** Stop only process identities recorded by the host; never kill by PID alone. */
export async function terminateRecordedProcess(
  ownership: import('./process-types').ProcessOwnership,
): Promise<ProcessExitReceipt> {
  const receipt: ProcessExitReceipt = {
    pid: ownership.pid,
    exitCode: null,
    signal: null,
    quiescent: false,
    failureCode: 'OUTCOME_UNKNOWN',
  }
  if (
    process.platform === 'win32' ||
    ownership.platform !== process.platform ||
    !ownership.pid
  )
    return receipt
  let rows = await processTable()
  if (!rows) return receipt
  const root = rows.get(ownership.pid)
  if (root && root.birth !== ownership.fingerprint)
    return { ...receipt, failureCode: 'OWNER_MISMATCH' }
  const marked = ownership.boundary
    ? await boundaryPids(ownership.boundary)
    : []
  if (!marked) return receipt
  const known = new Map(
    ownership.descendants.map((x) => [x.pid, x.fingerprint]),
  )
  for (const pid of marked) {
    const row = rows.get(pid)
    if (row) known.set(pid, row.birth)
  }
  if (root) known.set(root.pid, root.birth)
  for (let changed = true; changed;) {
    changed = false
    for (const row of rows.values())
      if (known.has(row.parent) && !known.has(row.pid)) {
        if (known.size >= 1025) return receipt
        known.set(row.pid, row.birth)
        changed = true
      }
  }
  const kill = (kind: NodeJS.Signals) => {
    // Signal the group while its held leader identity is still live. Killing
    // the leader first can turn a subsequent group signal into EPERM on macOS.
    if (root && fingerprint(root.pid) === root.birth && root.group === root.pid)
      try {
        process.kill(-root.pid, kind)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      }
    for (const [pid, birth] of [...known].reverse())
      if (pid !== root?.pid && fingerprint(pid) === birth)
        try {
          process.kill(pid, kind)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
        }
    if (root && root.group !== root.pid && fingerprint(root.pid) === root.birth)
      try {
        process.kill(root.pid, kind)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      }
  }
  const active = (table: Map<number, ProcessRow>) =>
    [...known].some(([pid, birth]) => {
      const row = table.get(pid)
      return row?.birth === birth && !row.state.startsWith('Z')
    }) ||
    [...table.values()].some(
      (row) => row.group === ownership.pid && !row.state.startsWith('Z'),
    )
  try {
    if (active(rows)) kill('SIGTERM')
    const deadline = Date.now() + 2500,
      forceAt = Date.now() + 2000
    while (true) {
      rows = await processTable()
      if (!rows) return receipt
      if (ownership.boundary) {
        const marked = await boundaryPids(ownership.boundary)
        if (!marked) return receipt
        for (const pid of marked) {
          const row = rows.get(pid)
          if (row) known.set(pid, row.birth)
        }
      }
      if (!active(rows))
        return { ...receipt, quiescent: true, failureCode: undefined }
      if (Date.now() >= deadline) return receipt
      if (Date.now() >= forceAt) kill('SIGKILL')
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  } catch {
    return receipt
  }
}
