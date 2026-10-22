import { afterEach, describe, expect, it, vi } from 'vitest'
import { EMPTY_CHAT_SNAPSHOT } from '../../../conversation/chatSnapshot'
import type {
  ChatNode,
  ChatSnapshot,
  ToolChatData,
} from '../../../conversation/types'
import { resourcesFromSnapshot, toolResources } from './resourceIndex'
import * as resourceModel from './resourceModel'

afterEach(() => vi.restoreAllMocks())

function snapshot(...nodes: ChatNode[]): ChatSnapshot {
  return {
    ...EMPTY_CHAT_SNAPSHOT,
    order: nodes.map((node) => node.key),
    nodes: new Map(nodes.map((node) => [node.key, node])),
  }
}
function node(kind: string, id: string, data: unknown): ChatNode {
  return {
    key: `${kind}:${id}`,
    kind,
    id,
    target: 'chat',
    anchorSeq: 1,
    visibility: 'visible',
    turn: 1,
    step: 1,
    data,
  } as ChatNode
}
function tool(
  id: string,
  name: string,
  meta: unknown = {},
  text = '',
  isError = false,
): ChatNode {
  return node('tool', id, {
    callId: id,
    name,
    argsRaw: '{}',
    turn: 1,
    step: 1,
    time: 0,
    status: 'settled',
    approvals: [],
    result: {
      seq: 2,
      time: 1,
      content: [{ type: 'text', text }],
      isError,
      meta,
    },
  })
}
function toolData(value: ChatNode): ToolChatData {
  return (value as Extract<ChatNode, { kind: 'tool' }>).data
}
function user(
  id: string,
  text: string,
  attachments: unknown[] = [],
  references: unknown[] = [],
): ChatNode {
  return node('user', id, {
    messageId: id,
    seq: 1,
    time: 0,
    text,
    content: [{ type: 'text', text }],
    attachments,
    references,
    steering: false,
  })
}
function assistant(id: string, text: string): ChatNode {
  return node('assistant', id, {
    messageId: id,
    status: 'settled',
    turn: 1,
    step: 1,
    time: 1,
    blocks: [{ kind: 'text', text }],
  })
}

