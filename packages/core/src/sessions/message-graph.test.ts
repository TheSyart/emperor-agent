import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  MessageGraphStore,
  projectLegacyHistoryToGraph,
  projectMessageGraphToLegacy,
} from './message-graph'

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

describe('MessageGraphStore v2', () => {
  it('projects a V1 fixture to a parent-linked graph and back without changing legacy rows', () => {
    const legacy = [
      { seq: 1, role: 'user', content: 'first', turn_id: 'turn_1' },
      { seq: 2, role: 'assistant', content: 'answer', turn_id: 'turn_1' },
      { seq: 3, type: 'compact_event', archived: true },
      { seq: 4, role: 'user', content: 'second', turn_id: 'turn_2' },
    ]

    const graph = projectLegacyHistoryToGraph(legacy, {
      sessionId: 'session_fixture',
    })

    expect(graph.nodes).toHaveLength(3)
    expect(graph.nodes.map((node) => node.parentId)).toEqual([
      null,
      graph.nodes[0]!.id,
      graph.nodes[1]!.id,
    ])
    expect(graph.leafId).toBe(graph.nodes[2]!.id)
    expect(graph.compactBoundaries).toEqual([
      expect.objectContaining({
        compactedUntilHistorySeq: 3,
        parentLeafId: graph.nodes[1]!.id,
      }),
    ])
    expect(projectMessageGraphToLegacy(graph)).toEqual([
      legacy[0],
      legacy[1],
      legacy[3],
    ])
    expect(legacy[0]).not.toHaveProperty('message_id')
  })

  it('recovers either branch from an explicitly selected leaf', () => {
    const store = new MessageGraphStore(tmp('emperor-message-branch-'))
    const root = store.appendCommitted({
      role: 'user',
      content: 'root',
      turnId: 'turn_root',
      historySeq: 1,
    })
    const first = store.appendCommitted({
      role: 'assistant',
      content: 'branch A',
      turnId: 'turn_a',
      historySeq: 2,
    })

    store.selectLeaf(root.id)
    const second = store.appendCommitted({
      role: 'assistant',
      content: 'branch B',
      turnId: 'turn_b',
      historySeq: 3,
    })

    expect(store.project(first.id).map((row) => row.content)).toEqual([
      'root',
      'branch A',
    ])
    expect(store.project(second.id).map((row) => row.content)).toEqual([
      'root',
      'branch B',
    ])
    expect(store.snapshot().leafId).toBe(second.id)
  })

  it('commits a partial whose V1 row landed before a crash and tombstones a true orphan', () => {
    const root = tmp('emperor-message-orphan-')
    const store = new MessageGraphStore(root)
    const landed = store.beginMessage({
      role: 'user',
      content: 'landed',
      turnId: 'turn_landed',
    })
    const orphan = store.beginMessage({
      role: 'assistant',
      content: 'partial stream',
      turnId: 'turn_orphan',
    })

    const reopened = new MessageGraphStore(root, {
      legacyRows: [
        {
          seq: 7,
          role: 'user',
          content: 'landed',
          turn_id: 'turn_landed',
          message_id: landed.id,
        },
      ],
    })
    const byId = Object.fromEntries(
      reopened.snapshot().nodes.map((node) => [node.id, node]),
    )

    expect(byId[landed.id]).toMatchObject({
      status: 'committed',
      historySeq: 7,
    })
    expect(byId[orphan.id]).toMatchObject({
      status: 'tombstoned',
      tombstoneReason: 'orphan_partial',
    })
    expect(reopened.project().map((row) => row.content)).toEqual(['landed'])
  })

  it('backtracks to the exact leaf captured by a compact boundary', () => {
    const store = new MessageGraphStore(tmp('emperor-message-compact-'))
    store.appendCommitted({
      role: 'user',
      content: 'before',
      turnId: 'turn_before',
      historySeq: 1,
    })
    const boundary = store.recordCompactBoundary({
      compactedUntilHistorySeq: 1,
      compactionId: 'compact_1',
    })
    store.appendCommitted({
      role: 'assistant',
      content: 'after',
      turnId: 'turn_after',
      historySeq: 2,
    })

    expect(store.backtrackToCompactBoundary(boundary.id)).toBe(
      boundary.parentLeafId,
    )
    expect(store.project().map((row) => row.content)).toEqual(['before'])
  })

  it('isolates malformed sidecar lines and never copies their raw content into diagnostics', () => {
    const root = tmp('emperor-message-corrupt-')
    const path = join(root, 'message_graph.v2.jsonl')
    writeFileSync(path, '{"secret":"do-not-leak"\n', 'utf8')

    const store = new MessageGraphStore(root)

    expect(store.snapshot().diagnostics).toEqual([
      expect.objectContaining({ code: 'invalid_json', line: 1 }),
    ])
    expect(JSON.stringify(store.snapshot().diagnostics)).not.toContain(
      'do-not-leak',
    )
    expect(readFileSync(path, 'utf8')).toContain('do-not-leak')
  })

  it('replays durable prompt queue transitions after reopening the session', () => {
    const root = tmp('emperor-prompt-replay-')
    const store = new MessageGraphStore(root)
    store.recordPrompt({
      id: 'prompt_1',
      turnId: 'turn_prompt_1',
      clientMessageId: 'client_1',
      delivery: 'interject',
      targetCommandId: 'turn:owner_1',
    })
    store.transitionPrompt('prompt_1', 'interjected')

    const reopened = new MessageGraphStore(root)

    expect(reopened.snapshot().prompts).toEqual([
      expect.objectContaining({
        id: 'prompt_1',
        turnId: 'turn_prompt_1',
        clientMessageId: 'client_1',
        delivery: 'interject',
        targetCommandId: 'turn:owner_1',
        state: 'interjected',
      }),
    ])
    expect(reopened.transitionPrompt('prompt_1', 'completed')).toMatchObject({
      state: 'completed',
    })
  })

  it('rejects an illegal transition out of a terminal prompt state', () => {
    const store = new MessageGraphStore(tmp('emperor-prompt-terminal-'))
    store.recordPrompt({
      id: 'prompt_terminal',
      turnId: 'turn_terminal',
      delivery: 'queue',
    })
    store.transitionPrompt('prompt_terminal', 'cancelled', 'owner_cancelled')

    expect(() => store.transitionPrompt('prompt_terminal', 'running')).toThrow(
      'illegal prompt transition: cancelled -> running',
    )
    expect(store.snapshot().prompts[0]).toMatchObject({
      state: 'cancelled',
      reason: 'owner_cancelled',
    })
  })
})
