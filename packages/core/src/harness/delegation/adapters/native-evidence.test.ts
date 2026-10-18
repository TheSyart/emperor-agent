import { expect, it } from 'vitest'
import { normalizeClaudeMessage } from './claude'
import { normalizeCodexNotification } from './codex'
it('captures Claude runtime model and tool inventory without exposing private thinking', () => {
  expect(
    normalizeClaudeMessage({
      type: 'system',
      subtype: 'init',
      session_id: 's',
      model: 'real-model',
      tools: ['Read', 'WebSearch'],
    }),
  ).toContainEqual({
    type: 'runtime_metadata',
    source: 'initialization',
    model: 'real-model',
    advertisedTools: ['Read', 'WebSearch'],
  })
  expect(
    normalizeClaudeMessage({
      type: 'assistant',
      message: {
        model: 'provider-model',
        content: [{ type: 'thinking', thinking: 'private' }],
      },
    }),
  ).toEqual([
    {
      type: 'runtime_metadata',
      source: 'provider-response',
      model: 'provider-model',
    },
  ])
})
it('correlates Claude native search and fetch results by tool ID instead of assistant claims', () => {
  const calls = new Map()
  normalizeClaudeMessage(
    {
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 's',
            name: 'WebSearch',
            input: { query: 'docs' },
          },
          {
            type: 'tool_use',
            id: 'f',
            name: 'WebFetch',
            input: { url: 'https://example.com/docs', prompt: 'title' },
          },
        ],
      },
    },
    true,
    calls,
  )
  const events = [
    ...normalizeClaudeMessage(
      {
        type: 'user',
        tool_use_result: {
          query: 'docs',
          results: [
            {
              tool_use_id: 'native',
              content: [{ title: 'Docs', url: 'https://example.com/docs' }],
            },
          ],
          durationSeconds: 0.2,
        },
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 's',
              content: 'Search results',
            },
          ],
        },
      },
      true,
      calls,
    ),
    ...normalizeClaudeMessage(
      {
        type: 'user',
        tool_use_result: {
          code: 200,
          bytes: 100,
          result: 'Retrieved documentation',
          url: 'https://example.com/docs',
        },
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'f',
              content: 'Retrieved page',
            },
          ],
        },
      },
      true,
      calls,
    ),
  ]
  expect(events).toContainEqual(
    expect.objectContaining({
      id: 's',
      evidence: {
        kind: 'search',
        action: 'search',
        success: true,
        verified: true,
        references: ['https://example.com/docs'],
        searchMode: 'live',
      },
    }),
  )
  expect(events).toContainEqual(
    expect.objectContaining({
      id: 'f',
      evidence: {
        kind: 'search',
        action: 'fetch',
        success: true,
        verified: true,
        references: ['https://example.com/docs'],
        searchMode: 'live',
      },
    }),
  )
  expect(
    normalizeClaudeMessage(
      {
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'f',
              is_error: true,
              content: 'permission denied',
            },
          ],
        },
      },
      true,
      calls,
    ),
  ).toContainEqual(
    expect.objectContaining({
      evidence: expect.objectContaining({ success: false }),
    }),
  )
})
it('retains only public native Codex search/page and image artifact evidence', () => {
  expect(
    normalizeCodexNotification('item/completed', {
      item: {
        id: 'w',
        type: 'webSearch',
        results: [
          {
            url: 'https://example.com/docs',
            text: 'Actual retrieved documentation body',
            code: 200,
          },
        ],
        action: { type: 'openPage', url: 'https://example.com/docs' },
        status: 'completed',
      },
    }),
  ).toContainEqual(
    expect.objectContaining({
      evidence: {
        kind: 'search',
        action: 'fetch',
        success: true,
        verified: true,
        references: ['https://example.com/docs'],
        searchMode: 'live',
      },
    }),
  )
  expect(
    normalizeCodexNotification('item/completed', {
      item: {
        id: 'i',
        type: 'imageGeneration',
        status: 'completed',
        savedPath: '/work/output.png',
        result: 'huge-private-base64',
      },
    }),
  ).toEqual([
    {
      type: 'tool_finished',
      id: 'i',
      status: 'completed',
      evidence: {
        kind: 'image-generation',
        action: 'generate',
        success: true,
        artifactPath: '/work/output.png',
      },
    },
  ])
  expect(
    normalizeCodexNotification('model/rerouted', { toModel: 'fallback' }),
  ).toEqual([
    { type: 'runtime_metadata', source: 'model-rerouted', model: 'fallback' },
  ])
})
it('does not equate a Codex request/completion with affirmative native search output', () => {
  for (const action of [
    { type: 'search', query: 'docs' },
    { type: 'openPage', url: 'https://example.com/docs' },
  ]) {
    const events = normalizeCodexNotification('item/completed', {
      item: {
        id: 'w',
        type: 'webSearch',
        query: 'docs',
        action,
        results: null,
      },
    })
    expect(events).toContainEqual(
      expect.objectContaining({
        evidence: expect.objectContaining({ success: false, verified: false }),
      }),
    )
  }
})
it('uses Claude structured HTTP status and search hits rather than explanatory model-facing text', () => {
  const calls = new Map([
    ['f', { name: 'WebFetch', url: 'https://example.com/docs' }],
  ])
  const events = normalizeClaudeMessage(
    {
      type: 'user',
      tool_use_result: {
        code: 403,
        bytes: 0,
        result: 'Forbidden',
        url: 'https://example.com/docs',
      },
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'f',
            content:
              'The page could not be retrieved because the site denied access.',
          },
        ],
      },
    },
    true,
    calls,
  )
  expect(events).toContainEqual(
    expect.objectContaining({
      evidence: expect.objectContaining({ success: false, verified: true }),
    }),
  )
})
it('rejects opaque Codex failure text and does not certify an undocumented text-only result', () => {
  for (const result of [
    {
      status: 'failed',
      text: 'The page could not be fetched because access was denied.',
    },
    { text: 'Unknown opaque page content' },
  ]) {
    const events = normalizeCodexNotification('item/completed', {
      item: {
        id: 'w',
        type: 'webSearch',
        query: 'q',
        action: { type: 'openPage', url: 'https://example.com/docs' },
        results: [result],
      },
    })
    expect(events).toContainEqual(
      expect.objectContaining({
        evidence: expect.objectContaining({ success: false }),
      }),
    )
  }
})
