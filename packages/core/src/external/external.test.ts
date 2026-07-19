import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ExternalAdapter } from './adapter'
import {
  ExternalAttachment,
  ExternalDeliveryResult,
  ExternalInbound,
  ExternalOutbound,
  seenKey,
} from './models'
import { ExternalBridgeService } from './service'
import { ExternalBridgeStore } from './store'

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

class FakeAdapter extends ExternalAdapter {
  override name = 'fake'
  override display_name = 'Fake'
  sent: ExternalOutbound[] = []
  result = new ExternalDeliveryResult({
    ok: true,
    external_message_id: 'remote-1',
  })

  override async send(
    message: ExternalOutbound,
  ): Promise<ExternalDeliveryResult> {
    this.sent.push(message)
    return this.result
  }
}

class FailingAdapter extends FakeAdapter {
  override result = new ExternalDeliveryResult({
    ok: false,
    error: 'remote unavailable',
    metadata: { reasonCode: 'http_error' },
  })
}

describe('external models/store', () => {
  it('round-trips inbound/outbound models and dedupe keys', () => {
    const att = new ExternalAttachment({
      name: 'a.txt',
      mime: 'text/plain',
      size: 3,
      path: 'memory/a.txt',
      metadata: { x: 1 },
    })
    const inbound = new ExternalInbound({
      platform: 'slack',
      sender_id: 'u1',
      target_id: 'chan',
      external_message_id: 'm1',
      content: 'hello',
      attachments: [att],
      metadata: { raw: true },
    })
    expect(inbound.dedupeKey).toEqual(['slack', 'm1'])
    expect(ExternalInbound.fromDict(inbound.toDict()).toDict()).toEqual(
      inbound.toDict(),
    )
    expect(
      new ExternalOutbound({
        platform: 'slack',
        target_id: 'chan',
        content: 'reply',
      }).toDict().id,
    ).toMatch(/^ext_out_/)
  })

  it('persists state and preserves corrupt state files', () => {
    const root = tmp('emperor-external-store-')
    const store = new ExternalBridgeStore(root, { maxRecent: 2 })
    const msg = new ExternalInbound({
      platform: 'x',
      sender_id: 'u',
      external_message_id: 'm',
      content: 'hi',
    })
    const out = new ExternalOutbound({
      platform: 'x',
      target_id: 'u',
      content: 'ok',
    })
    store.save({
      dedupeRevision: 1,
      dedupe: new Map([
        [
          seenKey('x', 'm'),
          {
            key: seenKey('x', 'm'),
            platform: 'x',
            external_message_id: 'm',
            status: 'dispatched',
            revision: 1,
            received_at: 10,
            updated_at: 11,
            expires_at: 111,
            lease_expires_at: null,
            attempts: 1,
            turn_id: 'turn-1',
            last_error: null,
          },
        ],
      ]),
      inbox: [
        { status: 'received' },
        { status: 'queued' },
        { status: 'old-trimmed' },
      ],
      pending: [msg],
      outbox: new Map([[out.id, { status: 'sent', message: out.toDict() }]]),
      recentErrors: [{ error: 'one' }, { error: 'two' }, { error: 'trimmed' }],
    })

    const loaded = store.load()
    expect(loaded.dedupe.get('x\u0000m')).toMatchObject({
      status: 'dispatched',
      revision: 1,
      turn_id: 'turn-1',
    })
    expect(loaded.dedupeRevision).toBe(1)
    expect(loaded.pending[0]!.external_message_id).toBe('m')
    expect([...loaded.outbox.keys()]).toEqual([out.id])
    expect(loaded.inbox).toHaveLength(2)
    const persisted = JSON.parse(readFileSync(store.stateFile, 'utf8'))
    expect(persisted).toMatchObject({ version: 2, dedupeRevision: 1 })
    expect(persisted.dedupe).toHaveLength(1)
    expect(persisted.seen).toBeUndefined()

    writeFileSync(store.stateFile, '{bad', 'utf8')
    expect(store.load().pending).toEqual([])
    expect(existsSync(store.stateFile)).toBe(false)
    expect(
      readdirSync(store.externalDir).some((name) =>
        name.startsWith('state.json.corrupt-'),
      ),
    ).toBe(true)
    const corruptBackups = store.diagnostics().corruptBackups
    expect(
      Array.isArray(corruptBackups) ? corruptBackups.length : 0,
    ).toBeGreaterThan(0)
  })

  it('migrates legacy seen pairs into terminal dedupe records', () => {
    const root = tmp('emperor-external-store-legacy-')
    const store = new ExternalBridgeStore(root)
    writeFileSync(
      store.stateFile,
      JSON.stringify({
        version: 1,
        updatedAt: 100,
        seen: [['slack', 'legacy-1']],
      }),
      'utf8',
    )

    const loaded = store.load()
    expect(loaded.dedupe.get(seenKey('slack', 'legacy-1'))).toMatchObject({
      status: 'dispatched',
      external_message_id: 'legacy-1',
    })
    expect(loaded.dedupeRevision).toBeGreaterThan(0)
  })
})

