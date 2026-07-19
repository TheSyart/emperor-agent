import { EmperorError } from '../errors'

export type LifecycleSupervisorState =
  'idle' | 'starting' | 'ready' | 'stopping' | 'stopped' | 'failed'

export type LifecycleServiceState =
  | 'pending'
  | 'reconciling'
  | 'starting'
  | 'waiting_ready'
  | 'ready'
  | 'stopping'
  | 'stopped'
  | 'stop_timeout'
  | 'failed'

export type LifecyclePhase = 'reconcile' | 'start' | 'ready' | 'stop'

export interface LifecycleService {
  readonly id: string
  readonly required: boolean
  readonly dependsOn: readonly string[]
  reconcile(signal: AbortSignal): void | Promise<void>
  start(signal: AbortSignal): void | Promise<void>
  ready(signal: AbortSignal): void | Promise<void>
  stop(reason: string, signal: AbortSignal): void | Promise<void>
}

export interface LifecycleServiceSnapshot {
  id: string
  required: boolean
  dependsOn: string[]
  state: LifecycleServiceState
  error: string | null
}

export interface LifecycleSupervisorSnapshot {
  state: LifecycleSupervisorState
  failedServiceId: string | null
  failedPhase: LifecyclePhase | null
  services: LifecycleServiceSnapshot[]
}

export interface LifecycleSupervisorOptions {
  startTimeoutMs?: number
  stopTimeoutMs?: number
}

export class CoreUnavailableError extends EmperorError {
  constructor(state: LifecycleSupervisorState) {
    super(`Core runtime is not ready (${state}).`, 'core_unavailable', {
      action: 'retry',
    })
  }
}

export class LifecycleStartupError extends EmperorError {
  readonly serviceId: string
  readonly phase: Exclude<LifecyclePhase, 'stop'>

  constructor(
    serviceId: string,
    phase: Exclude<LifecyclePhase, 'stop'>,
    cause: unknown,
  ) {
    super(
      `Required lifecycle service failed during ${phase}: ${serviceId}.`,
      'lifecycle_startup_failed',
      { ...(cause instanceof Error ? { cause } : {}) },
    )
    this.serviceId = serviceId
    this.phase = phase
  }
}

class LifecycleDeadlineError extends Error {
  constructor(
    readonly serviceId: string,
    readonly phase: LifecyclePhase,
    readonly timeoutMs: number,
  ) {
    super(`Lifecycle ${phase} timed out for ${serviceId} after ${timeoutMs}ms`)
    this.name = 'LifecycleDeadlineError'
  }
}

interface ServiceRecord {
  service: LifecycleService
  state: LifecycleServiceState
  error: string | null
}

const DEFAULT_START_TIMEOUT_MS = 30_000
const DEFAULT_STOP_TIMEOUT_MS = 5_000

/**
 * Owns only lifecycle ordering and state. Domain services keep their public
 * APIs and persistence semantics; adapters declare dependencies here.
 */
export class LifecycleSupervisor {
  private readonly records: ServiceRecord[]
  private readonly startTimeoutMs: number
  private readonly stopTimeoutMs: number
  private state: LifecycleSupervisorState = 'idle'
  private failedServiceId: string | null = null
  private failedPhase: LifecyclePhase | null = null
  private startupError: LifecycleStartupError | null = null
  private startPromise: Promise<void> | null = null
  private stopPromise: Promise<void> | null = null
  private readonly attemptedIds = new Set<string>()

  constructor(
    services: readonly LifecycleService[],
    opts: LifecycleSupervisorOptions = {},
  ) {
    this.records = orderServices(services).map((service) => ({
      service,
      state: 'pending',
      error: null,
    }))
    this.startTimeoutMs = boundedTimeout(
      opts.startTimeoutMs,
      DEFAULT_START_TIMEOUT_MS,
    )
    this.stopTimeoutMs = boundedTimeout(
      opts.stopTimeoutMs,
      DEFAULT_STOP_TIMEOUT_MS,
    )
  }

  start(): Promise<void> {
    if (this.startPromise) return this.startPromise
    if (this.state === 'stopping' || this.state === 'stopped')
      return Promise.reject(new CoreUnavailableError(this.state))
    this.startPromise = this.performStart()
    return this.startPromise
  }

  stop(reason = 'shutdown'): Promise<void> {
    if (this.stopPromise) return this.stopPromise
    this.stopPromise = this.performStop(reason)
    return this.stopPromise
  }

