// Ported from dsh ui-trajectory tests/snapshot-builder.client.spec.ts.
import { describe, expect, it } from 'vitest'
import type {
  TrajectoryAssistantRequest,
  TrajectoryCompactionRequest,
  TrajectoryContribution,
  TrajectoryConversationViewNode,
  TrajectoryLocation,
} from './contract'
import { TrajectorySnapshotBuilder } from './snapshotBuilder'

const TIMING = { ttftMs: null, decodeMs: null }

function assistantRequest(
  startSeq: number,
  step: number,
): TrajectoryAssistantRequest {
  return {
    purpose: 'assistant',
    startSeq,
    turn: 1,
    step,
    startedAt: startSeq,
    completedAt: startSeq + 1,
    status: 'complete',
    timing: TIMING,
  }
}

function compactionRequest(startSeq: number): TrajectoryCompactionRequest {
  return {
    purpose: 'compaction',
    compactionId: `c${startSeq}`,
    startSeq,
    turn: null,
    step: 0,
    startedAt: startSeq,
    completedAt: null,
    status: 'running',
    timing: TIMING,
  }
}

function contribution(
  key: string,
  anchorSeq: number,
  data: TrajectoryContribution,
  location: TrajectoryLocation = { kind: 'session' },
): TrajectoryConversationViewNode {
  return {
    key,
    kind: key,
    id: key,
    target: 'trajectory',
    anchorSeq,
    visibility: 'visible',
    location,
    data,
  }
}

const stepLocation = (turn: number, step: number): TrajectoryLocation => ({
  kind: 'step',
  turn,
  step,
})

