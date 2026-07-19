import { describe, expect, it } from 'vitest'
import type { PromptSectionInput } from './manifest'
import { PromptProjectionTracker } from './projection'

function section(
  name: string,
  content: string,
  stability: 'stable' | 'dynamic',
  version: string | null = null,
): PromptSectionInput {
  return {
    name,
    content,
    source: `${name}.md`,
    priority: stability === 'stable' ? 100 : 50,
    budgetChars: null,
    version,
    stability,
  }
}

function observe(
  tracker: PromptProjectionTracker,
  opts: {
    turnId: string
    sections?: PromptSectionInput[]
    canonicalHistory?: Array<Record<string, unknown>>
    projectedMessages?: Array<Record<string, unknown>>
    report?: Record<string, unknown>
  },
) {
  return tracker.observe({
    sessionId: 'session_1',
    turnId: opts.turnId,
    sections: opts.sections ?? [
      section('bootstrap', 'stable system', 'stable', 'v1'),
      section('control', 'mode=auto', 'dynamic'),
    ],
    canonicalHistory: opts.canonicalHistory ?? [],
    projectedMessages: opts.projectedMessages ?? [],
    toolDefinitions: [{ name: 'read_file', input_schema: { type: 'object' } }],
    report: opts.report ?? {},
  })
}

