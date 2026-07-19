import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto'
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http'
import type { AddressInfo } from 'node:net'
import { ExternalAdapter, type ExternalSendContext } from './adapter'
import type { ExternalAuditInput } from './audit'
import { ExternalAuditStore } from './audit'
import type { SignedWebhookConfig } from './config'
import {
  ExternalDeliveryResult,
  ExternalInbound,
  type ExternalOutbound,
} from './models'
import { EXTERNAL_TARGET_SESSION_METADATA_KEY } from './service'

export const SIGNED_WEBHOOK_MAX_CONTENT_BYTES = 65_536
const SIGNED_WEBHOOK_REQUEST_TIMEOUT_MS = 10_000
const SIGNED_WEBHOOK_MAX_CONNECTIONS = 64

export type WebhookAuthReason =
  | 'ok'
  | 'auth_unavailable'
  | 'unknown_key'
  | 'invalid_timestamp'
  | 'stale_timestamp'
  | 'invalid_nonce'
  | 'invalid_signature'

export interface WebhookAuthResult {
  ok: boolean
  reasonCode: WebhookAuthReason
}

export interface VerifyWebhookSignatureInput {
  secret: string | Buffer
  keyId: string
  expectedKeyId: string
  timestamp: string
  nonce: string
  signature: string
  body: Buffer
  nowSeconds: number
  timestampSkewSeconds: number
}

export interface SignedWebhookMessage {
  id: string
  senderId: string
  targetId: string
  content: string
}

export type SignedWebhookState =
  | 'idle'
  | 'eval'
  | 'starting'
  | 'ready'
  | 'auth_failed'
  | 'degraded'
  | 'stopping'
  | 'stopped'

export interface SignedWebhookIngestContext {
  signal: AbortSignal
  onAdmitted?: () => void
}

export type SignedWebhookIngest = (
  message: ExternalInbound,
  context: SignedWebhookIngestContext,
) => Promise<Record<string, unknown>>

export interface SignedWebhookAdapterOptions {
  config: SignedWebhookConfig
  secret: string | Buffer
  ingest: SignedWebhookIngest
  auditStore: ExternalAuditStore
  clock?: () => number
  fetchImpl?: typeof fetch
  preflight?: () => string | null
  configDiagnostics?: {
    path: string
    status: 'missing' | 'ok' | 'invalid'
  }
}

interface Bucket {
  tokens: number
  updatedAt: number
  lastUsedAt: number
}

class BoundedTokenBucket {
  private readonly buckets = new Map<string, Bucket>()

  constructor(
    private readonly perMinute: number,
    private readonly burst: number,
    private readonly maxKeys = 1_024,
  ) {}

  take(key: string, now: number): boolean {
    this.prune(now)
    let bucket = this.buckets.get(key)
    if (!bucket) {
      if (this.buckets.size >= this.maxKeys) {
        const oldest = [...this.buckets.entries()].sort(
          (left, right) => left[1].lastUsedAt - right[1].lastUsedAt,
        )[0]
        if (oldest) this.buckets.delete(oldest[0])
      }
      bucket = { tokens: this.burst, updatedAt: now, lastUsedAt: now }
      this.buckets.set(key, bucket)
    }
    const elapsed = Math.max(0, now - bucket.updatedAt)
    bucket.tokens = Math.min(
      this.burst,
      bucket.tokens + (elapsed * this.perMinute) / 60,
    )
    bucket.updatedAt = now
    bucket.lastUsedAt = now
    if (bucket.tokens < 1) return false
    bucket.tokens -= 1
    return true
  }

  private prune(now: number): void {
    for (const [key, bucket] of this.buckets)
      if (now - bucket.lastUsedAt > 600) this.buckets.delete(key)
  }
}

