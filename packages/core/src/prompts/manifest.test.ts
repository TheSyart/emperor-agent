import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { writePromptSnapshot } from './manifest'

describe('writePromptSnapshot', () => {
  it('preserves policy-aware ContextPlan item metadata while using redacted section hashes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'emperor-prompt-manifest-'))

    const snapshot = writePromptSnapshot({
      dir,
      sessionId: 'session_1',
      turnId: 'turn_1',
      model: 'fake',
      provider: 'test',
      modelRole: 'main',
      sections: [
        {
          name: 'project_agents',
          content: '# Project State\n\nsecret project fact',
          source: 'projects/project_1/AGENTS.local.md',
          priority: 85,
          budgetChars: 12000,
          version: null,
          scope: 'project',
        },
      ],
      contextPlan: {
        version: 1,
        mode: 'build',
        policyId: 'build',
        activeMemoryBinding: { longTerm: { kind: 'project', projectId: 'project_1' } },
        items: [
          {
            id: 'section:project_agents',
            kind: 'project_memory',
            source: 'projects/project_1/AGENTS.local.md',
            action: 'include',
            reason: 'build policy includes bound project memory',
            priority: 1,
            hash: 'stale',
            charCount: 1,
            tokenEstimate: 1,
          },
          {
            id: 'dynamic:session_history',
            kind: 'session_history',
            source: 'session/history.jsonl',
            action: 'include',
            reason: 'build policy includes active session transcript',
            priority: 0,
            hash: 'history-stale',
            charCount: 0,
            tokenEstimate: 0,
          },
        ],
        omitted: [],
      },
      messages: [
        { role: 'system', content: 'secret project system prompt' },
        { role: 'user', content: 'secret user request', seq: 7, turn_id: 'turn_0' },
        { role: 'assistant', content: 'secret assistant context', seq: 8, turn_id: 'turn_1' },
      ],
      checkpoint: {
        schemaVersion: 'emperor.turn-checkpoint.v1',
        phase: 'model_call',
        baseHistorySeq: 6,
        partialMessages: 2,
      },
      memoryVersions: [
        {
          target: 'project',
          relPath: 'projects/project_1/AGENTS.local.md',
          contentHash: 'abc123',
          version: 3,
        },
      ],
    })

    expect(snapshot.contextPlan).toMatchObject({
      policyId: 'build',
      items: [
        expect.objectContaining({
          id: 'section:project_agents',
          kind: 'project_memory',
          reason: 'build policy includes bound project memory',
          priority: 85,
          charCount: '# Project State\n\nsecret project fact'.length,
        }),
        expect.objectContaining({
          id: 'dynamic:session_history',
          kind: 'session_history',
          source: 'session/history.jsonl',
          reason: 'build policy includes active session transcript',
        }),
      ],
    })
    expect(snapshot.contextPlan.items[0]!.hash).toBe(snapshot.sections[0]!.hash)
    expect(snapshot.contextPlan.items[0]!.hash).not.toBe('stale')
    expect(snapshot.finalMessagesHash).toMatch(/^[a-f0-9]{64}$/)
    expect(snapshot.historyRange).toEqual({
      messageCount: 2,
      firstSeq: 7,
      lastSeq: 8,
      turnIds: ['turn_0', 'turn_1'],
    })
    expect(snapshot.checkpoint).toMatchObject({
      schemaVersion: 'emperor.turn-checkpoint.v1',
      phase: 'model_call',
      baseHistorySeq: 6,
      partialMessages: 2,
    })
    expect(snapshot.memoryVersions).toEqual([
      {
        target: 'project',
        relPath: 'projects/project_1/AGENTS.local.md',
        contentHash: 'abc123',
        version: 3,
      },
    ])
    const raw = readFileSync(join(dir, 'turn_1.json'), 'utf8')
    expect(raw).not.toContain('secret project fact')
    expect(raw).not.toContain('secret user request')
    expect(raw).not.toContain('secret assistant context')
  })
})