describe('PromptProjectionTracker', () => {
  it('keeps a byte-stable prefix across appended turns and explains the suffix change', () => {
    const tracker = new PromptProjectionTracker()
    const first = observe(tracker, {
      turnId: 'turn_1',
      canonicalHistory: [{ role: 'user', content: 'one', turn_id: 'turn_1' }],
      projectedMessages: [
        { role: 'system', content: 'stable system\n\n---\n\nmode=auto' },
        { role: 'user', content: 'one', turn_id: 'turn_1' },
      ],
    })
    const second = observe(tracker, {
      turnId: 'turn_2',
      canonicalHistory: [
        { role: 'user', content: 'one', turn_id: 'turn_1' },
        { role: 'assistant', content: 'done', turn_id: 'turn_1' },
        { role: 'user', content: 'two', turn_id: 'turn_2' },
      ],
      projectedMessages: [
        { role: 'system', content: 'stable system\n\n---\n\nmode=auto' },
        { role: 'user', content: 'one', turn_id: 'turn_1' },
        { role: 'assistant', content: 'done', turn_id: 'turn_1' },
        { role: 'user', content: 'two', turn_id: 'turn_2' },
      ],
    })

    expect(second.stablePrefix.hash).toBe(first.stablePrefix.hash)
    expect(second.cacheBreak).toMatchObject({
      classification: 'expected',
      reasonCode: 'history_appended',
      firstChanged: { kind: 'message', index: 1 },
    })
  })

  it('keeps dynamic control changes out of the stable prefix', () => {
    const tracker = new PromptProjectionTracker()
    const first = observe(tracker, { turnId: 'turn_1' })
    const second = observe(tracker, {
      turnId: 'turn_2',
      sections: [
        section('bootstrap', 'stable system', 'stable', 'v1'),
        section('control', 'mode=plan', 'dynamic'),
      ],
    })

    expect(second.stablePrefix.hash).toBe(first.stablePrefix.hash)
    expect(second.cacheBreak).toMatchObject({
      classification: 'expected',
      reasonCode: 'dynamic_section_changed',
      firstChanged: { kind: 'section', id: 'section:control' },
    })
  })

  it('classifies an unversioned immutable section rewrite as unexpected and locates it', () => {
    const tracker = new PromptProjectionTracker()
    observe(tracker, {
      turnId: 'turn_1',
      sections: [section('bootstrap', 'stable one', 'stable')],
    })
    const changed = observe(tracker, {
      turnId: 'turn_2',
      sections: [section('bootstrap', 'stable two', 'stable')],
    })

    expect(changed.cacheBreak).toMatchObject({
      classification: 'unexpected',
      reasonCode: 'stable_section_changed_without_version',
      firstChanged: { kind: 'section', id: 'section:bootstrap', index: 0 },
    })
  })

  it('explains a fresh attachment without mutating or conflating canonical history', () => {
    const tracker = new PromptProjectionTracker()
    const canonical = [{ role: 'user', content: 'inspect image' }]
    const before = JSON.stringify(canonical)
    observe(tracker, {
      turnId: 'turn_1',
      canonicalHistory: canonical,
      projectedMessages: [
        { role: 'system', content: 'stable system\n\n---\n\nmode=auto' },
        { role: 'user', content: 'inspect image' },
      ],
    })
    const fresh = observe(tracker, {
      turnId: 'turn_2',
      canonicalHistory: canonical,
      projectedMessages: [
        { role: 'system', content: 'stable system\n\n---\n\nmode=auto' },
        { role: 'user', content: 'inspect image' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'fresh' },
            { type: 'image_url', image_url: { url: 'app://attachments/new' } },
          ],
        },
      ],
    })

    expect(JSON.stringify(canonical)).toBe(before)
    expect(fresh.cacheBreak).toMatchObject({
      classification: 'expected',
      reasonCode: 'fresh_attachment',
      firstChanged: { kind: 'message', index: 1 },
    })
    expect(fresh.canonicalHistoryHash).not.toBe(fresh.projectedMessagesHash)
  })

  it('explains projection-only microcompact instead of reporting an unknown rewrite', () => {
    const tracker = new PromptProjectionTracker()
    const canonical = [{ role: 'user', content: 'x'.repeat(200) }]
    observe(tracker, {
      turnId: 'turn_1',
      canonicalHistory: canonical,
      projectedMessages: [
        { role: 'system', content: 'stable system\n\n---\n\nmode=auto' },
        ...canonical,
      ],
    })
    const compacted = observe(tracker, {
      turnId: 'turn_2',
      canonicalHistory: canonical,
      projectedMessages: [
        { role: 'system', content: 'stable system\n\n---\n\nmode=auto' },
        { role: 'user', content: 'x…x' },
      ],
      report: { microcompacted_messages: 1 },
    })

    expect(compacted.cacheBreak).toMatchObject({
      classification: 'expected',
      reasonCode: 'microcompact_applied',
      firstChanged: { kind: 'message', index: 0 },
    })
  })

  it('keeps the canonical history hash fixed when tool results are pruned only in projection', () => {
    const tracker = new PromptProjectionTracker()
    const canonical = [
      { role: 'user', content: 'inspect' },
      {
        role: 'tool',
        tool_call_id: 'call_1',
        content: 'full private tool result',
      },
    ]
    const first = observe(tracker, {
      turnId: 'turn_1',
      canonicalHistory: canonical,
      projectedMessages: [
        { role: 'system', content: 'stable system\n\n---\n\nmode=auto' },
        ...canonical,
      ],
    })
    const pruned = observe(tracker, {
      turnId: 'turn_2',
      canonicalHistory: canonical,
      projectedMessages: [
        { role: 'system', content: 'stable system\n\n---\n\nmode=auto' },
        canonical[0]!,
        {
          role: 'tool',
          tool_call_id: 'call_1',
          content: '[tool result omitted from projection]',
        },
      ],
      report: { replaced_tool_results: 1 },
    })

    expect(pruned.canonicalHistoryHash).toBe(first.canonicalHistoryHash)
    expect(pruned.projectedMessagesHash).not.toBe(first.projectedMessagesHash)
    expect(pruned.cacheBreak).toMatchObject({
      classification: 'expected',
      reasonCode: 'tool_result_projection_changed',
      firstChanged: { kind: 'message', index: 1 },
    })
  })

  it('classifies regenerated attachment bytes as a fresh attachment', () => {
    const tracker = new PromptProjectionTracker()
    const canonical = [{ role: 'user', content: 'inspect attachment' }]
    observe(tracker, {
      turnId: 'turn_1',
      canonicalHistory: canonical,
      projectedMessages: [
        { role: 'system', content: 'stable system\n\n---\n\nmode=auto' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'inspect attachment' },
            {
              type: 'image_url',
              image_url: { url: 'data:image/png;base64,ONE' },
            },
          ],
        },
      ],
    })
    const regenerated = observe(tracker, {
      turnId: 'turn_2',
      canonicalHistory: canonical,
      projectedMessages: [
        { role: 'system', content: 'stable system\n\n---\n\nmode=auto' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'inspect attachment' },
            {
              type: 'image_url',
              image_url: { url: 'data:image/png;base64,TWO' },
            },
          ],
        },
      ],
    })

    expect(regenerated.cacheBreak).toMatchObject({
      classification: 'expected',
      reasonCode: 'fresh_attachment',
      firstChanged: { kind: 'message', index: 0 },
    })
  })
})