export class SignedWebhookAdapter extends ExternalAdapter {
  override name = 'signed-webhook'
  override display_name = 'Signed Webhook'
  private readonly config: SignedWebhookConfig
  private readonly secret: string | Buffer
  private readonly ingest: SignedWebhookIngest
  private readonly auditStore: ExternalAuditStore
  private readonly clock: () => number
  private readonly fetchImpl: typeof fetch
  private readonly preflight: () => string | null
  private readonly configDiagnostics: SignedWebhookAdapterOptions['configDiagnostics']
  private readonly preAuthLimiter: BoundedTokenBucket
  private readonly authenticatedLimiter: BoundedTokenBucket
  private readonly invalidAuthLimiter: BoundedTokenBucket
  private readonly outboundLimiter: BoundedTokenBucket
  private server: ReturnType<typeof createServer> | null = null
  private state: SignedWebhookState = 'idle'
  private endpoint: string | null = null
  private accepting = false
  private lastReason: string | null = null
  private accepted = 0
  private rejected = 0
  private outboundSent = 0
  private outboundDeadLetter = 0
  private auditRecordsAtStart = 0
  private auditAppendBaseline = 0
  private auditBadLines = 0
  private auditArchives = 0
  private readonly background = new Set<Promise<void>>()
  private readonly controllers = new Set<AbortController>()
  private startPromise: Promise<void> | null = null
  private stopPromise: Promise<void> | null = null

  constructor(opts: SignedWebhookAdapterOptions) {
    super()
    this.config = { ...opts.config }
    this.secret = opts.secret
    this.ingest = opts.ingest
    this.auditStore = opts.auditStore
    this.clock = opts.clock ?? (() => Date.now() / 1000)
    this.fetchImpl = opts.fetchImpl ?? fetch
    this.preflight = opts.preflight ?? (() => null)
    this.configDiagnostics = opts.configDiagnostics
    this.preAuthLimiter = new BoundedTokenBucket(600, 100, 1)
    this.authenticatedLimiter = new BoundedTokenBucket(
      this.config.requestsPerMinute,
      this.config.burst,
    )
    this.invalidAuthLimiter = new BoundedTokenBucket(
      this.config.requestsPerMinute,
      this.config.burst,
      1,
    )
    this.outboundLimiter = new BoundedTokenBucket(
      this.config.requestsPerMinute,
      this.config.burst,
    )
  }

  override get capabilities(): Record<string, unknown> {
    return {
      ingress: true,
      outbound: Boolean(this.config.outboundUrl),
      authentication: 'hmac-sha256',
      bind: 'loopback-only',
      rateLimited: true,
    }
  }

  get endpointUrl(): string | null {
    return this.endpoint
  }

  override start(): Promise<void> {
    if (this.startPromise) return this.startPromise
    const started = this.startInner()
    this.startPromise = started
    return started
  }