  assertReady(): void {
    if (this.state !== 'ready') throw new CoreUnavailableError(this.state)
  }

  snapshot(): LifecycleSupervisorSnapshot {
    return {
      state: this.state,
      failedServiceId: this.failedServiceId,
      failedPhase: this.failedPhase,
      services: this.records.map(({ service, state, error }) => ({
        id: service.id,
        required: service.required,
        dependsOn: [...service.dependsOn],
        state,
        error,
      })),
    }
  }

  private async performStart(): Promise<void> {
    if (this.startupError) throw this.startupError
    this.state = 'starting'
    for (const record of this.records) {
      const phases = [
        ['reconcile', 'reconciling'],
        ['start', 'starting'],
        ['ready', 'waiting_ready'],
      ] as const
      for (const [phase, serviceState] of phases) {
        record.state = serviceState
        if (phase === 'start') this.attemptedIds.add(record.service.id)
        try {
          await runWithDeadline(
            record.service.id,
            phase,
            this.startTimeoutMs,
            (signal) => record.service[phase](signal),
          )
        } catch (error) {
          record.state = 'failed'
          record.error = safeErrorMessage(error)
          if (!record.service.required) break
          this.failedServiceId = record.service.id
          this.failedPhase = phase
          this.startupError = new LifecycleStartupError(
            record.service.id,
            phase,
            error,
          )
          await this.stopAttempted('startup failure')
          this.state = 'failed'
          throw this.startupError
        }
      }
      if (record.state !== 'failed') record.state = 'ready'
    }
    this.state = 'ready'
  }

  private async performStop(reason: string): Promise<void> {
    if (this.state === 'stopped') return
    if (this.state === 'starting' && this.startPromise) {
      await this.startPromise.catch(() => {})
      if (this.startupError) return
    }
    this.state = 'stopping'
    await this.stopAttempted(reason)
    this.state = 'stopped'
  }

  private async stopAttempted(reason: string): Promise<void> {
    for (const record of [...this.records].reverse()) {
      if (!this.attemptedIds.has(record.service.id)) continue
      if (record.state === 'stopped' || record.state === 'stop_timeout')
        continue
      record.state = 'stopping'
      try {
        await runWithDeadline(
          record.service.id,
          'stop',
          this.stopTimeoutMs,
          (signal) => record.service.stop(reason, signal),
        )
        record.state = 'stopped'
      } catch (error) {
        record.error = safeErrorMessage(error)
        record.state =
          error instanceof LifecycleDeadlineError ? 'stop_timeout' : 'failed'
      }
    }
  }
}

function orderServices(
  services: readonly LifecycleService[],
): LifecycleService[] {
  const byId = new Map<string, LifecycleService>()
  for (const service of services) {
    const id = String(service.id).trim()
    if (!id) throw new Error('lifecycle service id is required')
    if (byId.has(id)) throw new Error(`duplicate lifecycle service: ${id}`)
    byId.set(id, service)
  }
  for (const service of services) {
    for (const dependency of service.dependsOn) {
      if (!byId.has(dependency))
        throw new Error(
          `unknown lifecycle dependency: ${service.id} -> ${dependency}`,
        )
    }
  }
  const ordered: LifecycleService[] = []
  const remaining = new Set(byId.keys())
  while (remaining.size) {
    let advanced = false
    for (const service of services) {
      if (!remaining.has(service.id)) continue
      if (service.dependsOn.some((id) => remaining.has(id))) continue
      ordered.push(service)
      remaining.delete(service.id)
      advanced = true
    }
    if (!advanced)
      throw new Error(
        `lifecycle dependency cycle: ${[...remaining].sort().join(', ')}`,
      )
  }
  return ordered
}

function runWithDeadline(
  serviceId: string,
  phase: LifecyclePhase,
  timeoutMs: number,
  operation: (signal: AbortSignal) => void | Promise<void>,
): Promise<void> {
  const controller = new AbortController()
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (callback: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      callback()
    }
    const timer = setTimeout(() => {
      controller.abort(`${phase} deadline exceeded`)
      finish(() =>
        reject(new LifecycleDeadlineError(serviceId, phase, timeoutMs)),
      )
    }, timeoutMs)
    Promise.resolve()
      .then(() => operation(controller.signal))
      .then(
        () => finish(resolve),
        (error) => finish(() => reject(error)),
      )
  })
}

function boundedTimeout(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.max(1, Math.min(120_000, Math.trunc(value!)))
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 500)
  return String(error).slice(0, 500)
}
