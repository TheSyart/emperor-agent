import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ExternalAdapter } from './adapter'
import { ExternalAttachment, ExternalDeliveryResult, ExternalInbound, ExternalOutbound, seenKey } from './models'
import { ExternalBridgeService } from './service'
import { ExternalBridgeStore } from './store'

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

class FakeAdapter extends ExternalAdapter {
  override name = 'fake'
  override display_name = 'Fake'
  sent: ExternalOutbound[] = []
  result = new ExternalDeliveryResult({ ok: true, external_message_id: 'remote-1' })

  override async send(message: ExternalOutbound): Promise<ExternalDeliveryResult> {
    this.sent.push(message)
    return this.result
  }
}

describe('external models/store', () => {
  it('round-trips inbound/outbound models and dedupe keys', () => {
    const att = new ExternalAttachment({ name: 'a.txt', mime: 'text/plain', size: 3, path: 'memory/a.txt', metadata: { x: 1 } })
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
    expect(ExternalInbound.fromDict(inbound.toDict()).toDict()).toEqual(inbound.toDict())
    expect(new ExternalOutbound({ platform: 'slack', target_id: 'chan', content: 'reply' }).toDict().id).toMatch(/^ext_out_/)
  })

  it('persists state and preserves corrupt state files', () => {
    const root = tmp('emperor-external-store-')
    const store = new ExternalBridgeStore(root, { maxRecent: 2 })
    const msg = new ExternalInbound({ platform: 'x', sender_id: 'u', external_message_id: 'm', content: 'hi' })
    const out = new ExternalOutbound({ platform: 'x', target_id: 'u', content: 'ok' })
    store.save({
      seen: new Set([seenKey('x', 'm')]),
      inbox: [{ status: 'received' }, { status: 'queued' }, { status: 'old-trimmed' }],
      pending: [msg],
      outbox: new Map([[out.id, { status: 'sent', message: out.toDict() }]]),
      recentErrors: [{ error: 'one' }, { error: 'two' }, { error: 'trimmed' }],
    })

    const loaded = store.load()
    expect(loaded.seen.has('x\u0000m')).toBe(true)
    expect(loaded.pending[0]!.external_message_id).toBe('m')
    expect([...loaded.outbox.keys()]).toEqual([out.id])
    expect(loaded.inbox).toHaveLength(2)

    writeFileSync(store.stateFile, '{bad', 'utf8')
    expect(store.load().pending).toEqual([])
    expect(existsSync(store.stateFile)).toBe(false)
    expect(readdirSync(store.externalDir).some((name) => name.startsWith('state.json.corrupt-'))).toBe(true)
    const corruptBackups = store.diagnostics().corruptBackups
    expect(Array.isArray(corruptBackups) ? corruptBackups.length : 0).toBeGreaterThan(0)
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
      eventSink: async (event) => { events.push(event) },
      submitTurn: async (payload) => { turns.push(payload); return `turn-${turns.length}` },
    })
    const msg = new ExternalInbound({ platform: 'slack', sender_id: 'u1', external_message_id: 'm1', content: 'hello' })

    expect((await service.ingest(msg)).status).toBe('queued')
    expect((await service.ingest(msg)).status).toBe('duplicate')
    accepting = true
    const drained = await service.drainPending()
    expect(drained[0]!.turn_id).toBe('turn-1')
    expect(String(turns[0]!.content)).toContain('[EXTERNAL_MESSAGE]')
    expect(String(turns[0]!.display_content)).toContain('外部消息 · slack')
    expect(events.map((e) => e.event)).toEqual(['external_inbound', 'external_queued'])
  })

  it('sends outbound messages through registered adapters and records errors', async () => {
    const root = tmp('emperor-external-outbound-')
    const events: Array<Record<string, unknown>> = []
    const service = new ExternalBridgeService({
      root,
      canAcceptTurn: () => true,
      eventSink: async (event) => { events.push(event) },
      submitTurn: async () => 'turn',
    })
    const adapter = new FakeAdapter()
    service.registerAdapter(adapter)

    const sent = await service.sendOutbound(new ExternalOutbound({ platform: 'fake', target_id: 'u', content: 'hi' }))
    expect(sent.status).toBe('sent')
    expect(adapter.sent).toHaveLength(1)
    const missing = await service.sendOutbound(new ExternalOutbound({ platform: 'missing', target_id: 'u', content: 'hi' }))
    expect(missing.status).toBe('error')
    expect(service.payload().recentErrors).toHaveLength(1)
    expect(events.map((e) => e.event)).toEqual([
      'external_outbound_queued',
      'external_outbound_sent',
      'external_outbound_queued',
      'external_outbound_error',
    ])
    expect(JSON.parse(readFileSync(join(root, 'external', 'state.json'), 'utf8')).outbox).toHaveLength(2)
  })
})
