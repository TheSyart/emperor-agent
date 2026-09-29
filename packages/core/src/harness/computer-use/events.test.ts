import { createHash } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SessionLogStore } from '../../session-log/store'
import { computerUseRepair, redactAction } from './events'

function store(): SessionLogStore {
  return new SessionLogStore({
    root: mkdtempSync(join(tmpdir(), 'cu-events-')),
    writeBatchMaxDelayMs: 5,
    repairContributors: [computerUseRepair],
  })
}

const scope = {
  kind: 'browser' as const,
  profileId: 'task-temporary',
  origins: ['https://example.com'],
}

describe('redactAction', () => {
  it('keeps only length and hash of typed text', () => {
    const text = '收件人：张三 <a@example.com>'
    const sha = createHash('sha256').update(text, 'utf8').digest('hex')
    expect(redactAction({ kind: 'fill', ref: 'r1.2', text })).toEqual({
      kind: 'fill',
      ref: 'r1.2',
      textLength: text.length,
      textSha256: sha,
    })
    expect(redactAction({ kind: 'typeText', text })).toEqual({
      kind: 'typeText',
      textLength: text.length,
      textSha256: sha,
    })
    expect(
      JSON.stringify(redactAction({ kind: 'fill', ref: 'r1.2', text })),
    ).not.toContain('张三')
    expect(redactAction({ kind: 'appendText', ref: 'r1.2', text })).toEqual({
      kind: 'appendText',
      ref: 'r1.2',
      textLength: text.length,
      textSha256: sha,
    })
  })

  it('passes other actions through unchanged', () => {
    const click = { kind: 'click' as const, ref: 'r3.1', count: 2 as const }
    expect(redactAction(click)).toBe(click)
    const nav = { kind: 'navigate' as const, url: 'https://example.com/a' }
    expect(redactAction(nav)).toBe(nav)
  })
})

describe('computer use crash repair', () => {
  it('closes each open fact on reopen and never replays', () => {
    const s = store()
    const session = s.create({ id: 'cu1' })
    session.append('ui/target-opened', {
      targetId: 't-open',
      kind: 'embedded-tab',
      driver: 'embedded-browser',
      generation: 1,
      origin: 'https://example.com',
    })
    session.append('ui/target-opened', {
      targetId: 't-done',
      kind: 'embedded-tab',
      driver: 'embedded-browser',
      generation: 1,
    })
    session.append('ui/target-closed', { targetId: 't-done', reason: 'agent' })
    const prepared = (operationId: string): void => {
      session.append('ui/action-prepared', {
        operationId,
        callId: `call-${operationId}`,
        targetId: 't-open',
        action: { kind: 'click', ref: 'r1.1' },
        expectedRevision: 1,
      })
    }
    prepared('op-prepared')
    prepared('op-dispatched')
    session.append('ui/action-dispatched', { operationId: 'op-dispatched' })
    prepared('op-settled')
    session.append('ui/action-dispatched', { operationId: 'op-settled' })
    session.append('ui/action-settled', {
      operationId: 'op-settled',
      outcome: 'observed',
      afterRevision: 2,
    })
    session.append('ui/grant-requested', {
      requestId: 'g-open',
      subject: 'session:cu1',
      driver: 'embedded-browser',
      targetScope: scope,
      actions: ['observe', 'interact'],
      allowedScopes: ['once', 'task', 'session', 'timed'],
    })
    session.append('ui/grant-requested', {
      requestId: 'g-done',
      subject: 'session:cu1',
      driver: 'embedded-browser',
      targetScope: scope,
      actions: ['observe'],
      allowedScopes: ['once'],
    })
    session.append('ui/grant-decided', {
      requestId: 'g-done',
      decision: 'once',
      grantId: 'grant-1',
      cause: 'user',
    })
    const before = session.events.length
    s.close('cu1')

    const reopened = s.open('cu1')
    const repaired = reopened.events.slice(before).map((event) => ({
      type: event.type,
      data: event.data,
    }))
    expect(repaired).toEqual([
      {
        type: 'ui/action-settled',
        data: {
          operationId: 'op-prepared',
          outcome: 'cancelled',
          errorCode: 'INTERRUPTED',
        },
      },
      {
        type: 'ui/action-settled',
        data: {
          operationId: 'op-dispatched',
          outcome: 'unknown',
          errorCode: 'OUTCOME_UNKNOWN',
        },
      },
      {
        type: 'ui/grant-decided',
        data: { requestId: 'g-open', decision: 'denied', cause: 'repair' },
      },
      {
        type: 'ui/target-closed',
        data: { targetId: 't-open', reason: 'shutdown' },
      },
    ])

    // A second reopen finds a balanced log: repair is idempotent.
    s.close('cu1')
    const again = s.open('cu1')
    expect(again.events).toHaveLength(reopened.events.length)
  })

  it('leaves a balanced log alone', () => {
    expect(computerUseRepair([])).toEqual([])
  })
})