describe('resourcesFromSnapshot', () => {
  it('parses unchanged completed history once while skipping streaming assistant text', () => {
    const parse = vi.spyOn(resourceModel, 'markdownResources')
    const provided = user('u1', 'https://provided.test/')
    const finished = assistant('a1', '[History](https://finished.test/)')
    resourcesFromSnapshot(snapshot(provided, finished))
    expect(parse).toHaveBeenCalledTimes(2)
    for (const text of [
      'https://streaming.test/',
      'https://streaming.test/path',
      '[Stream](https://streaming.test/path)',
    ]) {
      const current = assistant('live', text)
      const data = (current as Extract<ChatNode, { kind: 'assistant' }>).data
      const result = resourcesFromSnapshot(
        snapshot(provided, finished, {
          ...current,
          data: { ...data, status: 'running' },
        } as ChatNode),
      )
      expect(result.sources.map((resource) => resource.href)).toEqual([
        'https://finished.test/',
        'https://provided.test/',
      ])
    }
    expect(parse).toHaveBeenCalledTimes(2)
    const settled = resourcesFromSnapshot(
      snapshot(
        provided,
        finished,
        assistant('live', '[Stream](https://streaming.test/path)'),
      ),
    )
    expect(settled.sources[0]).toMatchObject({
      href: 'https://streaming.test/path',
      sourceMessageId: 'live',
    })
    expect(parse).toHaveBeenCalledTimes(3)
  })

  it('refreshes a cached user data object when text or message identity changes', () => {
    const parse = vi.spyOn(resourceModel, 'markdownResources')
    const value = user('u1', 'https://before.test/')
    const state = snapshot(value)
    resourcesFromSnapshot(state)
    resourcesFromSnapshot(state)
    expect(parse).toHaveBeenCalledTimes(1)
    const data = value.data as { text: string; messageId: string }
    data.text = 'https://after.test/'
    expect(resourcesFromSnapshot(state).sources[0]?.href).toBe(
      'https://after.test/',
    )
    data.messageId = 'u2'
    expect(resourcesFromSnapshot(state).sources[0]?.sourceMessageId).toBe('u2')
    expect(parse).toHaveBeenCalledTimes(3)
  })

  it('caches completed assistant blocks across data replacements with text and source guards', () => {
    const parse = vi.spyOn(resourceModel, 'markdownResources')
    const block = { kind: 'text' as const, text: 'https://before.test/' }
    const data = {
      messageId: 'a1',
      status: 'settled',
      turn: 1,
      step: 1,
      time: 1,
      blocks: [block],
    }
    resourcesFromSnapshot(snapshot(node('assistant', 'a1', data)))
    resourcesFromSnapshot(
      snapshot(node('assistant', 'a1', { ...data, time: 2 })),
    )
    expect(parse).toHaveBeenCalledTimes(1)
    block.text = 'https://after.test/'
    expect(
      resourcesFromSnapshot(snapshot(node('assistant', 'a1', data))).sources[0]
        ?.href,
    ).toBe('https://after.test/')
    expect(
      resourcesFromSnapshot(
        snapshot(node('assistant', 'a2', { ...data, messageId: 'a2' })),
      ).sources[0]?.sourceMessageId,
    ).toBe('a2')
    expect(parse).toHaveBeenCalledTimes(3)
  })

  it('keeps resources and usage counts local to each snapshot with repeated message ids', () => {
    const parse = vi.spyOn(resourceModel, 'markdownResources')
    const first = snapshot(user('u1', 'https://first-session.test/'))
    const second = snapshot(user('u1', 'https://second-session.test/'))
    resourcesFromSnapshot(first)
    expect(
      resourcesFromSnapshot(second).sources.map((resource) => resource.href),
    ).toEqual(['https://second-session.test/'])
    const restored = resourcesFromSnapshot(first)
    expect(restored.sources.map((resource) => resource.href)).toEqual([
      'https://first-session.test/',
    ])
    expect(restored.sources[0]?.uses).toHaveLength(1)
    expect(parse).toHaveBeenCalledTimes(2)
  })

  it('tracks directly injected skill and plugin instructions as used capabilities', () => {
    const state = snapshot(
      node('context', 'ctx1', {
        origin: 'message',
        seq: 1,
        time: 0,
        messageId: 'context-message-1',
        producer: 'skill-invocation',
        summary: 'skill:visual-audit',
        text: 'instructions',
        content: [],
      }),
      node('context', 'ctx2', {
        origin: 'message',
        seq: 2,
        time: 0,
        messageId: 'context-message-2',
        producer: 'plugin-invocation',
        summary: 'plugin:github',
        text: 'instructions',
        content: [],
      }),
    )
    expect(
      resourcesFromSnapshot(state).sources.map((item) => [
        item.kind,
        item.id,
        item.provenance,
        item.sourceMessageId,
      ]),
    ).toEqual([
      ['plugin', 'plugin:github', 'used', 'context-message-2'],
      ['skill', 'skill:visual-audit', 'used', 'context-message-1'],
    ])
  })

  it('collects a provided content image even when host attachment descriptors are absent', () => {
    const state = snapshot(
      node('user', 'u1', {
        messageId: 'u1',
        seq: 1,
        time: 0,
        text: 'look',
        content: [
          {
            type: 'image',
            attachment: {
              attachmentId: 'image-1',
              mediaType: 'image/png',
              bytes: 42,
            },
          },
        ],
        attachments: [],
        steering: false,
      }),
    )
    expect(resourcesFromSnapshot(state).sources).toEqual([
      expect.objectContaining({
        attachmentId: 'image-1',
        kind: 'image',
        role: 'source',
        provenance: 'provided',
      }),
    ])
  })
  it('merges normalized URLs while retaining every search, provided and citation use', () => {
    const state = snapshot(
      user('u1', 'Read https://EXAMPLE.com:443/docs#intro'),
      tool('s1', 'web_search', {
        sources: [{ url: 'https://example.com/docs', title: 'Docs' }],
      }),
      tool('s2', 'web_search', {
        sources: [{ url: 'https://example.com/docs#api' }],
      }),
      assistant(
        'a1',
        '[Docs](https://example.com/docs) and [again](https://example.com/docs#example)',
      ),
    )
    const { sources, outputs } = resourcesFromSnapshot(state)
    expect(outputs).toEqual([])
    expect(sources).toHaveLength(1)
    expect(sources[0]).toMatchObject({
      id: 'web:https://example.com/docs',
      provenance: 'cited',
      sourceMessageId: 'a1',
    })
    expect(sources[0]?.uses).toEqual([
      { nodeKey: 'user:u1', sourceMessageId: 'u1', provenance: 'provided' },
      { nodeKey: 'tool:s1', sourceMessageId: 's1', provenance: 'discovered' },
      { nodeKey: 'tool:s2', sourceMessageId: 's2', provenance: 'discovered' },
      { nodeKey: 'assistant:a1', sourceMessageId: 'a1', provenance: 'cited' },
      { nodeKey: 'assistant:a1', sourceMessageId: 'a1', provenance: 'cited' },
    ])
  })

  it('uses only loaded visible nodes and sorts resources by their latest use', () => {
    const state = snapshot(
      user('u1', 'https://one.test/ https://two.test/'),
      assistant('a1', 'https://one.test/'),
    )
    ;(state.nodes as Map<string, ChatNode>).set(
      'outside',
      user('u0', 'https://outside.test/'),
    )
    expect(
      resourcesFromSnapshot(state).sources.map((item) => item.href),
    ).toEqual(['https://one.test/', 'https://two.test/'])
    expect(resourcesFromSnapshot(null)).toEqual({ sources: [], outputs: [] })
  })

  it('separates created files from read references and excludes edits, failures and raw log paths', () => {
    const result = resourcesFromSnapshot(
      snapshot(
        tool('create', 'write', {
          operation: 'create',
          path: '/work/report.md',
        }),
        assistant('a1', '[report](/work/report.md:12)'),
        tool('edit', 'write', { operation: 'update', path: '/work/edited.md' }),
        tool(
          'failed',
          'write',
          { operation: 'create', path: '/work/failed.md' },
          '',
          true,
        ),
        tool(
          'unknown',
          'custom_tool',
          {},
          'Created /work/guessed.pdf https://guessed.test/',
        ),
      ),
    )
    expect(result.outputs.map((item) => [item.id, item.provenance])).toEqual([
      ['file:/work/report.md', 'created'],
    ])
    expect(result.sources.map((item) => [item.id, item.provenance])).toEqual([
      ['file:/work/report.md', 'cited'],
    ])
  })

  it('adds only recorded added files and leaves modified or reverted files to turn files', () => {
    const result = resourcesFromSnapshot(
      snapshot(
        node('turnFiles', 't1', {
          turn: 1,
          mode: 'git',
          status: 'recorded',
          files: [
            { path: 'LICENSE', status: 'added', additions: 1, deletions: 0 },
            {
              path: 'edited.md',
              status: 'modified',
              additions: 1,
              deletions: 0,
            },
            { path: 'undone.md', status: 'added', additions: 1, deletions: 0 },
          ],
          totals: { files: 3, additions: 3, deletions: 0 },
          truncated: false,
          concurrent: false,
          reviewable: true,
          reverted: { reverted: ['undone.md'], skipped: [] },
        }),
      ),
    )
    expect(result.outputs.map((item) => item.href)).toEqual(['LICENSE'])
  })

  it('keeps attachments and invoked capabilities as their own types', () => {
    const result = resourcesFromSnapshot(
      snapshot(
        user(
          'u1',
          'reference',
          [
            {
              id: 'doc-1',
              name: 'brief.pdf',
              mime: 'application/pdf',
              size: 42,
            },
          ],
          [{ kind: 'plugin', id: 'github', label: 'GitHub', start: 0, end: 6 }],
        ),
        tool('skill', 'skill', { name: 'visual-audit' }),
        tool('mcp', 'mcp_my_docs_search', {
          server: 'my_docs',
          tool: 'search',
        }),
        tool('plugin', 'mcp_github_issue_read', {}, ''),
      ),
      {
        tools: [
          {
            name: 'mcp_github_issue_read',
            source: 'mcp',
            server: 'github',
            plugin_id: 'github',
          },
        ],
      },
    )
    expect(
      result.sources.map((item) => [item.kind, item.id, item.provenance]),
    ).toEqual([
      ['plugin', 'plugin:github', 'used'],
      ['mcp', 'mcp:github', 'used'],
      ['mcp', 'mcp:my_docs', 'used'],
      ['skill', 'skill:visual-audit', 'used'],
      ['attachment', 'attachment:doc-1', 'provided'],
    ])
    expect(
      result.sources.find((item) => item.attachmentId === 'doc-1'),
    ).toMatchObject({ label: 'brief.pdf', mime: 'application/pdf', bytes: 42 })
    expect(
      result.sources.find((item) => item.id === 'plugin:github')?.uses,
    ).toHaveLength(2)
  })

  it('marks all screenshot and UI images as observations even if metadata claims output', () => {
    const capture = tool('shot', 'ui_screenshot', {
      displayResources: [
        {
          kind: 'image',
          role: 'output',
          attachmentId: 'shot-1',
          name: 'screen.png',
        },
      ],
    })
    const data = toolData(capture)
    const state = snapshot({
      ...capture,
      data: {
        ...data,
        result: {
          ...data.result!,
          content: [
            {
              type: 'image',
              attachment: {
                attachmentId: 'shot-1',
                mediaType: 'image/png',
                bytes: 42,
              },
            },
          ],
        },
      },
    } as ChatNode)
    const result = resourcesFromSnapshot(state)
    expect(result.outputs).toEqual([])
    expect(result.sources).toHaveLength(1)
    expect(result.sources[0]).toMatchObject({
      attachmentId: 'shot-1',
      role: 'observation',
      provenance: 'observed',
    })
  })

  it('uses the actual image block to reject an observation disguised as an output attachment', () => {
    const value = toolData(
      tool('capture', 'desktop_snapshot', {
        displayResources: [
          {
            kind: 'attachment',
            role: 'output',
            attachmentId: 'capture-1',
            name: 'result',
          },
        ],
      }),
    )
    const data = {
      ...value,
      result: {
        ...value.result!,
        content: [
          {
            type: 'image' as const,
            attachment: {
              attachmentId: 'capture-1',
              mediaType: 'image/png',
              bytes: 42,
            },
          },
        ],
      },
    }
    expect(toolResources(data)).toEqual([
      expect.objectContaining({
        kind: 'image',
        role: 'observation',
        provenance: 'observed',
        attachmentId: 'capture-1',
      }),
    ])
  })

  it.each([false, true])(
    'indexes the original screenshot audit once when vision is %s',
    (vision) => {
      const base = tool(
        'audit',
        'desktop_screenshot',
        {
          computerUse: {
            v: 1,
            tool: 'desktop_screenshot',
            outcome: 'observed',
            targetId: 'window-1',
            screenshot: {
              attachmentId: 'original-png',
              width: 2880,
              height: 1800,
            },
          },
        },
        JSON.stringify({
          status: 'ok',
          tool: 'desktop_screenshot',
          targetId: 'window-1',
          screenshotId: 'shot-1',
          width: 2880,
          height: 1800,
          sentToModel: vision,
        }),
      )
      const data = toolData(base)
      const state = snapshot({
        ...base,
        data: {
          ...data,
          result: {
            ...data.result!,
            content: [
              ...data.result!.content,
              ...(vision
                ? [
                    {
                      type: 'image' as const,
                      attachment: {
                        attachmentId: 'scaled-jpeg',
                        mediaType: 'image/jpeg',
                        bytes: 1000,
                      },
                    },
                  ]
                : []),
            ],
          },
        },
      } as ChatNode)
      const result = resourcesFromSnapshot(state)
      expect(result.outputs).toEqual([])
      expect(result.sources).toEqual([
        expect.objectContaining({
          attachmentId: 'original-png',
          kind: 'image',
          role: 'observation',
          provenance: 'observed',
          mime: 'image/png',
        }),
      ])
      expect(result.sources[0]?.uses).toEqual([
        {
          nodeKey: 'tool:audit',
          sourceMessageId: 'audit',
          provenance: 'observed',
        },
      ])
    },
  )

  it('overrides spoofed screenshot output records for the original and model image copies', () => {
    const value = toolData(
      tool('audit', 'browser_screenshot', {
        computerUse: {
          v: 1,
          tool: 'browser_screenshot',
          outcome: 'observed',
          screenshot: {
            attachmentId: 'original-png',
            width: 1920,
            height: 1080,
          },
        },
        displayResources: [
          {
            kind: 'attachment',
            role: 'output',
            attachmentId: 'original-png',
            name: 'Claimed artifact',
          },
          {
            kind: 'image',
            role: 'output',
            attachmentId: 'scaled-jpeg',
            name: 'Claimed model artifact',
          },
        ],
      }),
    )
    const data = {
      ...value,
      result: {
        ...value.result!,
        content: [
          {
            type: 'image' as const,
            attachment: {
              attachmentId: 'scaled-jpeg',
              mediaType: 'image/jpeg',
              bytes: 1000,
            },
          },
        ],
      },
    }
    expect(toolResources(data)).toEqual([
      expect.objectContaining({
        attachmentId: 'original-png',
        kind: 'image',
        role: 'observation',
        provenance: 'observed',
      }),
    ])
  })

  it('validates explicit resource records and bounds untrusted metadata', () => {
    const valid = {
      kind: 'file',
      role: 'output',
      href: '/work/export.pdf',
      title: 'Export',
    }
    const data = toolData(
      tool('export', 'custom_export', {
        displayResources: [
          valid,
          { kind: 'web', role: 'output', href: 'javascript:alert(1)' },
          {
            kind: 'web',
            role: 'output',
            href: 'https://user:secret@example.com',
          },
          { kind: 'imaginary', role: 'output', href: '/work/fake.md' },
          { kind: 'file', role: 'wrong', href: '/work/wrong.md' },
          { kind: 'file', role: 'output', href: '/work/' + 'a'.repeat(9000) },
        ],
      }),
    )
    expect(toolResources(data).map((item) => [item.href, item.role])).toEqual([
      ['/work/export.pdf', 'output'],
    ])
    expect(
      toolResources(
        toolData(
          tool(
            'failed',
            'custom_export',
            { displayResources: [valid] },
            '',
            true,
          ),
        ),
      ),
    ).toEqual([])
    const many = toolResources(
      toolData(
        tool('many', 'custom_export', {
          displayResources: Array.from({ length: 1000 }, (_, i) => ({
            ...valid,
            href: `/work/${i}.pdf`,
          })),
        }),
      ),
    )
    expect(many.length).toBeLessThanOrEqual(64)
  })

  it('rejects encoded control characters and outputs from incomplete calls', () => {
    const data = toolData(
      tool('unsafe', 'export', {
        displayResources: [
          { kind: 'file', role: 'output', href: '/work/%00bad.pdf' },
          { kind: 'web', role: 'output', href: 'https://example.com/%0A' },
        ],
      }),
    )
    expect(toolResources(data)).toEqual([])
    const incomplete = toolData(
      tool('unfinished', 'export', {
        displayResources: [
          { kind: 'file', role: 'output', href: '/work/unfinished.pdf' },
        ],
      }),
    )
    expect(toolResources({ ...incomplete, status: 'interrupted' })).toEqual([])
  })

  it('keeps explicitly created browser downloads while treating browser images as observations', () => {
    const result = resourcesFromSnapshot(
      snapshot(
        tool('download', 'browser_download', {
          displayResources: [
            { kind: 'file', role: 'output', href: '/work/report.pdf' },
            { kind: 'file', role: 'output', href: '/work/screen.png' },
          ],
        }),
      ),
    )
    expect(result.outputs.map((item) => item.href)).toEqual([
      '/work/report.pdf',
    ])
    expect(result.sources.map((item) => [item.href, item.role])).toEqual([
      ['/work/screen.png', 'observation'],
    ])
  })

  it('deduplicates file URLs and linked line locations without changing their open target', () => {
    const result = resourcesFromSnapshot(
      snapshot(
        tool('file', 'read_document', {
          displayResources: [
            {
              kind: 'file',
              role: 'source',
              href: 'file:///work/src/../report.md',
            },
          ],
        }),
        assistant('a1', '[line](/work/report.md:12)'),
      ),
    )
    expect(result.sources).toHaveLength(1)
    expect(result.sources[0]).toMatchObject({
      id: 'file:/work/report.md',
      href: '/work/report.md:12',
    })
    expect(result.sources[0]?.uses).toHaveLength(2)
  })
})

