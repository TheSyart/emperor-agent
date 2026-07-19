import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ExternalAuditStore } from './audit'
import {
  DEFAULT_SIGNED_WEBHOOK_CONFIG,
  type SignedWebhookConfig,
} from './config'
import { ExternalOutbound } from './models'
import {
  decodeSignedWebhookPayload,
  SignedWebhookAdapter,
  signWebhookBody,
  verifyWebhookSignature,
} from './signed-webhook'

const SECRET = 's'.repeat(32)

function adapterConfig(
  overrides: Partial<SignedWebhookConfig> = {},
): SignedWebhookConfig {
  return {
    ...DEFAULT_SIGNED_WEBHOOK_CONFIG,
    mode: 'on',
    port: 0,
    sessionId: 'session_1',
    keyId: 'operator-key',
    secretEnv: 'EXTERNAL_SECRET',
    ...overrides,
  }
}

async function signedRequest(
  endpoint: string,
  raw: string,
  opts: {
    timestamp?: number
    nonce?: string
    signature?: string
    keyId?: string
  } = {},
): Promise<Response> {
  const timestamp = opts.timestamp ?? 1_700_000_000
  const nonce = opts.nonce ?? `nonce_${Math.random().toString(16).slice(2)}`
  const body = Buffer.from(raw)
  return await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-emperor-key-id': opts.keyId ?? 'operator-key',
      'x-emperor-timestamp': String(timestamp),
      'x-emperor-nonce': nonce,
      'x-emperor-signature':
        opts.signature ?? signWebhookBody(SECRET, timestamp, nonce, body),
    },
    body,
  })
}