describe('TrajectorySnapshotBuilder', () => {
  it('inherits one request header across requests without repeating its prompt change', () => {
    const prompt = {
      config: { provider: 'test', model: 'test' },
      system: 'one initial prompt',
      tools: [],
    }
    const nodes = [
      contribution('header', 2, {
        kind: 'request-header',
        header: {
          seq: 2,
          time: 2,
          prompt,
          change: { seq: 2, time: 2, kind: 'initial' },
          location: { kind: 'session' },
        },
      }),
      ...[assistantRequest(3, 1), assistantRequest(5, 2)].map((request) =>
        contribution(`assistant:${request.step}`, request.startSeq, {
          kind: 'assistant',
          partial: null,
          request,
        }),
      ),
    ]

    const snapshot = new TrajectorySnapshotBuilder().replace({ nodes })

    expect(
      snapshot.requests.map((request) =>
        request.purpose === 'assistant' ? request.prompt?.system : undefined,
      ),
    ).toEqual(['one initial prompt', 'one initial prompt'])
    expect(
      snapshot.requests.map((request) =>
        request.purpose === 'assistant'
          ? request.promptChange?.kind
          : undefined,
      ),
    ).toEqual(['initial', undefined])
  })

  it('indexes exact step headers and the active tool schema', () => {
    const basePrompt = {
      config: { provider: 'test', model: 'base' },
      system: 'base prompt',
      tools: [
        { name: 'read', description: 'Read', parameters: { type: 'object' } },
      ],
    }
    const exactPrompt = {
      config: { provider: 'test', model: 'exact' },
      system: 'exact prompt',
      tools: [
        { name: 'edit', description: 'Edit', parameters: { type: 'object' } },
      ],
    }
    const nodes = [
      contribution('header:base', 2, {
        kind: 'request-header',
        header: {
          seq: 2,
          time: 2,
          prompt: basePrompt,
          change: { seq: 2, time: 2, kind: 'initial' },
          location: { kind: 'session' },
        },
      }),
      contribution('assistant:1', 3, {
        kind: 'assistant',
        partial: null,
        request: assistantRequest(3, 1),
      }),
      contribution('assistant:2', 5, {
        kind: 'assistant',
        partial: null,
        request: assistantRequest(5, 2),
      }),
      contribution('header:exact', 6, {
        kind: 'request-header',
        header: {
          seq: 6,
          time: 6,
          prompt: exactPrompt,
          change: { seq: 6, time: 6, kind: 'system', previous: basePrompt },
          location: stepLocation(1, 2),
        },
      }),
      contribution('tool', 7, {
        kind: 'tool',
        root: {
          callId: 'call-edit',
          name: 'edit',
          argsRaw: '{}',
          turn: 1,
          step: 2,
          time: 7,
          subCalls: [],
        },
      }),
    ]

    const snapshot = new TrajectorySnapshotBuilder().replace({ nodes })

    expect(
      snapshot.requests.map((request) =>
        request.purpose === 'assistant' ? request.prompt?.system : undefined,
      ),
    ).toEqual(['base prompt', 'exact prompt'])
    expect(snapshot.callSchemas.get('call-edit')).toEqual(exactPrompt.tools[0])
    expect(snapshot.runningCalls.map((call) => call.callId)).toEqual([
      'call-edit',
    ])
  })

  it('attaches the request route of its step', () => {
    const snapshot = new TrajectorySnapshotBuilder().replace({
      nodes: [
        contribution('assistant:1', 1, {
          kind: 'assistant',
          partial: null,
          request: assistantRequest(1, 1),
        }),
        contribution(
          'route',
          2,
          {
            kind: 'request-context',
            seq: 2,
            context: { provider: 'p', model: 'm', contextWindow: 1000 },
            location: stepLocation(1, 1),
          },
          stepLocation(1, 1),
        ),
      ],
    })
    expect(snapshot.requests[0]).toMatchObject({
      route: { provider: 'p', model: 'm', contextWindow: 1000 },
    })
  })

  it('applies session boundaries and turn errors with linear request indexes', () => {
    const nodes = [
      ...[assistantRequest(1, 1), assistantRequest(3, 2)].map((request) =>
        contribution(`assistant:${request.step}`, request.startSeq, {
          kind: 'assistant',
          partial: null,
          request,
        }),
      ),
      contribution('turn-end', 5, {
        kind: 'turn-end',
        turn: 1,
        time: 5,
        error: 'turn failed',
      }),
      contribution('compact:10', 10, {
        kind: 'compaction',
        request: compactionRequest(10),
      }),
      contribution('compact:12', 12, {
        kind: 'compaction',
        request: compactionRequest(12),
      }),
      contribution('session-end:14', 14, {
        kind: 'session-end',
        seq: 14,
        time: 14,
      }),
      contribution('session-end:16', 16, {
        kind: 'session-end',
        seq: 16,
        time: 16,
      }),
    ]

    const snapshot = new TrajectorySnapshotBuilder().replace({ nodes })

    expect(snapshot.requests).toMatchObject([
      { purpose: 'assistant', step: 1, status: 'complete' },
      { purpose: 'assistant', step: 2, status: 'error', error: 'turn failed' },
      { purpose: 'compaction', startSeq: 10, status: 'error', completedAt: 16 },
      { purpose: 'compaction', startSeq: 12, status: 'error', completedAt: 14 },
    ])
  })

  it('keeps cached contribution order across content updates and structural inserts', () => {
    const builder = new TrajectorySnapshotBuilder()
    const first = contribution('assistant:1', 1, {
      kind: 'assistant',
      partial: null,
      request: assistantRequest(1, 1),
    })
    const last = contribution('assistant:3', 5, {
      kind: 'assistant',
      partial: null,
      request: assistantRequest(5, 3),
    })
    expect(
      builder
        .replace({ nodes: [last, first] })
        .requests.map((request) => request.startSeq),
    ).toEqual([1, 5])

    const updatedLast = contribution('assistant:3', 5, {
      kind: 'assistant',
      partial: null,
      request: { ...assistantRequest(5, 3), status: 'error', error: 'failed' },
    })
    expect(
      builder
        .apply({ upserts: [updatedLast] })
        .requests.map((request) => request.startSeq),
    ).toEqual([1, 5])

    const middle = contribution('assistant:2', 3, {
      kind: 'assistant',
      partial: null,
      request: assistantRequest(3, 2),
    })
    expect(
      builder
        .apply({ upserts: [middle] })
        .requests.map((request) => request.startSeq),
    ).toEqual([1, 3, 5])
  })

  it('honours removals and keeps the snapshot identity on empty flushes', () => {
    const builder = new TrajectorySnapshotBuilder()
    const first = contribution('assistant:1', 1, {
      kind: 'assistant',
      partial: null,
      request: assistantRequest(1, 1),
    })
    const second = contribution('assistant:2', 3, {
      kind: 'assistant',
      partial: null,
      request: assistantRequest(3, 2),
    })
    const initial = builder.replace({ nodes: [first, second] })
    expect(builder.apply({ upserts: [], removals: [] })).toBe(initial)
    expect(
      builder
        .apply({ upserts: [], removals: ['assistant:1'] })
        .requests.map((request) => request.startSeq),
    ).toEqual([3])
  })
})