describe('ExternalBridgeService', () => {
  it('dedupes, queues when busy, drains pending, and emits runtime events', async () => {
    const root = tmp('emperor-external-service-')
    let accepting = false
    const turns: Array<Record<string, unknown>> = []
    const events: Array<Record<string, unknown>> = []
    const service = new ExternalBridgeService({
      root,
      canAcceptTurn: () => accepting,
      eventSink: async (event) => {
        events.push(event)
      },
      submitTurn: async (payload) => {
        turns.push(payload)
        return `turn-${turns.length}`
      },
    })
    const msg = new ExternalInbound({
      platform: 'slack',
      sender_id: 'u1',
      external_message_id: 'm1',
      content: 'hello',
    })

    expect((await service.ingest(msg)).status).toBe('queued')
    expect((await service.ingest(msg)).status).toBe('duplicate')
    accepting = true
    const drained = await service.drainPending()
    expect(drained[0]!.turn_id).toBe('turn-1')
    expect(String(turns[0]!.content)).toContain('[EXTERNAL_MESSAGE]')
    expect(String(turns[0]!.display_content)).toContain('外部消息 · slack')
    expect(events.map((e) => e.event)).toEqual([
      'external_inbound',
      'external_queued',
    ])
  })

  it('allows the same external id to recover after submit failure and only terminal-dedupes success', async () => {
    const root = tmp('emperor-external-retry-')
    let attempts = 0
    const makeService = () =>
      new ExternalBridgeService({
        root,
        canAcceptTurn: () => true,
        eventSink: async () => {},
        submitTurn: async () => {
          attempts += 1
          if (attempts === 1) throw new Error('injected submit failure')
          return 'turn-recovered'
        },
      })
    const message = new ExternalInbound({
      platform: 'slack',
      sender_id: 'u1',
      external_message_id: 'retry-1',
      content: 'retry me',
    })

    expect(await makeService().ingest(message)).toMatchObject({
      status: 'failed',
    })
    const restarted = makeService()
    expect(await restarted.ingest(message)).toMatchObject({
      status: 'dispatched',
      turn_id: 'turn-recovered',
    })
    expect(await restarted.ingest(message)).toMatchObject({
      status: 'duplicate',
      dedupe_status: 'dispatched',
    })
    expect(attempts).toBe(2)

    const restored = new ExternalBridgeStore(root).load()
    expect(restored.dedupe.get(seenKey('slack', 'retry-1'))).toMatchObject({
      status: 'dispatched',
      attempts: 2,
      turn_id: 'turn-recovered',
    })
  })

  it('keeps a failed queued event pending until a later drain succeeds', async () => {
    const root = tmp('emperor-external-pending-retry-')
    let accepting = false
    let attempts = 0
    const service = new ExternalBridgeService({
      root,
      canAcceptTurn: () => accepting,
      eventSink: async () => {},
      submitTurn: async () => {
        attempts += 1
        if (attempts === 1) throw new Error('drain failure')
        return 'turn-drained'
      },
    })
    const message = new ExternalInbound({
      platform: 'slack',
      sender_id: 'u1',
      external_message_id: 'pending-1',
      content: 'queue and retry',
    })

    expect(await service.ingest(message)).toMatchObject({ status: 'queued' })
    accepting = true
    expect(await service.drainPending()).toEqual([
      expect.objectContaining({ status: 'failed' }),
    ])
    expect((service.payload().inbox as { pending: number }).pending).toBe(1)
    expect(await service.drainPending()).toEqual([
      expect.objectContaining({
        status: 'dispatched',
        turn_id: 'turn-drained',
      }),
    ])
    expect((service.payload().inbox as { pending: number }).pending).toBe(0)
    expect(attempts).toBe(2)
  })

  it('holds a durable accepted lease across restart, then retries after lease expiry', async () => {
    const root = tmp('emperor-external-lease-restart-')
    let now = 100
    let firstSubmitStarted!: () => void
    const submitted = new Promise<void>((resolve) => {
      firstSubmitStarted = resolve
    })
    const message = new ExternalInbound({
      platform: 'slack',
      sender_id: 'u1',
      external_message_id: 'leased-1',
      content: 'lease me',
    })
    const crashed = new ExternalBridgeService({
      root,
      canAcceptTurn: () => true,
      eventSink: async () => {},
      clock: () => now,
      leaseSeconds: 30,
      submitTurn: async () => {
        firstSubmitStarted()
        return new Promise<string>(() => {})
      },
    })
    void crashed.ingest(message)
    await submitted

    let restartedCalls = 0
    const restarted = new ExternalBridgeService({
      root,
      canAcceptTurn: () => true,
      eventSink: async () => {},
      clock: () => now,
      leaseSeconds: 30,
      submitTurn: async () => {
        restartedCalls += 1
        return 'turn-after-lease'
      },
    })
    expect(await restarted.ingest(message)).toMatchObject({
      status: 'duplicate',
      dedupe_status: 'accepted',
      retry_after: 130,
    })
    expect(restartedCalls).toBe(0)

    now = 131
    expect(await restarted.ingest(message)).toMatchObject({
      status: 'dispatched',
      turn_id: 'turn-after-lease',
    })
    expect(restartedCalls).toBe(1)
  })

  it('moves exhausted failures to dead-letter and terminal-dedupes them', async () => {
    const root = tmp('emperor-external-dead-letter-')
    let attempts = 0
    const service = new ExternalBridgeService({
      root,
      canAcceptTurn: () => true,
      eventSink: async () => {},
      maxAttempts: 2,
      submitTurn: async () => {
        attempts += 1
        throw new Error(`failure-${attempts}`)
      },
    })
    const message = new ExternalInbound({
      platform: 'slack',
      sender_id: 'u1',
      external_message_id: 'dead-1',
      content: 'eventually dead letter',
    })

    expect(await service.ingest(message)).toMatchObject({ status: 'failed' })
    expect(await service.ingest(message)).toMatchObject({
      status: 'dead-letter',
    })
    expect(await service.ingest(message)).toMatchObject({
      status: 'duplicate',
      dedupe_status: 'dead-letter',
    })
    expect(attempts).toBe(2)
  })

  it('coalesces concurrent duplicate ingest so submit runs exactly once', async () => {
    const root = tmp('emperor-external-concurrent-')
    let release!: (turnId: string) => void
    let signalSubmitted!: () => void
    let submitCalls = 0
    const submitted = new Promise<void>((resolve) => {
      signalSubmitted = resolve
    })
    const service = new ExternalBridgeService({
      root,
      canAcceptTurn: () => true,
      eventSink: async () => {},
      submitTurn: async () => {
        submitCalls += 1
        signalSubmitted()
        return new Promise<string>((done) => {
          release = done
        })
      },
    })
    const message = new ExternalInbound({
      platform: 'slack',
      sender_id: 'u1',
      external_message_id: 'concurrent-1',
      content: 'once',
    })
    const first = service.ingest(message)
    const second = service.ingest(message)

    await submitted
    expect(submitCalls).toBe(1)
    release('turn-once')
    const results = await Promise.all([first, second])
    expect(results.map((result) => result.status).sort()).toEqual([
      'dispatched',
      'duplicate',
    ])
  })

  it('bounds dedupe by TTL/capacity without evicting an active lease', async () => {
    const root = tmp('emperor-external-dedupe-bounds-')
    let now = 100
    let releaseActive!: (turnId: string) => void
    let activeSubmitted!: () => void
    const activeStarted = new Promise<void>((resolve) => {
      activeSubmitted = resolve
    })
    const service = new ExternalBridgeService({
      root,
      canAcceptTurn: () => true,
      eventSink: async () => {},
      clock: () => now,
      dedupeTtlSeconds: 10,
      leaseSeconds: 30,
      maxDedupe: 1,
      submitTurn: async (payload) => {
        if (String(payload.client_message_id).endsWith(':active')) {
          activeSubmitted()
          return new Promise<string>((resolve) => {
            releaseActive = resolve
          })
        }
        return 'turn-fast'
      },
    })
    const makeMessage = (id: string) =>
      new ExternalInbound({
        platform: 'slack',
        sender_id: 'u1',
        external_message_id: id,
        content: id,
      })

    const active = service.ingest(makeMessage('active'))
    await activeStarted
    expect(await service.ingest(makeMessage('fast'))).toMatchObject({
      status: 'dispatched',
    })
    const duringLease = service.payload().inbox as Record<string, unknown>
    expect(duringLease.dedupe).toMatchObject({
      size: 1,
      max: 1,
      activeLeases: 1,
    })
    expect(
      [...new ExternalBridgeStore(root).load().dedupe.values()][0]
        ?.external_message_id,
    ).toBe('active')

    releaseActive('turn-active')
    await active
    now += 20
    expect(
      (service.payload().inbox as { dedupe: { size: number } }).dedupe.size,
    ).toBe(0)
    expect(await service.ingest(makeMessage('after-ttl'))).toMatchObject({
      status: 'dispatched',
    })
    const afterTtl = service.payload().inbox as Record<string, unknown>
    expect(afterTtl.dedupe).toMatchObject({ size: 1, max: 1 })
    expect(
      [...new ExternalBridgeStore(root).load().dedupe.values()][0]
        ?.external_message_id,
    ).toBe('after-ttl')
  })

  it('sends outbound messages through registered adapters and records errors', async () => {
    const root = tmp('emperor-external-outbound-')
    const events: Array<Record<string, unknown>> = []
    const service = new ExternalBridgeService({
      root,
      canAcceptTurn: () => true,
      eventSink: async (event) => {
        events.push(event)
      },
      submitTurn: async () => 'turn',
    })
    const adapter = new FakeAdapter()
    service.registerAdapter(adapter)

    const sent = await service.sendOutbound(
      new ExternalOutbound({ platform: 'fake', target_id: 'u', content: 'hi' }),
    )
    expect(sent.status).toBe('sent')
    expect(adapter.sent).toHaveLength(1)
    const missing = await service.sendOutbound(
      new ExternalOutbound({
        platform: 'missing',
        target_id: 'u',
        content: 'hi',
      }),
    )
    expect(missing.status).toBe('error')
    expect(service.payload().recentErrors).toHaveLength(1)
    expect(events.map((e) => e.event)).toEqual([
      'external_outbound_queued',
      'external_outbound_sent',
      'external_outbound_queued',
      'external_outbound_error',
    ])
    expect(
      JSON.parse(readFileSync(join(root, 'external', 'state.json'), 'utf8'))
        .outbox,
    ).toHaveLength(2)
  })

  it('passes shutdown signal into submit and delivers the completed reply only after dispatch', async () => {
    const root = tmp('emperor-external-auto-reply-')
    const controller = new AbortController()
    let submitSignal: AbortSignal | null = null
    const service = new ExternalBridgeService({
      root,
      canAcceptTurn: () => true,
      eventSink: async () => {},
      submitTurn: async (_payload, context) => {
        submitSignal = context?.signal ?? null
        return { turnId: 'turn-with-reply', content: 'agent reply' }
      },
    })
    const adapter = new FakeAdapter()
    service.registerAdapter(adapter)

    const result = await service.ingest(
      new ExternalInbound({
        platform: 'fake',
        sender_id: 'remote-user',
        target_id: 'remote-thread',
        external_message_id: 'reply-1',
        content: 'question',
      }),
      { signal: controller.signal },
    )

    expect(submitSignal).toBe(controller.signal)
    expect(result).toMatchObject({
      status: 'dispatched',
      turn_id: 'turn-with-reply',
      delivery: { status: 'sent' },
    })
    expect(adapter.sent).toHaveLength(1)
    expect(adapter.sent[0]!.toDict()).toMatchObject({
      platform: 'fake',
      target_id: 'remote-thread',
      content: 'agent reply',
      metadata: {
        inboundExternalMessageId: 'reply-1',
        inboundId: expect.stringMatching(/^ext_in_/),
      },
    })
  })

  it('keeps inbound dispatched and suppresses a second Agent effect after delivery dead-letter', async () => {
    const root = tmp('emperor-external-delivery-terminal-')
    let agentEffects = 0
    const service = new ExternalBridgeService({
      root,
      canAcceptTurn: () => true,
      eventSink: async () => {},
      submitTurn: async () => {
        agentEffects += 1
        return { turnId: 'turn-once', content: 'reply once' }
      },
    })
    const adapter = new FailingAdapter()
    service.registerAdapter(adapter)
    const inbound = new ExternalInbound({
      platform: 'fake',
      sender_id: 'remote-user',
      external_message_id: 'delivery-fails',
      content: 'question',
    })

    expect(await service.ingest(inbound)).toMatchObject({
      status: 'dispatched',
      delivery: { status: 'dead-letter' },
    })
    expect(await service.ingest(inbound)).toMatchObject({
      status: 'duplicate',
      dedupe_status: 'dispatched',
    })
    expect(agentEffects).toBe(1)
    expect(adapter.sent).toHaveLength(1)
    expect(
      new ExternalBridgeStore(root)
        .load()
        .dedupe.get(seenKey('fake', 'delivery-fails')),
    ).toMatchObject({ status: 'dispatched', turn_id: 'turn-once' })
  })

  it('projects diagnostics without sender, target, external id, content or raw errors', async () => {
    const root = tmp('emperor-external-public-redaction-')
    const service = new ExternalBridgeService({
      root,
      canAcceptTurn: () => false,
      eventSink: async () => {},
      submitTurn: async () => 'turn',
    })
    await service.ingest(
      new ExternalInbound({
        platform: 'signed-webhook',
        sender_id: 'SENSITIVE-SENDER-COORDINATE',
        target_id: 'SENSITIVE-TARGET-COORDINATE',
        external_message_id: 'SENSITIVE-PROVIDER-ID',
        content: 'SENSITIVE-MESSAGE-CONTENT',
      }),
    )

    const serialized = JSON.stringify(service.payload())
    expect(serialized).not.toContain('SENSITIVE-SENDER-COORDINATE')
    expect(serialized).not.toContain('SENSITIVE-TARGET-COORDINATE')
    expect(serialized).not.toContain('SENSITIVE-PROVIDER-ID')
    expect(serialized).not.toContain('SENSITIVE-MESSAGE-CONTENT')
    expect(serialized).toContain('message_id_digest')
    expect(serialized).toContain('content_bytes')
    expect(
      readFileSync(join(root, 'external', 'state.json'), 'utf8'),
    ).toContain('SENSITIVE-MESSAGE-CONTENT')
  })
})