  private async startInner(): Promise<void> {
    if (this.state === 'ready' || this.state === 'eval') return
    await this.refreshAuditDiagnostics()
    if (this.config.mode === 'off') {
      this.state = 'stopped'
      this.lastReason = 'mode_off'
      return
    }
    const preflightReason = this.safePreflight()
    if (preflightReason) {
      this.state = 'degraded'
      this.lastReason = preflightReason
      await this.auditLifecycle('degraded', preflightReason).catch(() => {})
      return
    }
    if (Buffer.byteLength(this.secret) < 32) {
      this.state = 'auth_failed'
      this.lastReason = 'credential_unavailable'
      await this.auditLifecycle('degraded', 'credential_unavailable').catch(
        () => {},
      )
      return
    }
    if (this.config.mode === 'eval') {
      this.state = 'eval'
      this.lastReason = 'evaluation_only'
      await this.auditLifecycle('started', 'evaluation_only').catch(() => {})
      return
    }
    this.state = 'starting'
    try {
      await this.auditLifecycle('started', 'starting').catch(() => {})
      const server = createServer((request, response) => {
        void this.handleRequest(request, response)
      })
      server.headersTimeout = SIGNED_WEBHOOK_REQUEST_TIMEOUT_MS
      server.requestTimeout = SIGNED_WEBHOOK_REQUEST_TIMEOUT_MS
      server.keepAliveTimeout = 1_000
      server.maxHeadersCount = 32
      server.maxConnections = SIGNED_WEBHOOK_MAX_CONNECTIONS
      server.maxRequestsPerSocket = 100
      this.server = server
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => reject(error)
        server.once('error', onError)
        server.listen(this.config.port, this.config.bindHost, () => {
          server.off('error', onError)
          resolve()
        })
      })
      const address = server.address() as AddressInfo | null
      if (!address) throw new Error('listener address unavailable')
      const host =
        address.family === 'IPv6' ? `[${address.address}]` : address.address
      this.endpoint = `http://${host}:${address.port}${this.config.path}`
      this.accepting = true
      this.state = 'ready'
      this.lastReason = null
    } catch {
      this.accepting = false
      this.state = 'degraded'
      this.lastReason = 'listener_unavailable'
      await this.closeServer()
      await this.auditLifecycle('degraded', 'listener_unavailable').catch(
        () => {},
      )
    }
  }

  override stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise
    const stopped = this.stopInner()
    this.stopPromise = stopped
    return stopped
  }

  private async stopInner(): Promise<void> {
    if (this.state === 'stopped') return
    this.state = 'stopping'
    this.accepting = false
    for (const controller of this.controllers)
      controller.abort(new Error('external adapter stopped'))
    await this.closeServer()
    await this.waitForIdle(Math.min(this.config.outboundTimeoutMs, 4_000))
    this.endpoint = null
    this.state = 'stopped'
    this.lastReason = 'stopped'
    await this.auditLifecycle('stopped', 'stopped').catch(() => {})
  }

  async waitForIdle(timeoutMs?: number): Promise<void> {
    const drain = async (): Promise<void> => {
      while (this.background.size)
        await Promise.allSettled([...this.background])
    }
    if (timeoutMs === undefined) return await drain()
    let timeout: ReturnType<typeof setTimeout> | null = null
    await Promise.race([
      drain(),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, timeoutMs)
      }),
    ])
    if (timeout) clearTimeout(timeout)
  }

  override status(): Record<string, unknown> {
    return {
      ...super.status(),
      state: this.state,
      requestedMode: this.config.mode,
      effectiveMode:
        this.state === 'ready' ? 'on' : this.state === 'eval' ? 'eval' : 'off',
      endpoint: this.endpoint,
      accepted: this.accepted,
      rejected: this.rejected,
      outboundSent: this.outboundSent,
      outboundDeadLetter: this.outboundDeadLetter,
      active: this.background.size,
      lastReason: this.lastReason,
      limits: {
        preAuthRequestsPerMinute: 600,
        preAuthBurst: 100,
        requestsPerMinute: this.config.requestsPerMinute,
        burst: this.config.burst,
        maxBodyBytes: this.config.maxBodyBytes,
        timestampSkewSeconds: this.config.timestampSkewSeconds,
        outboundTimeoutMs: this.config.outboundTimeoutMs,
        requestTimeoutMs: SIGNED_WEBHOOK_REQUEST_TIMEOUT_MS,
        maxConnections: SIGNED_WEBHOOK_MAX_CONNECTIONS,
      },
      audit: {
        path: this.auditStore.auditPath,
        maxHotBytes: this.auditStore.maxHotBytes,
        maxArchives: this.auditStore.maxArchives,
        records:
          this.auditRecordsAtStart +
          Math.max(
            0,
            this.auditStore.appendedRecords - this.auditAppendBaseline,
          ),
        badLines: this.auditBadLines,
        archives: this.auditArchives,
        writeFailures: this.auditStore.writeFailures,
      },
      configuration: this.configDiagnostics
        ? { ...this.configDiagnostics }
        : undefined,
    }
  }

  override async send(
    message: ExternalOutbound,
    context: ExternalSendContext = {},
  ): Promise<ExternalDeliveryResult> {
    const startedAt = this.clock()
    const messageIdDigest = digestNullable(message.id)
    const fail = async (
      reasonCode: string,
      statusCode: number | null = null,
    ): Promise<ExternalDeliveryResult> => {
      this.outboundDeadLetter += 1
      this.lastReason = reasonCode
      await this.auditStore
        .append({
          adapter: 'signed-webhook',
          direction: 'outbound',
          outcome: 'dead-letter',
          reasonCode,
          messageIdDigest,
          keyIdDigest: digestNullable(this.config.keyId || null),
          remoteDigest: null,
          statusCode,
          durationMs: durationMs(startedAt, this.clock()),
        })
        .catch(() => {})
      return new ExternalDeliveryResult({
        ok: false,
        error: outboundError(reasonCode),
        metadata: { reasonCode, statusCode },
      })
    }
    if (this.state !== 'ready' || !this.accepting)
      return await fail('adapter_unavailable')
    if (!this.config.outboundUrl) return await fail('outbound_not_configured')
    if (!validOutbound(message)) return await fail('invalid_outbound')
    if (!this.outboundLimiter.take(this.config.keyId, this.clock()))
      return await fail('rate_limited', 429)

    const timestamp = Math.trunc(this.clock())
    const nonce = randomUUID().replaceAll('-', '')
    const body = JSON.stringify({
      version: 1,
      delivery: {
        id: message.id,
        targetId: message.target_id,
        content: message.content,
        createdAt: message.created_at,
      },
    })
    const bodyBytes = Buffer.from(body, 'utf8')
    const controller = new AbortController()
    this.controllers.add(controller)
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      controller.abort(new Error('external outbound timeout'))
    }, this.config.outboundTimeoutMs)
    const externalSignal = context.signal ?? null
    const relayAbort = (): void =>
      controller.abort(
        externalSignal?.reason ?? new Error('external cancelled'),
      )
    if (externalSignal?.aborted) relayAbort()
    else externalSignal?.addEventListener('abort', relayAbort, { once: true })
    try {
      const response = await this.fetchImpl(this.config.outboundUrl, {
        method: 'POST',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          'idempotency-key': message.id,
          'x-emperor-key-id': this.config.keyId,
          'x-emperor-timestamp': String(timestamp),
          'x-emperor-nonce': nonce,
          'x-emperor-signature': signWebhookBody(
            this.secret,
            timestamp,
            nonce,
            bodyBytes,
          ),
        },
        body,
      })
      if (response.status < 200 || response.status >= 300)
        return await fail(
          response.status >= 300 && response.status < 400
            ? 'redirect_rejected'
            : 'http_error',
          response.status,
        )
      this.outboundSent += 1
      this.lastReason = null
      await this.auditStore
        .append({
          adapter: 'signed-webhook',
          direction: 'outbound',
          outcome: 'sent',
          reasonCode: 'sent',
          messageIdDigest,
          keyIdDigest: digestNullable(this.config.keyId || null),
          remoteDigest: null,
          statusCode: response.status,
          durationMs: durationMs(startedAt, this.clock()),
        })
        .catch(() => {})
      return new ExternalDeliveryResult({
        ok: true,
        external_message_id: message.id,
        metadata: { reasonCode: 'sent', statusCode: response.status },
      })
    } catch {
      return await fail(
        timedOut
          ? 'timeout'
          : controller.signal.aborted
            ? 'cancelled'
            : 'network_error',
      )
    } finally {
      clearTimeout(timeout)
      externalSignal?.removeEventListener('abort', relayAbort)
      this.controllers.delete(controller)
    }
  }

  private async handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const startedAt = this.clock()
    const remoteDigest = digestNullable(request.socket.remoteAddress ?? null)
    const keyId = header(request, 'x-emperor-key-id')
    const keyIdDigest = digestNullable(keyId || null)
    try {
      if (!this.accepting || this.state !== 'ready') {
        await this.reject(response, 503, 'adapter_unavailable', startedAt, {
          keyIdDigest,
          remoteDigest,
        })
        return
      }
      const preflightReason = this.safePreflight()
      if (preflightReason) {
        this.accepting = false
        this.state = 'degraded'
        this.lastReason = preflightReason
        await this.auditLifecycle('degraded', preflightReason).catch(() => {})
        await this.reject(response, 503, preflightReason, startedAt, {
          keyIdDigest,
          remoteDigest,
        })
        return
      }
      if (!this.preAuthLimiter.take('all', this.clock())) {
        await this.reject(response, 429, 'rate_limited', startedAt, {
          keyIdDigest,
          remoteDigest,
        })
        return
      }
      if (request.method !== 'POST') {
        await this.reject(response, 405, 'method_not_allowed', startedAt, {
          keyIdDigest,
          remoteDigest,
        })
        return
      }
      if (request.url !== this.config.path) {
        await this.reject(response, 404, 'path_not_found', startedAt, {
          keyIdDigest,
          remoteDigest,
        })
        return
      }
      const contentType = String(request.headers['content-type'] ?? '')
        .split(';')[0]
        ?.trim()
        .toLowerCase()
      if (contentType !== 'application/json') {
        await this.reject(response, 415, 'unsupported_media_type', startedAt, {
          keyIdDigest,
          remoteDigest,
        })
        return
      }
      const contentLength = Number(request.headers['content-length'] ?? 0)
      if (
        Number.isFinite(contentLength) &&
        contentLength > this.config.maxBodyBytes
      ) {
        request.resume()
        await this.reject(response, 413, 'body_too_large', startedAt, {
          keyIdDigest,
          remoteDigest,
        })
        return
      }
      const body = await readRequestBody(request, this.config.maxBodyBytes)
      const auth = verifyWebhookSignature({
        secret: this.secret,
        keyId,
        expectedKeyId: this.config.keyId,
        timestamp: header(request, 'x-emperor-timestamp'),
        nonce: header(request, 'x-emperor-nonce'),
        signature: header(request, 'x-emperor-signature'),
        body,
        nowSeconds: this.clock(),
        timestampSkewSeconds: this.config.timestampSkewSeconds,
      })
      if (!auth.ok) {
        if (!this.invalidAuthLimiter.take('anonymous', this.clock())) {
          await this.reject(response, 429, 'rate_limited', startedAt, {
            keyIdDigest,
            remoteDigest,
          })
          return
        }
        await this.reject(response, 401, auth.reasonCode, startedAt, {
          keyIdDigest,
          remoteDigest,
        })
        return
      }
      if (!this.authenticatedLimiter.take(this.config.keyId, this.clock())) {
        await this.reject(response, 429, 'rate_limited', startedAt, {
          keyIdDigest,
          remoteDigest,
        })
        return
      }
      let raw: unknown
      try {
        raw = JSON.parse(body.toString('utf8'))
      } catch {
        await this.reject(response, 400, 'invalid_json', startedAt, {
          keyIdDigest,
          remoteDigest,
        })
        return
      }
      let decoded: SignedWebhookMessage
      try {
        decoded = decodeSignedWebhookPayload(raw)
      } catch {
        await this.reject(response, 422, 'invalid_payload', startedAt, {
          keyIdDigest,
          remoteDigest,
        })
        return
      }
      const messageIdDigest = digestNullable(decoded.id)
      const controller = new AbortController()
      this.controllers.add(controller)
      const inbound = new ExternalInbound({
        platform: this.name,
        sender_id: decoded.senderId,
        target_id: decoded.targetId,
        external_message_id: decoded.id,
        content: decoded.content,
        metadata: {
          [EXTERNAL_TARGET_SESSION_METADATA_KEY]: this.config.sessionId,
        },
        received_at: this.clock(),
      })
      let admitted = false
      let resolveAdmission!: () => void
      const admission = new Promise<void>((resolve) => {
        resolveAdmission = resolve
      })
      const onAdmitted = (): void => {
        if (admitted) return
        admitted = true
        resolveAdmission()
      }
      let ingest: Promise<Record<string, unknown>>
      try {
        ingest = this.ingest(inbound, {
          signal: controller.signal,
          onAdmitted,
        })
      } catch (error) {
        controller.abort(error)
        this.controllers.delete(controller)
        await this.reject(response, 503, 'ingest_unavailable', startedAt, {
          keyIdDigest,
          remoteDigest,
          messageIdDigest,
        })
        return
      }
      let admissionTimeout: ReturnType<typeof setTimeout> | null = null
      const gate = await Promise.race([
        admission.then(() => ({ kind: 'admitted' as const })),
        ingest.then(
          (result) => ({ kind: 'completed' as const, result }),
          () => ({ kind: 'failed' as const }),
        ),
        new Promise<{ kind: 'timeout' }>((resolve) => {
          admissionTimeout = setTimeout(
            () => resolve({ kind: 'timeout' }),
            5_000,
          )
        }),
      ])
      if (admissionTimeout) clearTimeout(admissionTimeout)
      if (gate.kind === 'failed' || gate.kind === 'timeout') {
        controller.abort(new Error('external admission failed'))
        this.controllers.delete(controller)
        void ingest.catch(() => {})
        await this.reject(
          response,
          503,
          gate.kind === 'timeout' ? 'admission_timeout' : 'ingest_unavailable',
          startedAt,
          {
            keyIdDigest,
            remoteDigest,
            messageIdDigest: digestNullable(decoded.id),
          },
        )
        return
      }
      // Test/custom adapters may complete atomically without exposing a
      // separate durable receipt. Production bridge calls onAdmitted directly
      // after its state write and always reaches the other race branch first.
      if (gate.kind === 'completed') onAdmitted()
      await this.auditStore
        .append({
          adapter: 'signed-webhook',
          direction: 'ingress',
          outcome: 'accepted',
          reasonCode: 'accepted',
          messageIdDigest,
          keyIdDigest,
          remoteDigest,
          statusCode: 202,
          durationMs: durationMs(startedAt, this.clock()),
        })
        .catch(() => {})
      const tracked = ingest
        .then(async (result) => {
          const status = String(result.status ?? '')
          if (status !== 'failed' && status !== 'dead-letter') return
          await this.auditStore
            .append({
              adapter: 'signed-webhook',
              direction: 'ingress',
              outcome: 'dead-letter',
              reasonCode: controller.signal.aborted
                ? 'ingest_cancelled'
                : status === 'dead-letter'
                  ? 'ingest_dead_letter'
                  : 'ingest_failed',
              messageIdDigest,
              keyIdDigest,
              remoteDigest,
              statusCode: null,
              durationMs: durationMs(startedAt, this.clock()),
            })
            .catch(() => {})
        })
        .catch(async () => {
          await this.auditStore
            .append({
              adapter: 'signed-webhook',
              direction: 'ingress',
              outcome: 'dead-letter',
              reasonCode: controller.signal.aborted
                ? 'ingest_cancelled'
                : 'ingest_failed',
              messageIdDigest,
              keyIdDigest,
              remoteDigest,
              statusCode: null,
              durationMs: durationMs(startedAt, this.clock()),
            })
            .catch(() => {})
        })
        .finally(() => {
          this.controllers.delete(controller)
          this.background.delete(tracked)
        })
      this.background.add(tracked)
      this.accepted += 1
      respondJson(response, 202, { status: 'accepted' })
    } catch (error) {
      const reason =
        error instanceof RequestBodyError ? error.reasonCode : 'internal_error'
      const status = error instanceof RequestBodyError ? error.statusCode : 503
      await this.reject(response, status, reason, startedAt, {
        keyIdDigest,
        remoteDigest,
      })
    }
  }

  private async reject(
    response: ServerResponse,
    statusCode: number,
    reasonCode: string,
    startedAt: number,
    identities: {
      keyIdDigest: string | null
      remoteDigest: string | null
      messageIdDigest?: string | null
    },
  ): Promise<void> {
    this.rejected += 1
    this.lastReason = reasonCode
    await this.auditStore
      .append({
        adapter: 'signed-webhook',
        direction: 'ingress',
        outcome: 'rejected',
        reasonCode,
        messageIdDigest: identities.messageIdDigest ?? null,
        keyIdDigest: identities.keyIdDigest,
        remoteDigest: identities.remoteDigest,
        statusCode,
        durationMs: durationMs(startedAt, this.clock()),
      })
      .catch(() => {})
    respondJson(response, statusCode, {
      status: 'rejected',
      reason: reasonCode,
    })
  }

  private async auditLifecycle(
    outcome: ExternalAuditInput['outcome'],
    reasonCode: string,
  ): Promise<void> {
    await this.auditStore.append({
      adapter: 'signed-webhook',
      direction: 'lifecycle',
      outcome,
      reasonCode,
      messageIdDigest: null,
      keyIdDigest: digestNullable(this.config.keyId || null),
      remoteDigest: null,
      statusCode: null,
      durationMs: null,
    })
  }

  private async closeServer(): Promise<void> {
    const server = this.server
    this.server = null
    if (!server) return
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections?.()
    })
  }

  private async refreshAuditDiagnostics(): Promise<void> {
    try {
      const diagnostics = await this.auditStore.diagnostics()
      this.auditRecordsAtStart = diagnostics.records
      this.auditAppendBaseline = this.auditStore.appendedRecords
      this.auditBadLines = diagnostics.badLines
      this.auditArchives = diagnostics.archives.length
    } catch {
      this.lastReason = 'audit_unavailable'
    }
  }

  private safePreflight(): string | null {
    try {
      return this.preflight()
    } catch {
      return 'preflight_failed'
    }
  }
}

