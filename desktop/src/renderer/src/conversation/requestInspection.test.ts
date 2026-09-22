import { describe, expect, it } from 'vitest'
import { inspectRequests, requestForStep } from './requestInspection'
import { LogBuilder, loadKernelLog } from './testing/fixtures'

describe('request inspection', () => {
  const log = loadKernelLog()

  it('builds one request per step plus the compaction request', () => {
    const snapshot = inspectRequests(log.root.events)
    expect(
      snapshot.requests.map((request) =>
        request.purpose === 'assistant'
          ? `assistant ${request.turn}:${request.step} ${request.status}`
          : `compaction ${request.status}`,
      ),
    ).toEqual([
      'assistant 1:1 complete',
      'assistant 1:2 complete',
      'assistant 1:3 complete',
      'assistant 1:4 complete',
      'compaction complete',
    ])
    expect(snapshot.callSchemas.has('bash')).toBe(true)
    expect(snapshot.callSchemas.has('ask_user_question')).toBe(true)
  })

  it('records the header, retry, usage and timing of a step', () => {
    const snapshot = inspectRequests(log.root.events)
    const first = requestForStep(snapshot, 1, 1)
    expect(first?.promptChange?.kind).toBe('initial')
    expect(first?.prompt?.config).toMatchObject({
      provider: 'test-route',
      model: 'test-model',
    })
    expect(first?.prompt?.system).toContain('Emperor Agent')
    expect(first?.prompt?.tools.length).toBeGreaterThan(0)
    expect(first).toMatchObject({
      retry: 1,
      maxRetries: 2,
      usage: { inputTokens: 120, outputTokens: 40, cacheReadTokens: 30 },
      provenance: { provider: 'test-route', model: 'test-model' },
      route: {
        provider: 'test-route',
        model: 'test-model',
        contextWindow: 100_000,
      },
    })
    expect(first?.error).toBeUndefined()
    expect(first?.timing.ttftMs).toBeGreaterThan(0)
    expect(first?.timing.decodeMs).toBeGreaterThan(0)
    // Later steps inherit the header without a change record.
    const second = requestForStep(snapshot, 1, 2)
    expect(second?.prompt).toBe(first?.prompt)
    expect(second?.promptChange).toBeUndefined()
    const compaction = snapshot.requests.at(-1)
    expect(compaction).toMatchObject({
      purpose: 'compaction',
      turn: null,
      replacementSeq: 77,
      provenance: { provider: 'test-route', model: 'test-model' },
    })
  })

  it('classifies prompt changes and failed steps', () => {
    const builder = new LogBuilder()
    const header = (system: string, tools: string[]) =>
      builder.add('request/header', {
        reason: 'change',
        header: {
          config: { provider: 'p', model: 'm' },
          system,
          tools: tools.map((name) => ({
            name,
            description: '',
            parameters: {},
          })),
        },
      })
    builder.add('turn/start', { turn: 1 })
    builder.add('step/start', { turn: 1, step: 1 })
    header('sys', ['a'])
    builder.message(1, 1, [{ type: 'text', text: 'x' }])
    builder.add('step/end', { turn: 1, step: 1 })
    builder.add('step/start', { turn: 1, step: 2 })
    header('sys', ['a', 'b'])
    builder.message(1, 2, [{ type: 'text', text: 'y' }])
    builder.add('step/end', { turn: 1, step: 2 })
    builder.add('step/start', { turn: 1, step: 3 })
    header('sys2', ['a'])
    builder.add('turn/end', {
      turn: 1,
      reason: { kind: 'error', error: { message: 'dead', code: 'SERVER' } },
    })
    const snapshot = inspectRequests(builder.events)
    expect(requestForStep(snapshot, 1, 1)?.promptChange?.kind).toBe('initial')
    expect(requestForStep(snapshot, 1, 2)?.promptChange?.kind).toBe('tools')
    const third = requestForStep(snapshot, 1, 3)
    expect(third?.promptChange?.kind).toBe('system-and-tools')
    expect(third?.promptChange?.previous?.system).toBe('sys')
    expect(third).toMatchObject({ status: 'error', error: 'dead' })
  })
})
