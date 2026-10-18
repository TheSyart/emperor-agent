import type { Readable, Writable } from 'node:stream'
import { createHash } from 'node:crypto'
import { readJsonLines } from '../process'
import { DelegationError } from '../types'
import { redactExecutorText } from '../redaction'
export type RpcId = string | number
export interface CodexRpcOptions {
  input: Readable
  output: Writable
  generation: number
  onNotification?: (method: string, params: Record<string, unknown>) => void
  onRequest?: (
    id: RpcId,
    method: string,
    params: Record<string, unknown>,
  ) => void | Promise<void>
  onClose?: (error: Error) => void
  requestTimeoutMs?: number
  idleTimeoutMs?: number
  secretValues?: readonly string[]
}
interface Pending {
  resolve: (value: Record<string, unknown>) => void
  reject: (error: unknown) => void
  dispose: () => void
  method: string
  maxResultBytes?: number
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
function key(id: RpcId): string {
  return typeof id + ':' + String(id)
}
/**
 * JSON-RPC over the app-server's stdio. The idle timer (default 120 s) only
 * guards a silent protocol between turns: it pauses while a server request
 * (a question for the user) waits for its answer and while a caller holds it
 * (a running turn). A long turn is bounded by the delegation's run limit.
 */
export class CodexRpc {
  private nextId = 1
  private ended = false
  private idle: ReturnType<typeof setTimeout> | undefined
  private holds = 0
  private unanswered = 0
  private readonly pending = new Map<RpcId, Pending>()
  private readonly requests = new Map<
    string,
    { id: RpcId; digest: string; answered: boolean }
  >()
  constructor(private readonly options: CodexRpcOptions) {
    this.touch()
    options.output.on('error', () =>
      this.finish(new DelegationError('CONNECTION_LOST', 'Codex stdin failed')),
    )
    void this.read().catch((error) =>
      this.finish(
        error instanceof DelegationError
          ? error
          : new DelegationError('CONNECTION_LOST', 'Codex stdout failed'),
      ),
    )
  }
  /** Pause the idle timer until the returned release is called (idempotent). */
  hold(): () => void {
    this.holds++
    this.touch()
    let released = false
    return () => {
      if (released) return
      released = true
      this.holds--
      this.touch()
    }
  }
  private touch(): void {
    if (this.idle) clearTimeout(this.idle)
    this.idle = undefined
    if (this.ended || this.holds > 0 || this.unanswered > 0) return
    this.idle = setTimeout(
      () =>
        this.finish(
          new DelegationError('IDLE_TIMEOUT', 'Codex protocol remained idle'),
        ),
      this.options.idleTimeoutMs ?? 120000,
    )
    this.idle.unref()
  }
  private async write(value: unknown): Promise<void> {
    if (this.ended)
      throw new DelegationError('CONNECTION_LOST', 'Codex transport is closed')
    const text = JSON.stringify(value) + '\n'
    if (Buffer.byteLength(text) > 4 * 1024 * 1024)
      throw new DelegationError(
        'OUTPUT_LIMIT',
        'Codex request frame exceeded byte limit',
      )
    await new Promise<void>((resolve, reject) =>
      this.options.output.write(text, (error) =>
        error
          ? reject(
              new DelegationError(
                'CONNECTION_LOST',
                'Codex stdin write failed',
              ),
            )
          : resolve(),
      ),
    )
  }
  request(
    method: string,
    params: unknown,
    signal?: AbortSignal,
    options: { maxResultBytes?: number } = {},
  ): Promise<Record<string, unknown>> {
    if (this.ended)
      return Promise.reject(
        new DelegationError('CONNECTION_LOST', 'Codex transport is closed'),
      )
    if (signal?.aborted)
      return Promise.reject(
        signal.reason ?? new DOMException('Aborted', 'AbortError'),
      )
    if (this.pending.size >= 64)
      return Promise.reject(
        new DelegationError('RPC_LIMIT', 'too many outstanding requests'),
      )
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const fail = (error: unknown) => {
        const p = this.pending.get(id)
        if (!p) return
        this.pending.delete(id)
        p.dispose()
        reject(error)
      }
      const abort = () =>
        fail(signal?.reason ?? new DOMException('Aborted', 'AbortError'))
      const timer = setTimeout(
        () =>
          fail(
            new DelegationError('RPC_TIMEOUT', method + ' response timed out'),
          ),
        this.options.requestTimeoutMs ?? 30000,
      )
      timer.unref()
      this.pending.set(id, {
        method,
        ...(options.maxResultBytes
          ? { maxResultBytes: options.maxResultBytes }
          : {}),
        resolve,
        reject,
        dispose: () => {
          clearTimeout(timer)
          signal?.removeEventListener('abort', abort)
        },
      })
      signal?.addEventListener('abort', abort, { once: true })
      void this.write({ id, method, params }).catch(fail)
    })
  }
  notify(method: string, params?: unknown): Promise<void> {
    return this.write({ method, ...(params === undefined ? {} : { params }) })
  }
  private async answer(
    id: RpcId,
    payload: unknown,
    generation: number,
  ): Promise<void> {
    if (generation !== this.options.generation)
      throw new DelegationError(
        'STALE_RUN',
        'server request generation changed',
      )
    const request = this.requests.get(key(id))
    if (!request || request.answered)
      throw new DelegationError(
        'REQUEST_NOT_FOUND',
        'server request is missing or already answered',
      )
    request.answered = true
    this.unanswered--
    this.touch()
    await this.write({ id, ...(payload as Record<string, unknown>) })
  }
  respond(id: RpcId, result: unknown, generation: number): Promise<void> {
    return this.answer(id, { result }, generation)
  }
  reject(
    id: RpcId,
    code: number,
    message: string,
    generation: number,
  ): Promise<void> {
    return this.answer(id, { error: { code, message } }, generation)
  }
  private async read(): Promise<void> {
    for await (const frame of readJsonLines(this.options.input)) {
      if (this.ended) return
      this.touch()
      const id = frame.id
      if (id !== undefined && typeof id !== 'string' && typeof id !== 'number')
        throw new DelegationError('PROTOCOL_INVALID', 'invalid RPC id')
      if (typeof frame.method === 'string') {
        if (!isRecord(frame.params) && frame.params !== undefined)
          throw new DelegationError('PROTOCOL_INVALID', 'invalid RPC params')
        const params = frame.params ?? {}
        if (id === undefined) {
          this.options.onNotification?.(
            frame.method,
            params as Record<string, unknown>,
          )
          continue
        }
        const digest = createHash('sha256')
            .update(JSON.stringify([frame.method, params]))
            .digest('hex'),
          previous = this.requests.get(key(id))
        if (previous) {
          if (previous.digest !== digest)
            throw new DelegationError(
              'PROTOCOL_INVALID',
              'server request id reused with different content',
            )
          continue
        }
        if (this.requests.size >= 1024)
          throw new DelegationError(
            'RPC_LIMIT',
            'server request history exceeded run limit',
          )
        this.requests.set(key(id), { id, digest, answered: false })
        this.unanswered++
        this.touch()
        const method = frame.method
        void Promise.resolve()
          .then(async () => {
            if (this.options.onRequest)
              await this.options.onRequest(
                id,
                method,
                params as Record<string, unknown>,
              )
            else
              await this.reject(
                id,
                -32601,
                'Unsupported server request',
                this.options.generation,
              )
          })
          .catch(async () => {
            if (!this.ended && !this.requests.get(key(id))?.answered)
              await this.reject(
                id,
                -32603,
                'Server request handler failed',
                this.options.generation,
              ).catch(() => undefined)
          })
        continue
      }
      if (id === undefined)
        throw new DelegationError(
          'PROTOCOL_INVALID',
          'RPC frame has no method or response id',
        )
      const p = this.pending.get(id)
      if (!p) continue
      this.pending.delete(id)
      p.dispose()
      if (isRecord(frame.error)) {
        const detail = redactExecutorText(
          typeof frame.error.message === 'string'
            ? frame.error.message
            : 'upstream request rejected',
          this.options.secretValues ?? [],
        ).slice(0, 4096)
        p.reject(new DelegationError('RPC_ERROR', p.method + ': ' + detail))
      } else if (isRecord(frame.result)) {
        if (
          p.maxResultBytes !== undefined &&
          Buffer.byteLength(JSON.stringify(frame.result)) > p.maxResultBytes
        )
          p.reject(
            new DelegationError(
              'OUTPUT_LIMIT',
              p.method + ' result exceeded the page byte limit',
            ),
          )
        else p.resolve(frame.result)
      } else
        p.reject(
          new DelegationError(
            'PROTOCOL_INVALID',
            'Codex returned a non-object result',
          ),
        )
    }
    this.finish(new DelegationError('CONNECTION_LOST', 'Codex stdout ended'))
  }
  private finish(error: Error): void {
    if (this.ended) return
    this.ended = true
    if (this.idle) clearTimeout(this.idle)
    for (const p of this.pending.values()) {
      p.dispose()
      p.reject(error)
    }
    this.pending.clear()
    this.options.input.destroy()
    this.options.output.end()
    try {
      this.options.onClose?.(error)
    } catch {
      /* Observers cannot change transport settlement. */
    }
  }
  close(): void {
    this.finish(
      new DelegationError('CONNECTION_LOST', 'Codex transport closed'),
    )
  }
}