const ROOT_FIELDS = new Set(['version', 'message'])
const MESSAGE_FIELDS = new Set(['id', 'senderId', 'targetId', 'content'])

export function signWebhookBody(
  secret: string | Buffer,
  timestamp: number,
  nonce: string,
  body: Buffer,
): string {
  const mac = createHmac('sha256', secret)
  mac.update(String(Math.trunc(timestamp)), 'utf8')
  mac.update('.', 'utf8')
  mac.update(nonce, 'utf8')
  mac.update('.', 'utf8')
  mac.update(body)
  return `sha256=${mac.digest('hex')}`
}

export function verifyWebhookSignature(
  input: VerifyWebhookSignatureInput,
): WebhookAuthResult {
  if (Buffer.byteLength(input.secret) < 32)
    return { ok: false, reasonCode: 'auth_unavailable' }
  if (!constantTimeTextEqual(input.keyId, input.expectedKeyId))
    return { ok: false, reasonCode: 'unknown_key' }
  if (!/^\d{1,12}$/.test(input.timestamp))
    return { ok: false, reasonCode: 'invalid_timestamp' }
  const timestamp = Number(input.timestamp)
  if (
    !Number.isSafeInteger(timestamp) ||
    Math.abs(input.nowSeconds - timestamp) > input.timestampSkewSeconds
  )
    return { ok: false, reasonCode: 'stale_timestamp' }
  if (!/^[A-Za-z0-9._~-]{8,128}$/.test(input.nonce))
    return { ok: false, reasonCode: 'invalid_nonce' }
  if (!/^sha256=[a-f0-9]{64}$/.test(input.signature))
    return { ok: false, reasonCode: 'invalid_signature' }
  const expected = signWebhookBody(
    input.secret,
    timestamp,
    input.nonce,
    input.body,
  )
  const valid = timingSafeEqual(
    Buffer.from(expected),
    Buffer.from(input.signature),
  )
  return valid
    ? { ok: true, reasonCode: 'ok' }
    : { ok: false, reasonCode: 'invalid_signature' }
}