describe('structured tool resources', () => {
  it('records only successful file reads and structured MCP resource metadata', () => {
    expect(
      toolResources(toolData(tool('read', 'read', { path: '/work/spec.pdf' }))),
    ).toEqual([
      expect.objectContaining({ href: '/work/spec.pdf', provenance: 'read' }),
    ])
    expect(
      toolResources(
        toolData(
          tool('mcp', 'mcp_docs_read', {
            server: 'docs',
            resources: [{ url: 'https://docs.test/page', title: 'Reference' }],
          }),
        ),
      ),
    ).toEqual([
      expect.objectContaining({
        href: 'https://docs.test/page',
        label: 'Reference',
        provenance: 'read',
      }),
    ])
  })
  it('prefers the successful fetch result URL and falls back to its known URL argument', () => {
    const value = toolData(
      tool(
        'fetch',
        'web_fetch',
        {
          url: 'https://example.com/redirected',
          title: 'Fetched title',
          statusCode: 200,
        },
        'https://log.test/',
      ),
    )
    const data = { ...value, argsRaw: '{"url":"https://example.com/original"}' }
    expect(toolResources(data)).toEqual([
      expect.objectContaining({
        href: 'https://example.com/redirected',
        label: 'Fetched title',
        provenance: 'read',
      }),
    ])
    expect(
      toolResources({ ...data, result: { ...data.result!, meta: {} } }),
    ).toEqual([
      expect.objectContaining({
        href: 'https://example.com/original',
        provenance: 'read',
      }),
    ])
    expect(
      toolResources({ ...data, result: { ...data.result!, isError: true } }),
    ).toEqual([])
  })

  it('extracts identifiable structured GitHub entities without interpreting arbitrary output text', () => {
    const data = toolData(
      tool(
        'gh',
        'mcp_github_pull_request_read',
        { server: 'github', tool: 'pull_request_read' },
        JSON.stringify({
          html_url: 'https://github.com/OpenAI/codex/pull/12',
          title: 'Fix resources',
          body: 'details',
        }),
      ),
    )
    expect(toolResources(data)).toEqual([
      expect.objectContaining({
        kind: 'github',
        href: 'https://github.com/OpenAI/codex/pull/12',
        label: 'Fix resources',
        provenance: 'read',
      }),
    ])
    expect(
      toolResources(
        toolData(
          tool(
            'raw',
            'mcp_github_pull_request_read',
            {},
            'Log: https://github.com/a/b/pull/2',
          ),
        ),
      ),
    ).toEqual([])
    expect(
      toolResources(
        toolData(
          tool(
            'unknown',
            'custom_tool',
            {},
            JSON.stringify({ html_url: 'https://github.com/a/b/issues/3' }),
          ),
        ),
      ),
    ).toEqual([])
  })
})
