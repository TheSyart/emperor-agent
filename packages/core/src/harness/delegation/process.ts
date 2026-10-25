/**
 * External agent processes (AGT-04).
 *
 * Every run starts as the leader of its own process group, and stopping it
 * is a group operation with a fixed timeline: interrupt, five seconds,
 * SIGTERM to the group, five seconds, SIGKILL to the group. A run counts as
 * stopped once its group is empty. There is no periodic process scan and no
 * attempt to prove that every descendant went quiet; a process that leaves
 * the group (setsid / double fork) is not tracked, except in diagnostics
 * mode, where a Seatbelt boundary marks the run's processes and the native
 * scanner stops any that are left outside the group when the run ends.
 */
import {
  spawn,
  execFile,
  execFileSync,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
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
import { systemBootMarker } from '../../util/stable-process-identity'
import { logger } from '../../util/log'
import type {
  OwnedProcessIdentity,
  ProcessExitReceipt,
  ProcessOwnership,
} from './process-types'
export type { ProcessExitReceipt } from './process-types'
const execute = promisify(execFile)
const log = logger.child({ component: 'executors' })

/** The wait between each step of a stop: interrupt, SIGTERM, SIGKILL. */
export const STOP_GRACE_MS = 5000
/** After SIGKILL, how long the group may take to disappear. */
const KILL_SETTLE_MS = 1000
/** Reads of the process table when the group outlives KILL_SETTLE_MS. */
const TABLE_READS = 3
const TABLE_RETRY_MS = 100
/** Seatbelt boundary markers (diagnostics mode) live here. */
export const BOUNDARY_MARKER_DIR = '/private/tmp'
const BOUNDARY_MARKER = /^emperor-boundary-[a-f0-9-]{36}-(?:denied|allowed)$/

export interface ManagedProcessSpec {
  onSpawn?: (identity: OwnedProcessIdentity) => Promise<void>
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
  identity: OwnedProcessIdentity
  started: Promise<void>
  closed: Promise<ProcessExitReceipt>
  diagnostics(): string
  /** SIGINT to the group; SIGTERM after five seconds, SIGKILL five later. */
  interrupt(): Promise<void>
  /** SIGTERM to the group; SIGKILL after five seconds. */
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
/** `ps` output must not depend on the user's language (SUB-16). */
function psEnvironment(): NodeJS.ProcessEnv {
  return { ...process.env, LC_ALL: 'C', LANG: 'C' }
}
/**
 * A process's start time (`ps lstart`, C locale), the identity Emperor
 * records next to a PID. Empty when the process is gone or `ps` failed; an
 * empty birth never matches anything.
 */
export function processBirth(pid: number): string {
  if (process.platform === 'win32') return String(pid) // The held ChildProcess handle remains the authority on Windows.
  try {
    return execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf8',
      timeout: 1000,
      env: psEnvironment(),
    })
      .trim()
      .replace(/\s+/g, ' ')
  } catch {
    return ''
  }
}
export interface ProcessRow {
  pid: number
  parent: number
  group: number
  state: string
  birth: string
}
export function parseProcessTable(stdout: string): Map<number, ProcessRow> {
  const rows = new Map<number, ProcessRow>()
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S.*?)\s*$/.exec(line)
    if (!match) continue
    const pid = Number(match[1])
    if (!Number.isSafeInteger(pid)) continue
    rows.set(pid, {
      pid,
      parent: Number(match[2]),
      group: Number(match[3]),
      state: match[4]!,
      birth: match[5]!.replace(/\s+/g, ' '),
    })
  }
  return rows
}
/**
 * The whole process table, or null when it cannot be trusted: `ps` failed,
 * or the table does not even list this process (a misparsed table must not
 * read as "everything stopped").
 */