export function decodeSignedWebhookPayload(raw: unknown): SignedWebhookMessage {
  const root = strictRecord(raw, 'signed webhook payload')
  rejectUnknown(root, ROOT_FIELDS, 'signed webhook payload')
  if (root.version !== 1)
    throw new Error('signed webhook payload version must be 1')
  const message = strictRecord(root.message, 'signed webhook message')
  rejectUnknown(message, MESSAGE_FIELDS, 'signed webhook message')
  const id = requiredBoundedText(message.id, 256, 'message.id')
  const senderId = boundedText(message.senderId, 256, 'message.senderId')
  const targetId = boundedText(message.targetId, 256, 'message.targetId')
  const content = boundedText(
    message.content,
    SIGNED_WEBHOOK_MAX_CONTENT_BYTES,
    'message.content',
    false,
  )
  return { id, senderId, targetId, content }
}

function constantTimeTextEqual(left: string, right: string): boolean {
  const leftDigest = createHmac('sha256', 'emperor-webhook-key-id')
    .update(left, 'utf8')
    .digest()
  const rightDigest = createHmac('sha256', 'emperor-webhook-key-id')
    .update(right, 'utf8')
    .digest()
  return timingSafeEqual(leftDigest, rightDigest)
}

function requiredBoundedText(
  value: unknown,
  maxBytes: number,
  label: string,
): string {
  const text = boundedText(value, maxBytes, label)
  if (!text) throw new Error(`${label} is required`)
  return text
}

