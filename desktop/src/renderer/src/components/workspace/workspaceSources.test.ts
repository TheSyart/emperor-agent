import { describe, expect, it } from 'vitest'
import { EMPTY_CHAT_SNAPSHOT } from '../../conversation/chatSnapshot'
import { LogBuilder, replay } from '../../conversation/testing/fixtures'
import { mcpServerOf, sourcesFromSnapshot } from './workspaceSources'

const TOOLS = [
  { name: 'read', source: 'builtin', server: '' },
  { name: 'mcp_config', source: 'builtin', server: '' },
  { name: 'mcp_my_docs_search', source: 'mcp', server: 'my_docs' },
]

function conversation(): LogBuilder {
  const log = new LogBuilder()
  log.add('host/user-meta', {
    messageId: 'u1',
    attachments: [{ id: 'att-1', name: 'report.md', kind: 'file' }],
  })
  log.user('u1', '看看这个报告')
  log.add('turn/start', { turn: 1 })
  log.add('step/start', { turn: 1, step: 1 })
  log.call(1, 1, 'c_web', 'web_search', { queries: ['vue'] })
  log.result(1, 1, 'c_web', 'results')
  log.call(1, 1, 'c_mcp', 'mcp_my_docs_search', { q: 'x' })
  log.result(1, 1, 'c_mcp', 'docs')
  log.call(1, 1, 'c_cfg', 'mcp_config', { action: 'list' })
  log.result(1, 1, 'c_cfg', 'config')
  log.call(1, 1, 'c_skill', 'skill', { name: 'visual-audit' })
  log.result(1, 1, 'c_skill', 'loaded')
  log.call(1, 1, 'c_fetch', 'web_fetch', { url: 'https://example.com' })
  log.result(1, 1, 'c_fetch', 'page')
  return log
}

function imageResult(log: LogBuilder, callId: string, attachmentId: string) {
  log.call(1, 1, callId, 'screenshot', {})
  log.add(
    'tool/result',
    {
      turn: 1,
      step: 1,
      message: {
        id: `result-${callId}`,
        role: 'user',
        source: { kind: 'tool', callId },
        content: [
          {
            type: 'tool-result',
            toolCallId: callId,
            content: [
              {
                type: 'image',
                attachment: { attachmentId, mimeType: 'image/png' },
              },
            ],
          },
        ],
      },
    },
    { surfaceOp: 'append' },
  )
}

describe('sourcesFromSnapshot', () => {
  it('is empty without a snapshot or sources', () => {
    expect(sourcesFromSnapshot(null)).toEqual([])
    expect(sourcesFromSnapshot(EMPTY_CHAT_SNAPSHOT)).toEqual([])
  })

  it('collects attachments, web, MCP servers and Skills, latest first', () => {
    const log = conversation()
    const { snapshot } = replay(log.events)
    const sources = sourcesFromSnapshot(snapshot, { tools: TOOLS })
    expect(
      sources.map((source) => [source.id, source.kind, source.count]),
    ).toEqual([
      ['web', 'web', 2],
      ['skill:visual-audit', 'skill', 1],
      ['mcp:my_docs', 'mcp', 1],
      ['attachment:att-1', 'attachment', 1],
    ])
    expect(sources.find((source) => source.kind === 'web')?.name).toBe(
      '网页搜索',
    )
    expect(sources.find((source) => source.kind === 'attachment')?.name).toBe(
      'report.md',
    )
  })

  it('counts tool-result images once each', () => {
    const log = new LogBuilder()
    log.user('u1', 'shot')
    log.add('turn/start', { turn: 1 })
    log.add('step/start', { turn: 1, step: 1 })
    imageResult(log, 'c_shot', 'img-1')
    imageResult(log, 'c_shot_again', 'img-1')
    const sources = sourcesFromSnapshot(replay(log.events).snapshot)
    expect(sources).toEqual([
      expect.objectContaining({ id: 'media:img-1', kind: 'media', count: 1 }),
    ])
  })
})

describe('mcpServerOf', () => {
  const tools = new Map(TOOLS.map((tool) => [tool.name, tool]))

  it('trusts the tool catalog, including servers with underscores', () => {
    expect(mcpServerOf('mcp_my_docs_search', undefined, tools)).toBe('my_docs')
    expect(mcpServerOf('mcp_config', undefined, tools)).toBeNull()
    expect(mcpServerOf('read', undefined, tools)).toBeNull()
  })

  it('falls back to the result meta, then to the tool name', () => {
    const empty = new Map()
    expect(mcpServerOf('mcp_config', undefined, empty)).toBeNull()
    expect(mcpServerOf('mcp_gh_issues', { server: 'github' }, empty)).toBe(
      'github',
    )
    expect(mcpServerOf('mcp_gh_issues', undefined, empty)).toBe('gh')
  })
})