export async function processTable(): Promise<Map<number, ProcessRow> | null> {
  if (process.platform === 'win32') return null
  try {
    const { stdout } = await execute(
      '/bin/ps',
      ['-axo', 'pid=,ppid=,pgid=,stat=,lstart='],
      { timeout: 2000, maxBuffer: 8 * 1024 * 1024, env: psEnvironment() },
    )
    const rows = parseProcessTable(stdout)
    return rows.has(process.pid) ? rows : null
  } catch {
    return null
  }
}
/**
 * True while any process is in group `pgid` (or it cannot be signalled).
 * macOS answers EPERM, not ESRCH, for a group whose only members are
 * zombies (BUG-09), so a group that is all but gone still "exists" here;
 * the process table tells the two apart (`stoppedAfterKill`).
 */
function groupExists(pgid: number): boolean {
  try {
    process.kill(-pgid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}
function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}
/**
 * Members of `pgid` that are still running; null if unknown. Zombies are
 * excluded, and so are processes macOS `ps` flags E (trying to exit): they
 * cannot return to their own code.
 */
function liveMembers(
  rows: Map<number, ProcessRow> | null,
  pgid: number,
): ProcessRow[] | null {
  return rows
    ? [...rows.values()].filter(
        (row) =>
          row.group === pgid &&
          !row.state.startsWith('Z') &&
          !row.state.includes('E'),
      )
    : null
}
/** A signal to a group failed only because none of its members could take it. */
function isEperm(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'EPERM'
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
/**
 * The group still answers after SIGKILL and KILL_SETTLE_MS. It has stopped
 * if it is gone by the time the table is read, or the table lists nothing
 * in it but zombies and exiting processes; any other member did not stop.
 * A table that cannot be read is read again (TABLE_READS in all); if none
 * can be read the stop stays unconfirmed.
 */
async function stoppedAfterKill(
  pgid: number,
  table: () => Promise<Map<number, ProcessRow> | null>,
): Promise<boolean> {
  for (let read = 0; read < TABLE_READS; read++) {
    if (read) await sleep(TABLE_RETRY_MS)
    if (!groupExists(pgid)) return true
    const live = liveMembers(await table(), pgid)
    if (live) return live.length === 0
  }
  log.warn('process table unavailable (ps 不可用); stop not confirmed', {
    pgid,
    reads: TABLE_READS,
  })
  return false
}
let bootTime: string | null | undefined
/**
 * This boot of the computer (kern.bootsessionuuid, else kern.boottime).
 * A process recorded under another value cannot still be running.
 */
export function currentBootTime(): string | null {
  if (bootTime === undefined) bootTime = systemBootMarker()
  return bootTime
}
/**
 * Remove Seatbelt boundary markers older than a day. Older builds wrote a
 * pair per process and never removed them; current builds only write them
 * in diagnostics mode and remove them when the run ends.
 */
export function cleanBoundaryMarkers(
  options: { dir?: string; now?: number; maxAgeMs?: number } = {},
): number {
  const dir = options.dir ?? BOUNDARY_MARKER_DIR,
    now = options.now ?? Date.now(),
    maxAge = options.maxAgeMs ?? 86_400_000,
    uid = typeof process.getuid === 'function' ? process.getuid() : undefined
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return 0
  }
  let removed = 0
  for (const name of names) {
    if (!BOUNDARY_MARKER.test(name)) continue
    const path = join(dir, name)
    try {
      const stat = lstatSync(path)
      if (!stat.isFile() || now - stat.mtimeMs <= maxAge) continue
      if (uid !== undefined && stat.uid !== uid) continue
      unlinkSync(path)
      removed++
    } catch {
      /* gone already, or not ours */
    }
  }
  return removed
}
function boundaryScanner(): string | undefined {
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
  return candidates.find((path) => existsSync(path))
}
function markerPath(tag: string, kind: 'denied' | 'allowed'): string {
  return join(BOUNDARY_MARKER_DIR, `emperor-boundary-${tag}-${kind}`)
}
function removeMarkers(tag: string): void {
  for (const kind of ['denied', 'allowed'] as const)
    try {
      unlinkSync(markerPath(tag, kind))
    } catch {
      /* already removed */
    }
}
async function boundaryPids(boundary: {
  tag: string
  scannerPath: string
}): Promise<number[] | null> {
  if (!/^[a-f0-9-]{36}$/.test(boundary.tag)) return null
  if (
    (['denied', 'allowed'] as const).some((kind) => {
      try {
        return (
          readFileSync(markerPath(boundary.tag, kind), 'utf8') !== boundary.tag
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
/**
 * Diagnostics mode: stop processes that still carry the run's boundary after
 * its group is gone. Returns how many were stopped, or null if the scan
 * itself failed (a diagnostic never fails the run).
 */
async function sweepBoundary(boundary: {
  tag: string
  scannerPath: string
}): Promise<number | null> {
  const pids = await boundaryPids(boundary)
  if (!pids) return null
  let stopped = 0
  if (pids.length) {
    const rows = await processTable()
    if (!rows) return null
    for (const pid of pids) {
      const row = rows.get(pid)
      // The scanner named the process by its inherited boundary; confirm the
      // PID still names that same process before signalling it.
      if (!row || row.state.startsWith('Z') || processBirth(pid) !== row.birth)
        continue
      try {
        process.kill(pid, 'SIGKILL')
        stopped++
      } catch {
        /* exited meanwhile */
      }
    }
  }
  removeMarkers(boundary.tag)
  return stopped
}
export class ManagedAgentProcess {
  private readonly sandbox: SandboxBackend
  constructor(
    private readonly options: {
      sandbox?: SandboxBackend
      /** Test hook: refuse to signal a live root (identity cannot be verified). */
      identityMatches?: (handle: ManagedProcessHandle) => boolean
      /** Process table reader; only consulted when a stopped group still answers signals. */
      observeProcesses?: () => Promise<Map<number, ProcessRow> | null>
      /** Diagnostics mode (Settings › 子智能体 › 高级): boundary markers and the native scanner. */
      diagnostics?: () => boolean
      /** The wait between stop steps; five seconds unless a test shortens it. */
      stopGraceMs?: number
    } = {},
  ) {
    this.sandbox = options.sandbox ?? new LocalSandbox()
  }
  async open(spec: ManagedProcessSpec): Promise<ManagedProcessHandle> {
    const h = this.spawn(spec)
    await h.started
    return h
  }
  /** Diagnostics mode only, and only when the scanner is present. */
  private boundary(): { tag: string; scannerPath: string } | undefined {
    if (process.platform !== 'darwin') return undefined
    let enabled = false
    try {
      enabled = this.options.diagnostics?.() === true
    } catch {
      enabled = false
    }
    if (!enabled) return undefined
    const scannerPath = boundaryScanner()
    if (!scannerPath) return undefined
    const tag = randomUUID()
    for (const kind of ['denied', 'allowed'] as const)
      writeFileSync(markerPath(tag, kind), tag, { mode: 0o600, flag: 'wx' })
    return { tag, scannerPath }
  }
  spawn(spec: ManagedProcessSpec): ManagedProcessHandle {
    if (spec.signal?.aborted)
      throw new DelegationError('ABORTED', 'process start cancelled')
    const grace = this.options.stopGraceMs ?? STOP_GRACE_MS
    const table = this.options.observeProcesses ?? processTable
    const boundary = this.boundary()
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
        if (boundary) removeMarkers(boundary.tag)
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
        `(version 1)(allow default)(deny file-read-data (literal "${markerPath(boundary.tag, 'denied')}"))`,
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
      // Its own process group: the unit every stop signal is sent to.
      detached: process.platform !== 'win32',
      windowsHide: true,
    })
    const boot = currentBootTime()
    const identity: OwnedProcessIdentity = {
      pid: child.pid ?? null,
      startedAt: Date.now(),
      fingerprint: '',
      ...(boot ? { bootTime: boot } : {}),
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
      finishing = false,
      signalled = false,
      interrupting = false,
      /** When SIGKILL is due; set by the first SIGTERM. */
      killAt: number | undefined
    const timers: ReturnType<typeof setTimeout>[] = []
    let settle!: (receipt: ProcessExitReceipt) => void
    const closed = new Promise<ProcessExitReceipt>((resolve) => {
      settle = resolve
    })
    const started = new Promise<void>((resolve, reject) => {
      child.once('spawn', () => {
        identity.pid = child.pid ?? null
        identity.fingerprint = child.pid ? processBirth(child.pid) : ''
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
    const rootLive = () => child.exitCode === null && child.signalCode === null
    /**
     * Signal the run's process group. While the root is unreaped its PID,
     * and so the group id, cannot belong to anyone else; after it exits the
     * id stays reserved for as long as any member of the group lives.
     */
    const signalGroup = (kind: NodeJS.Signals): boolean => {
      if (done || !child.pid) return false
      if (process.platform === 'win32') {
        if (!rootLive()) return false
        child.kill(kind)
        signalled = true
        return true
      }
      if (
        rootLive() &&
        this.options.identityMatches &&
        !this.options.identityMatches(handle)
      )
        throw new DelegationError(
          'OUTCOME_UNKNOWN',
          'process identity cannot be verified; no signal sent',
        )
      try {
        process.kill(-child.pid, kind)
        signalled = true
        return true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
        throw error
      }
    }
    const scheduleKill = () => {
      killAt = Date.now() + grace
      timers.push(
        setTimeout(() => {
          if (done || finishing) return
          try {
            signalGroup('SIGKILL')
          } catch {
            failureCode = 'OUTCOME_UNKNOWN'
          }
        }, grace),
      )
    }
    const terminate = async () => {
      if (done) return
      if (killAt === undefined && !finishing) {
        signalGroup('SIGTERM')
        scheduleKill()
      }
      await closed
    }
    const interrupt = async () => {
      if (done) return
      if (!interrupting && killAt === undefined && !finishing) {
        signalGroup('SIGINT')
        interrupting = true
        timers.push(
          setTimeout(() => {
            if (!done)
              void terminate().catch(() => {
                failureCode = 'OUTCOME_UNKNOWN'
              })
          }, grace),
        )
      }
      await closed
    }
    /**
     * Signal what is left of the group after the root exited. EPERM means no
     * member could take the signal: on macOS, a group of zombies waiting for
     * launchd answers that way. It is not a failure of the stop; the process
     * table decides below whether anything is still running (BUG-09).
     */
    const signalRest = (kind: NodeJS.Signals) => {
      try {
        signalGroup(kind)
      } catch (error) {
        if (!isEperm(error)) throw error
      }
    }
    /** The root exited: whatever is left of its group gets the same stop. */
    const finish = async (code: number | null, sig: NodeJS.Signals | null) => {
      if (done || finishing) return
      finishing = true
      let quiescent = process.platform !== 'win32',
        escaped: number | undefined
      const pgid = child.pid
      if (pgid && process.platform !== 'win32') {
        try {
          if (groupExists(pgid)) {
            if (killAt === undefined) {
              signalRest('SIGTERM')
              killAt = Date.now() + grace
            }
            while (groupExists(pgid) && Date.now() < killAt) await sleep(50)
            if (groupExists(pgid)) {
              signalRest('SIGKILL')
              const until = Date.now() + KILL_SETTLE_MS
              while (groupExists(pgid) && Date.now() < until) await sleep(25)
            }
            // Only zombies may still answer; anything else did not stop.
            if (groupExists(pgid))
              quiescent = await stoppedAfterKill(pgid, table)
          }
        } catch {
          quiescent = false
        }
        if (boundary) {
          const stopped = await sweepBoundary(boundary)
          if (stopped) escaped = stopped
        }
      }
      done = true
      timers.forEach(clearTimeout)
      spec.signal?.removeEventListener('abort', abort)
      if (!quiescent) failureCode = 'OUTCOME_UNKNOWN'
      const receipt: ProcessExitReceipt = {
        pid: child.pid ?? null,
        exitCode: code,
        signal: sig,
        quiescent,
        ...(failureCode ? { failureCode } : {}),
        ...(escaped ? { escaped } : {}),
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
          return signalGroup(kind)
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

/**
 * Stop a run recorded by an earlier Emperor process (after a crash or
 * restart), with the same group timeline. Never kills by PID alone:
 * - another boot time: the process cannot exist; nothing is signalled;
 * - the recorded PID is alive under another birth time: it was reused;
 *   nothing is signalled (`OWNER_MISMATCH`);
 * - descendants recorded by older builds count only while their own birth
 *   time still matches, and their PIDs never seed a search.
 */
export async function terminateRecordedProcess(
  ownership: ProcessOwnership,
  options: { bootTime?: string | null; graceMs?: number } = {},
): Promise<ProcessExitReceipt> {
  const unknown: ProcessExitReceipt = {
    pid: ownership.pid,
    exitCode: null,
    signal: null,
    quiescent: false,
    failureCode: 'OUTCOME_UNKNOWN',
  }
  const stopped: ProcessExitReceipt = {
    pid: ownership.pid,
    exitCode: null,
    signal: null,
    quiescent: true,
  }
  if (
    process.platform === 'win32' ||
    ownership.platform !== process.platform ||
    !ownership.pid
  )
    return unknown
  const boot =
    options.bootTime === undefined ? currentBootTime() : options.bootTime
  if (ownership.bootTime && boot && ownership.bootTime !== boot) return stopped
  const pgid = ownership.pid,
    grace = options.graceMs ?? STOP_GRACE_MS
  let rows = await processTable()
  if (!rows) return unknown
  const root = rows.get(pgid)
  if (root && (!ownership.fingerprint || root.birth !== ownership.fingerprint))
    return { ...unknown, failureCode: 'OWNER_MISMATCH' }
  const recorded = (ownership.descendants ?? []).filter(
    (d) => d.fingerprint && d.pid > 1 && d.pid !== pgid,
  )
  const strays = (table: Map<number, ProcessRow>) =>
    recorded.filter((d) => {
      const row = table.get(d.pid)
      return (
        row &&
        !row.state.startsWith('Z') &&
        row.group !== pgid &&
        row.birth === d.fingerprint
      )
    })
  const running = (table: Map<number, ProcessRow>) =>
    (liveMembers(table, pgid)?.length ?? 0) > 0 || strays(table).length > 0
  const sweep = async () => {
    if (ownership.boundary) await sweepBoundary(ownership.boundary)
  }
  if (!running(rows)) {
    await sweep()
    return stopped
  }
  const signal = (kind: NodeJS.Signals, table: Map<number, ProcessRow>) => {
    // No row leads the group, or it is the recorded root: the id is ours.
    const leader = table.get(pgid)
    if (
      groupExists(pgid) &&
      (!leader || leader.birth === ownership.fingerprint)
    )
      try {
        process.kill(-pgid, kind)
      } catch (error) {
        // EPERM: no member could take it (on macOS: only zombies are left);
        // the final table decides whether anything is still running.
        const code = (error as NodeJS.ErrnoException).code
        if (code !== 'ESRCH' && code !== 'EPERM') throw error
      }
    for (const d of strays(table))
      if (processBirth(d.pid) === d.fingerprint)
        try {
          process.kill(d.pid, kind)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
        }
  }
  const tracked = strays(rows)
  const alive = () => groupExists(pgid) || tracked.some((d) => pidExists(d.pid))
  try {
    signal('SIGTERM', rows)
    const killAt = Date.now() + grace
    while (alive() && Date.now() < killAt) await sleep(50)
    if (alive()) {
      rows = await processTable()
      if (!rows) return unknown
      signal('SIGKILL', rows)
      const until = Date.now() + KILL_SETTLE_MS
      while (alive() && Date.now() < until) await sleep(25)
    }
    rows = await processTable()
    if (!rows || running(rows)) return unknown
    await sweep()
    return stopped
  } catch {
    return unknown
  }
}
