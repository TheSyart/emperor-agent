import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { uptime } from 'node:os'

export type StableProcessStartIdentity =
  | {
      readonly kind: 'linux_proc_start_ticks' | 'windows_creation_time'
      readonly value: string
    }
  | {
      readonly kind: 'darwin_boot_relative_interval'
      readonly minSeconds: number
      readonly maxSeconds: number
    }

export interface CurrentStableProcessIdentity {
  readonly bootMarker: string | null
  readonly processStartIdentity: StableProcessStartIdentity | null
}

let currentProcessIdentityInitialized = false
let cachedCurrentProcessIdentity: CurrentStableProcessIdentity

export function systemBootMarker(): string | null {
  try {
    if (process.platform === 'linux') {
      const bootId = readFileSync(
        '/proc/sys/kernel/random/boot_id',
        'utf8',
      ).trim()
      return bootId ? sha256(`linux:${bootId}`) : null
    }
    if (process.platform === 'darwin') {
      try {
        const bootSessionUuid = execFileSync(
          'sysctl',
          ['-n', 'kern.bootsessionuuid'],
          { encoding: 'utf8', timeout: 1_000 },
        )
          .trim()
          .toLowerCase()
        if (
          /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
            bootSessionUuid,
          )
        )
          return sha256(`darwin:${bootSessionUuid}`)
      } catch {
        // Older Darwin variants may not expose kern.bootsessionuuid.
      }
      const value = execFileSync('sysctl', ['-n', 'kern.boottime'], {
        encoding: 'utf8',
        timeout: 1_000,
      })
      const match = /sec\s*=\s*(\d+)\s*,\s*usec\s*=\s*(\d+)/.exec(value)
      return match ? sha256(`darwin:${match[1]}:${match[2]}`) : null
    }
    if (process.platform === 'win32') {
      const value = execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          '(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToFileTimeUtc()',
        ],
        { encoding: 'utf8', timeout: 2_000 },
      ).trim()
      return /^\d+$/.test(value) ? sha256(`win32:${value}`) : null
    }
    return null
  } catch {
    return null
  }
}

export function stableProcessStartIdentity(
  pid: number,
  bootMarker = systemBootMarker(),
): StableProcessStartIdentity | null {
  try {
    if (!bootMarker) return null
    if (process.platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8').trim()
      const commandEnd = stat.lastIndexOf(')')
      if (commandEnd < 0) return null
      const fields = stat
        .slice(commandEnd + 1)
        .trim()
        .split(/\s+/)
      const startTicks = fields[19]
      return startTicks && /^\d+$/.test(startTicks)
        ? {
            kind: 'linux_proc_start_ticks',
            value: sha256(`linux:${bootMarker}:${pid}:${startTicks}`),
          }
        : null
    }
    if (process.platform === 'darwin') {
      const uptimeBefore = uptime()
      const elapsed = execFileSync('ps', ['-o', 'etime=', '-p', String(pid)], {
        encoding: 'utf8',
        timeout: 1_000,
      }).trim()
      const uptimeAfter = uptime()
      const elapsedSeconds = parseElapsedSeconds(elapsed)
      if (elapsedSeconds === null) return null
      return {
        kind: 'darwin_boot_relative_interval',
        // `ps etime` is quantized to whole seconds and sampled between the
        // monotonic uptime bounds. The real start must lie in this interval.
        minSeconds: uptimeBefore - elapsedSeconds - 1,
        maxSeconds: uptimeAfter - elapsedSeconds,
      }
    }
    if (process.platform === 'win32') {
      const value = execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CreationDate.ToFileTimeUtc()`,
        ],
        { encoding: 'utf8', timeout: 2_000 },
      ).trim()
      return /^\d+$/.test(value)
        ? {
            kind: 'windows_creation_time',
            value: sha256(`win32:${bootMarker}:${pid}:${value}`),
          }
        : null
    }
    return null
  } catch {
    return null
  }
}

/**
 * A process' boot marker and start identity cannot change during its lifetime.
 * Cache them so lock acquisition never repeatedly shells out on macOS/Windows.
 */
export function currentStableProcessIdentity(): CurrentStableProcessIdentity {
  if (!currentProcessIdentityInitialized) {
    const bootMarker = systemBootMarker()
    cachedCurrentProcessIdentity = Object.freeze({
      bootMarker,
      processStartIdentity: stableProcessStartIdentity(process.pid, bootMarker),
    })
    currentProcessIdentityInitialized = true
  }
  return cachedCurrentProcessIdentity
}

export function parseStableProcessStartIdentity(
  value: unknown,
): StableProcessStartIdentity | null {
  if (!isRecord(value)) return null
  if (
    (value.kind === 'linux_proc_start_ticks' ||
      value.kind === 'windows_creation_time') &&
    typeof value.value === 'string' &&
    /^[a-f0-9]{64}$/.test(value.value)
  )
    return { kind: value.kind, value: value.value }
  if (
    value.kind === 'darwin_boot_relative_interval' &&
    typeof value.minSeconds === 'number' &&
    Number.isFinite(value.minSeconds) &&
    typeof value.maxSeconds === 'number' &&
    Number.isFinite(value.maxSeconds) &&
    value.minSeconds >= 0 &&
    value.maxSeconds >= value.minSeconds
  )
    return {
      kind: value.kind,
      minSeconds: value.minSeconds,
      maxSeconds: value.maxSeconds,
    }
  return null
}

export function compareStableProcessStartIdentity(
  stored: StableProcessStartIdentity,
  current: StableProcessStartIdentity,
): 'same' | 'different' | 'ambiguous' {
  if (stored.kind !== current.kind) return 'ambiguous'
  if (
    stored.kind === 'darwin_boot_relative_interval' &&
    current.kind === 'darwin_boot_relative_interval'
  ) {
    const gap =
      Math.max(stored.minSeconds, current.minSeconds) -
      Math.min(stored.maxSeconds, current.maxSeconds)
    if (gap <= 0) return 'same'
    // Both os.uptime() and `ps etime` are quantized, and the two samples are
    // taken in different processes. A small boundary gap is not proof that a
    // live PID was reused; fail closed instead of reaping a live owner.
    return gap <= 2 ? 'ambiguous' : 'different'
  }
  if ('value' in stored && 'value' in current)
    return stored.value === current.value ? 'same' : 'different'
  return 'ambiguous'
}

export function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

function parseElapsedSeconds(value: string): number | null {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(value.trim())
  if (!match) return null
  const days = Number(match[1] ?? 0)
  const hours = Number(match[2] ?? 0)
  const minutes = Number(match[3])
  const seconds = Number(match[4])
  if (
    ![days, hours, minutes, seconds].every(Number.isFinite) ||
    hours > 23 ||
    minutes > 59 ||
    seconds > 59
  )
    return null
  return days * 86_400 + hours * 3_600 + minutes * 60 + seconds
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