function boundedText(
  value: unknown,
  maxBytes: number,
  label: string,
  trim = true,
): string {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') throw new Error(`${label} must be a string`)
  const text = trim ? value.trim() : value
  if (
    Buffer.byteLength(text, 'utf8') > maxBytes ||
    (label !== 'message.content' && containsControlCharacter(text))
  )
    throw new Error(`${label} exceeds its safe boundary`)
  return text
}

function containsControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    if (code < 32 || code === 127) return true
  }
  return false
}

function strictRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${label} must be an object`)
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null)
    throw new Error(`${label} must be a plain object`)
  return value as Record<string, unknown>
}

function rejectUnknown(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  const unknown = Object.keys(value)
    .filter((key) => !allowed.has(key))
    .sort()
  if (unknown.length)
    throw new Error(`${label} contains unknown field ${unknown[0]}`)
}

class RequestBodyError extends Error {
  constructor(
    readonly statusCode: number,
    readonly reasonCode: string,
  ) {
    super(reasonCode)
    this.name = 'RequestBodyError'
  }
}

function header(request: IncomingMessage, name: string): string {
  const value = request.headers[name]
  if (Array.isArray(value)) return String(value[0] ?? '').trim()
  return String(value ?? '').trim()
}

async function readRequestBody(
  request: IncomingMessage,
  maxBodyBytes: number,
): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  let tooLarge = false
  try {
    for await (const chunk of request) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += bytes.length
      if (size > maxBodyBytes) {
        tooLarge = true
        chunks.length = 0
      } else if (!tooLarge) chunks.push(bytes)
    }
  } catch {
    throw new RequestBodyError(400, 'body_read_error')
  }
  if (tooLarge) throw new RequestBodyError(413, 'body_too_large')
  return Buffer.concat(chunks, size)
}

function respondJson(
  response: ServerResponse,
  statusCode: number,
  payload: Record<string, unknown>,
): void {
  if (response.destroyed || response.writableEnded) return
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.byteLength,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  response.end(body)
}

function digestNullable(value: string | null): string | null {
  return value === null
    ? null
    : createHash('sha256').update(value, 'utf8').digest('hex')
}

function durationMs(startedAt: number, finishedAt: number): number {
  return Math.max(0, Math.round((finishedAt - startedAt) * 1_000))
}

function outboundError(reasonCode: string): string {
  switch (reasonCode) {
    case 'adapter_unavailable':
      return 'signed webhook adapter is unavailable'
    case 'outbound_not_configured':
      return 'signed webhook outbound is not configured'
    case 'invalid_outbound':
      return 'signed webhook outbound payload is invalid'
    case 'rate_limited':
      return 'signed webhook outbound is rate limited'
    case 'redirect_rejected':
      return 'signed webhook outbound redirect was rejected'
    case 'http_error':
      return 'signed webhook outbound returned an error status'
    case 'timeout':
      return 'signed webhook outbound timed out'
    case 'cancelled':
      return 'signed webhook outbound was cancelled'
    default:
      return 'signed webhook outbound network failed'
  }
}

function validOutbound(message: ExternalOutbound): boolean {
  const id = String(message.id ?? '')
  const target = String(message.target_id ?? '')
  return (
    /^[A-Za-z0-9._:-]{1,256}$/.test(id) &&
    target.length > 0 &&
    Buffer.byteLength(target, 'utf8') <= 256 &&
    !containsControlCharacter(target) &&
    message.media.length === 0 &&
    Buffer.byteLength(message.content, 'utf8') <=
      SIGNED_WEBHOOK_MAX_CONTENT_BYTES &&
    Number.isFinite(message.created_at)
  )
}