describe('signed webhook protocol codec', () => {
  it('signs exact raw bytes and verifies them within the configured window', () => {
    const body = Buffer.from('{"version":1,"message":{"id":"m1"}}')
    const signature = signWebhookBody(SECRET, 1_700_000_000, 'nonce_123', body)

    expect(signature).toMatch(/^sha256=[a-f0-9]{64}$/)
    expect(
      verifyWebhookSignature({
        secret: SECRET,
        keyId: 'operator-key',
        expectedKeyId: 'operator-key',
        timestamp: '1700000000',
        nonce: 'nonce_123',
        signature,
        body,
        nowSeconds: 1_700_000_100,
        timestampSkewSeconds: 300,
      }),
    ).toEqual({ ok: true, reasonCode: 'ok' })
  })

  it.each([
    [{ keyId: 'wrong' }, 'unknown_key'],
    [{ timestamp: '1699999000' }, 'stale_timestamp'],
    [{ nonce: 'bad nonce' }, 'invalid_nonce'],
    [{ signature: `sha256=${'0'.repeat(64)}` }, 'invalid_signature'],
  ])(
    'rejects authentication variant %# without throwing',
    (override, reason) => {
      const body = Buffer.from('{}')
      const valid = signWebhookBody(SECRET, 1_700_000_000, 'nonce_123', body)
      expect(
        verifyWebhookSignature({
          secret: SECRET,
          keyId: 'operator-key',
          expectedKeyId: 'operator-key',
          timestamp: '1700000000',
          nonce: 'nonce_123',
          signature: valid,
          body,
          nowSeconds: 1_700_000_100,
          timestampSkewSeconds: 300,
          ...override,
        }),
      ).toEqual({ ok: false, reasonCode: reason })
    },
  )

  it('decodes only the exact bounded network message schema', () => {
    expect(
      decodeSignedWebhookPayload({
        version: 1,
        message: {
          id: 'provider-message-1',
          senderId: 'remote-user',
          targetId: 'remote-thread',
          content: 'hello',
        },
      }),
    ).toEqual({
      id: 'provider-message-1',
      senderId: 'remote-user',
      targetId: 'remote-thread',
      content: 'hello',
    })
  })

  it.each([
    [{ version: 1, sessionId: 'forged', message: {} }, /sessionId|unknown/i],
    [
      {
        version: 1,
        message: { id: 'm1', content: 'x', attachments: [{ path: '/tmp/x' }] },
      },
      /attachments|unknown/i,
    ],
    [
      {
        version: 1,
        message: { id: 'm1', content: 'x', metadata: { command: 'run' } },
      },
      /metadata|unknown/i,
    ],
    [{ version: 1, message: { id: '', content: 'x' } }, /message\.id/i],
    [
      { version: 1, message: { id: 'm1', content: 'x'.repeat(65_537) } },
      /content/i,
    ],
  ])('rejects untrusted payload variant %#', (raw, error) => {
    expect(() => decodeSignedWebhookPayload(raw)).toThrow(error)
  })

  it('accepts a real signed loopback request once and targets only the trusted session', async () => {
    const root = mkdtempSync(join(tmpdir(), 'emperor-signed-webhook-'))
    const received: Array<{
      message: Record<string, unknown>
      signal: AbortSignal
    }> = []
    const adapter = new SignedWebhookAdapter({
      config: adapterConfig(),
      secret: SECRET,
      clock: () => 1_700_000_000,
      auditStore: new ExternalAuditStore(root),
      ingest: async (message, context) => {
        received.push({ message: message.toDict(), signal: context.signal })
        return { status: 'dispatched' }
      },
    })

    await adapter.start()
    const endpoint = adapter.endpointUrl
    expect(endpoint).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/v1\/external\/events$/,
    )
    const body = JSON.stringify({
      version: 1,
      message: {
        id: 'provider-message-1',
        senderId: 'remote-user',
        targetId: 'remote-thread',
        content: 'hello from webhook',
      },
    })

    expect((await signedRequest(endpoint!, body)).status).toBe(202)
    await adapter.waitForIdle()
    expect(received).toHaveLength(1)
    expect(received[0]!.message).toMatchObject({
      platform: 'signed-webhook',
      sender_id: 'remote-user',
      target_id: 'remote-thread',
      external_message_id: 'provider-message-1',
      content: 'hello from webhook',
      metadata: { emperor_target_session_id: 'session_1' },
    })
    expect(received[0]!.signal.aborted).toBe(false)
    expect(adapter.status()).toMatchObject({
      state: 'ready',
      effectiveMode: 'on',
      accepted: 1,
    })
    await adapter.stop()
  })

  it('rejects auth, payload and method failures before ingest', async () => {
    const root = mkdtempSync(join(tmpdir(), 'emperor-signed-webhook-reject-'))
    let effects = 0
    const adapter = new SignedWebhookAdapter({
      config: adapterConfig(),
      secret: SECRET,
      clock: () => 1_700_000_000,
      auditStore: new ExternalAuditStore(root),
      ingest: async () => {
        effects += 1
        return { status: 'dispatched' }
      },
    })
    await adapter.start()
    const endpoint = adapter.endpointUrl!
    const validBody = JSON.stringify({
      version: 1,
      message: { id: 'm1', content: 'hello' },
    })

    expect(
      (
        await signedRequest(endpoint, validBody, {
          signature: `sha256=${'0'.repeat(64)}`,
        })
      ).status,
    ).toBe(401)
    expect(
      (
        await signedRequest(endpoint, validBody, {
          timestamp: 1_699_999_000,
        })
      ).status,
    ).toBe(401)
    const unknownBody = JSON.stringify({
      version: 1,
      message: { id: 'm2', content: 'hello', sessionId: 'forged' },
    })
    expect((await signedRequest(endpoint, unknownBody)).status).toBe(422)
    expect((await signedRequest(endpoint, '{malformed')).status).toBe(400)
    expect((await fetch(endpoint, { method: 'GET' })).status).toBe(405)
    expect(effects).toBe(0)
    const audit = await new ExternalAuditStore(root).replay({ limit: 20 })
    expect(audit.records.map((record) => record.reasonCode)).toEqual(
      expect.arrayContaining([
        'invalid_signature',
        'stale_timestamp',
        'invalid_payload',
        'invalid_json',
        'method_not_allowed',
      ]),
    )
    await adapter.stop()
  })

  it('enforces body and token-bucket bounds, then refills deterministically', async () => {
    const root = mkdtempSync(join(tmpdir(), 'emperor-signed-webhook-rate-'))
    let effects = 0
    let now = 1_700_000_000
    const adapter = new SignedWebhookAdapter({
      config: adapterConfig({
        requestsPerMinute: 1,
        burst: 1,
        maxBodyBytes: 1_024,
      }),
      secret: SECRET,
      clock: () => now,
      auditStore: new ExternalAuditStore(root),
      ingest: async () => {
        effects += 1
        return { status: 'dispatched' }
      },
    })
    await adapter.start()
    const endpoint = adapter.endpointUrl!
    const body = (id: string) =>
      JSON.stringify({ version: 1, message: { id, content: 'hello' } })

    expect((await signedRequest(endpoint, body('m1'))).status).toBe(202)
    expect((await signedRequest(endpoint, body('m2'))).status).toBe(429)
    await adapter.waitForIdle()
    expect(effects).toBe(1)
    now += 60
    expect((await signedRequest(endpoint, body('m3'))).status).toBe(202)
    await adapter.waitForIdle()
    expect(effects).toBe(2)

    await adapter.stop()
    const oversized = new SignedWebhookAdapter({
      config: adapterConfig({ maxBodyBytes: 1_024 }),
      secret: SECRET,
      clock: () => 1_700_000_000,
      auditStore: new ExternalAuditStore(root),
      ingest: async () => {
        effects += 1
        return { status: 'dispatched' }
      },
    })
    await oversized.start()
    expect(
      (
        await signedRequest(
          oversized.endpointUrl!,
          JSON.stringify({
            version: 1,
            message: { id: 'large', content: 'x'.repeat(2_000) },
          }),
        )
      ).status,
    ).toBe(413)
    expect(effects).toBe(2)
    await oversized.stop()
  })

  it('shares one anonymous bucket across arbitrary unknown key ids', async () => {
    const root = mkdtempSync(join(tmpdir(), 'emperor-signed-anonymous-rate-'))
    let effects = 0
    const adapter = new SignedWebhookAdapter({
      config: adapterConfig({ requestsPerMinute: 1, burst: 1 }),
      secret: SECRET,
      clock: () => 1_700_000_000,
      auditStore: new ExternalAuditStore(root),
      ingest: async () => {
        effects += 1
        return { status: 'dispatched' }
      },
    })
    await adapter.start()
    const body = JSON.stringify({
      version: 1,
      message: { id: 'unknown-key', content: 'hello' },
    })

    expect(
      (await signedRequest(adapter.endpointUrl!, body, { keyId: 'unknown-a' }))
        .status,
    ).toBe(401)
    expect(
      (await signedRequest(adapter.endpointUrl!, body, { keyId: 'unknown-b' }))
        .status,
    ).toBe(429)
    expect(effects).toBe(0)
    await adapter.stop()
  })

  it('audits a resolved bridge failure as an ingress dead-letter', async () => {
    const root = mkdtempSync(join(tmpdir(), 'emperor-signed-ingest-failed-'))
    const adapter = new SignedWebhookAdapter({
      config: adapterConfig(),
      secret: SECRET,
      clock: () => 1_700_000_000,
      auditStore: new ExternalAuditStore(root),
      ingest: async () => ({ status: 'dead-letter' }),
    })
    await adapter.start()
    const body = JSON.stringify({
      version: 1,
      message: { id: 'dead-ingest', content: 'hello' },
    })

    expect((await signedRequest(adapter.endpointUrl!, body)).status).toBe(202)
    await adapter.waitForIdle()
    const audit = await new ExternalAuditStore(root).replay({ limit: 20 })
    expect(audit.records).toContainEqual(
      expect.objectContaining({
        direction: 'ingress',
        outcome: 'dead-letter',
        reasonCode: 'ingest_dead_letter',
      }),
    )
    await adapter.stop()
  })

  it('returns 503 instead of 202 when durable admission rejects', async () => {
    const root = mkdtempSync(join(tmpdir(), 'emperor-signed-admission-fails-'))
    const adapter = new SignedWebhookAdapter({
      config: adapterConfig(),
      secret: SECRET,
      clock: () => 1_700_000_000,
      auditStore: new ExternalAuditStore(root),
      ingest: async () => {
        throw new Error('private persistence failure')
      },
    })
    await adapter.start()
    const body = JSON.stringify({
      version: 1,
      message: { id: 'not-admitted', content: 'hello' },
    })

    expect((await signedRequest(adapter.endpointUrl!, body)).status).toBe(503)
    const audit = await new ExternalAuditStore(root).replay({ limit: 20 })
    expect(audit.records).toContainEqual(
      expect.objectContaining({
        direction: 'ingress',
        outcome: 'rejected',
        reasonCode: 'ingest_unavailable',
      }),
    )
    expect(
      audit.records.some(
        (record) =>
          record.direction === 'ingress' && record.outcome === 'accepted',
      ),
    ).toBe(false)
    expect(JSON.stringify(audit.records)).not.toContain(
      'private persistence failure',
    )
    await adapter.stop()
  })

  it('keeps eval/auth-failed modes network inert', async () => {
    const root = mkdtempSync(join(tmpdir(), 'emperor-signed-webhook-inert-'))
    const auditStore = new ExternalAuditStore(root)
    const evalAdapter = new SignedWebhookAdapter({
      config: adapterConfig({ mode: 'eval' }),
      secret: SECRET,
      auditStore,
      ingest: async () => ({ status: 'dispatched' }),
    })
    await evalAdapter.start()
    expect(evalAdapter.endpointUrl).toBeNull()
    expect(evalAdapter.status()).toMatchObject({
      state: 'eval',
      effectiveMode: 'eval',
    })
    await evalAdapter.stop()

    const missingSecret = new SignedWebhookAdapter({
      config: adapterConfig(),
      secret: '',
      auditStore,
      ingest: async () => ({ status: 'dispatched' }),
    })
    await missingSecret.start()
    expect(missingSecret.endpointUrl).toBeNull()
    expect(missingSecret.status()).toMatchObject({
      state: 'auth_failed',
      effectiveMode: 'off',
      lastReason: 'credential_unavailable',
    })
    await missingSecret.stop()

    const missingSession = new SignedWebhookAdapter({
      config: adapterConfig(),
      secret: SECRET,
      auditStore,
      preflight: () => 'session_unavailable',
      ingest: async () => ({ status: 'dispatched' }),
    })
    await missingSession.start()
    expect(missingSession.endpointUrl).toBeNull()
    expect(missingSession.status()).toMatchObject({
      state: 'degraded',
      effectiveMode: 'off',
      lastReason: 'session_unavailable',
    })
    await missingSession.stop()
  })

  it('aborts and drains an accepted background ingest on stop', async () => {
    const root = mkdtempSync(join(tmpdir(), 'emperor-signed-webhook-stop-'))
    let observedSignal: AbortSignal | null = null
    let started!: () => void
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve
    })
    const adapter = new SignedWebhookAdapter({
      config: adapterConfig(),
      secret: SECRET,
      clock: () => 1_700_000_000,
      auditStore: new ExternalAuditStore(root),
      ingest: async (_message, context) => {
        observedSignal = context.signal
        context.onAdmitted?.()
        started()
        await new Promise<void>((resolve) => {
          context.signal.addEventListener('abort', () => resolve(), {
            once: true,
          })
        })
        return { status: 'cancelled' }
      },
    })
    await adapter.start()
    const body = JSON.stringify({
      version: 1,
      message: { id: 'stop-me', content: 'hello' },
    })
    expect((await signedRequest(adapter.endpointUrl!, body)).status).toBe(202)
    await startedPromise

    await adapter.stop()

    expect(observedSignal).not.toBeNull()
    expect(observedSignal!.aborted).toBe(true)
    expect(adapter.status()).toMatchObject({ state: 'stopped', active: 0 })
  })

  it('sends an exact signed HTTPS reply with a stable idempotency key', async () => {
    const root = mkdtempSync(join(tmpdir(), 'emperor-signed-outbound-'))
    let capturedUrl = ''
    let capturedInit: RequestInit | null = null
    const adapter = new SignedWebhookAdapter({
      config: adapterConfig({
        outboundUrl: 'https://connector.example/emperor/replies',
      }),
      secret: SECRET,
      clock: () => 1_700_000_000,
      auditStore: new ExternalAuditStore(root),
      ingest: async () => ({ status: 'dispatched' }),
      fetchImpl: async (input, init) => {
        capturedUrl = String(input)
        capturedInit = init ?? null
        return new Response(null, { status: 204 })
      },
    })
    await adapter.start()
    const outbound = new ExternalOutbound({
      id: 'delivery-1',
      platform: 'signed-webhook',
      target_id: 'remote-thread',
      content: 'agent reply',
      created_at: 1_700_000_000,
    })

    expect(await adapter.send(outbound)).toMatchObject({
      ok: true,
      external_message_id: 'delivery-1',
      metadata: { reasonCode: 'sent', statusCode: 204 },
    })
    expect(capturedUrl).toBe('https://connector.example/emperor/replies')
    expect(capturedInit).toMatchObject({ method: 'POST', redirect: 'manual' })
    const headers = new Headers(capturedInit!.headers)
    const body = Buffer.from(String(capturedInit!.body))
    expect(headers.get('idempotency-key')).toBe('delivery-1')
    expect(JSON.parse(body.toString('utf8'))).toEqual({
      version: 1,
      delivery: {
        id: 'delivery-1',
        targetId: 'remote-thread',
        content: 'agent reply',
        createdAt: 1_700_000_000,
      },
    })
    expect(
      verifyWebhookSignature({
        secret: SECRET,
        keyId: headers.get('x-emperor-key-id') ?? '',
        expectedKeyId: 'operator-key',
        timestamp: headers.get('x-emperor-timestamp') ?? '',
        nonce: headers.get('x-emperor-nonce') ?? '',
        signature: headers.get('x-emperor-signature') ?? '',
        body,
        nowSeconds: 1_700_000_000,
        timestampSkewSeconds: 300,
      }),
    ).toEqual({ ok: true, reasonCode: 'ok' })
    const audit = await new ExternalAuditStore(root).replay({ limit: 20 })
    expect(audit.records).toContainEqual(
      expect.objectContaining({
        direction: 'outbound',
        outcome: 'sent',
        reasonCode: 'sent',
        statusCode: 204,
      }),
    )
    await adapter.stop()
  })

  it.each([
    [302, 'redirect_rejected'],
    [400, 'http_error'],
    [503, 'http_error'],
  ])(
    'dead-letters outbound HTTP status %i without following redirects',
    async (statusCode, reasonCode) => {
      const root = mkdtempSync(join(tmpdir(), 'emperor-signed-http-error-'))
      let fetches = 0
      const adapter = new SignedWebhookAdapter({
        config: adapterConfig({
          outboundUrl: 'https://connector.example/reply',
        }),
        secret: SECRET,
        clock: () => 1_700_000_000,
        auditStore: new ExternalAuditStore(root),
        ingest: async () => ({ status: 'dispatched' }),
        fetchImpl: async (_input, init) => {
          fetches += 1
          expect(init?.redirect).toBe('manual')
          return new Response(null, { status: statusCode })
        },
      })
      await adapter.start()

      expect(
        await adapter.send(
          new ExternalOutbound({
            platform: 'signed-webhook',
            target_id: 'remote',
            content: 'reply',
          }),
        ),
      ).toMatchObject({
        ok: false,
        metadata: { reasonCode, statusCode },
      })
      expect(fetches).toBe(1)
      const audit = await new ExternalAuditStore(root).replay({ limit: 20 })
      expect(audit.records).toContainEqual(
        expect.objectContaining({
          direction: 'outbound',
          outcome: 'dead-letter',
          reasonCode,
          statusCode,
        }),
      )
      await adapter.stop()
    },
  )

  it('bounds outbound rate and classifies network and timeout failures', async () => {
    const root = mkdtempSync(join(tmpdir(), 'emperor-signed-outbound-bounds-'))
    let behavior: 'ok' | 'network' | 'timeout' = 'ok'
    let fetches = 0
    const adapter = new SignedWebhookAdapter({
      config: adapterConfig({
        outboundUrl: 'https://connector.example/reply',
        requestsPerMinute: 2,
        burst: 2,
        outboundTimeoutMs: 10,
      }),
      secret: SECRET,
      clock: () => 1_700_000_000,
      auditStore: new ExternalAuditStore(root),
      ingest: async () => ({ status: 'dispatched' }),
      fetchImpl: async (_input, init) => {
        fetches += 1
        if (behavior === 'network') throw new Error('raw transport secret')
        if (behavior === 'timeout')
          return await new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              'abort',
              () => reject(init.signal?.reason ?? new Error('aborted')),
              { once: true },
            )
          })
        return new Response(null, { status: 204 })
      },
    })
    await adapter.start()
    const send = () =>
      adapter.send(
        new ExternalOutbound({
          platform: 'signed-webhook',
          target_id: 'remote',
          content: 'reply',
        }),
      )

    behavior = 'network'
    expect(await send()).toMatchObject({
      ok: false,
      metadata: { reasonCode: 'network_error' },
    })
    behavior = 'timeout'
    expect(await send()).toMatchObject({
      ok: false,
      metadata: { reasonCode: 'timeout' },
    })
    behavior = 'ok'
    expect(await send()).toMatchObject({
      ok: false,
      metadata: { reasonCode: 'rate_limited' },
    })
    expect(fetches).toBe(2)
    const rawAudit = (await new ExternalAuditStore(root).replay({ limit: 20 }))
      .records
    expect(rawAudit.map((record) => record.reasonCode)).toEqual(
      expect.arrayContaining(['network_error', 'timeout', 'rate_limited']),
    )
    expect(JSON.stringify(rawAudit)).not.toContain('raw transport secret')
    await adapter.stop()
  })

  it('rejects outbound header injection and local media before transport', async () => {
    const root = mkdtempSync(join(tmpdir(), 'emperor-signed-outbound-schema-'))
    let fetches = 0
    const adapter = new SignedWebhookAdapter({
      config: adapterConfig({ outboundUrl: 'https://connector.example/reply' }),
      secret: SECRET,
      auditStore: new ExternalAuditStore(root),
      ingest: async () => ({ status: 'dispatched' }),
      fetchImpl: async () => {
        fetches += 1
        return new Response(null, { status: 204 })
      },
    })
    await adapter.start()

    expect(
      await adapter.send(
        new ExternalOutbound({
          id: 'bad\r\nid',
          platform: 'signed-webhook',
          target_id: 'remote',
          content: 'reply',
        }),
      ),
    ).toMatchObject({
      ok: false,
      metadata: { reasonCode: 'invalid_outbound' },
    })
    expect(
      await adapter.send(
        new ExternalOutbound({
          platform: 'signed-webhook',
          target_id: 'remote',
          content: 'reply',
          media: ['/private/file'],
        }),
      ),
    ).toMatchObject({
      ok: false,
      metadata: { reasonCode: 'invalid_outbound' },
    })
    expect(fetches).toBe(0)
    await adapter.stop()
  })
})
