// UI-S13: the order, groups and lines of the environment card's 来源 and
// of the 来源 view in the workbench.
import { describe, expect, it } from 'vitest'
import type { ChatNode } from '../../../conversation/types'
import type {
  DisplayResource,
  ResourceProvenance,
} from '../resources/resourceModel'
import {
  CARD_SOURCE_LIMIT,
  orderSources,
  shortenHome,
  sourceGroups,
  sourceLocation,
  sourceNote,
} from './sourcesModel'

function source(
  id: string,
  provenance: ResourceProvenance,
  patch: Partial<DisplayResource> = {},
): DisplayResource {
  return {
    id,
    kind: 'file',
    href: `/Users/alice/work/${id}`,
    label: id,
    subtitle: `/Users/alice/work/${id}`,
    sourceMessageId: 'm1',
    role: 'source',
    provenance,
    ...patch,
  }
}

function search(callId: string, queries: unknown): ChatNode {
  return {
    key: `tool:${callId}`,
    kind: 'tool',
    id: callId,
    target: 'chat',
    anchorSeq: 1,
    visibility: 'visible',
    turn: 1,
    step: 1,
    data: {
      callId,
      name: 'web_search',
      argsRaw: JSON.stringify({ queries }),
      turn: 1,
      step: 1,
      time: 0,
      status: 'settled',
      approvals: [],
    },
  } as ChatNode
}

describe('orderSources (UI-S13)', () => {
  it('puts what you provided first, then what was read, then search hits, each in its own order', () => {
    const list = [
      source('hit-1', 'discovered'),
      source('read-1', 'read'),
      source('mine', 'provided'),
      source('cited', 'cited'),
      source('read-2', 'read'),
      source('hit-2', 'discovered'),
      source('skill', 'used'),
    ]
    expect(orderSources(list).map((item) => item.id)).toEqual([
      'mine',
      'read-1',
      'read-2',
      'hit-1',
      'hit-2',
      'cited',
      'skill',
    ])
    expect(CARD_SOURCE_LIMIT).toBe(3)
  })
})

describe('sourceGroups (UI-S13)', () => {
  it('groups under 你提供的 / 已查看 / 搜索命中 and hides empty groups', () => {
    const groups = sourceGroups(
      [
        source('hit', 'discovered'),
        source('a', 'read'),
        source('b', 'read'),
        source('link', 'cited'),
      ],
      new Map(),
    )
    expect(groups.map((group) => [group.label, group.entries.length])).toEqual([
      ['已查看', 2],
      ['搜索命中', 1],
      // Anything else keeps its own word instead of disappearing.
      ['已引用', 1],
    ])
    expect(groups[0]!.entries.map((entry) => entry.resource.id)).toEqual([
      'a',
      'b',
    ])
  })

  it('names what you provided 你提供的', () => {
    expect(
      sourceGroups([source('mine', 'provided')], new Map())[0]!.label,
    ).toBe('你提供的')
  })
})

describe('sourceLocation (UI-S13)', () => {
  it('shows a file path with the home folder as ~', () => {
    expect(sourceLocation(source('src/main.js', 'read'))).toEqual({
      text: '~/work/src/main.js',
      mono: true,
    })
    expect(shortenHome('/Users/alice')).toBe('~')
    expect(shortenHome('/Users/alice/a b.md')).toBe('~/a b.md')
    expect(shortenHome('/tmp/Users/alice/x')).toBe('/tmp/Users/alice/x')
  })

  it('shows a web address without its scheme', () => {
    expect(
      sourceLocation(
        source('web', 'discovered', {
          kind: 'web',
          href: 'https://threejs.org/docs/#api/en/renderers/WebGLRenderer',
          subtitle: 'threejs.org',
        }),
      ),
    ).toEqual({
      text: 'threejs.org/docs/#api/en/renderers/WebGLRenderer',
      mono: true,
    })
  })

  it('describes what has no path in words', () => {
    expect(
      sourceLocation(
        source('att', 'provided', {
          kind: 'attachment',
          href: 'attachment:att',
          attachmentId: 'att',
          subtitle: '附件',
        }),
      ),
    ).toEqual({ text: '附件', mono: false })
    expect(
      sourceLocation(
        source('skill', 'used', {
          kind: 'skill',
          href: 'skill:writer',
          subtitle: 'Skill',
        }),
      ),
    ).toEqual({ text: 'Skill', mono: false })
  })
})

describe('sourceNote (UI-S13)', () => {
  it('names the search that found a hit, read from the loaded call', () => {
    const nodes = new Map([
      ['tool:s1', search('s1', ['three.js renderer resize', 'webgl dpr'])],
    ])
    const hit = source('hit', 'discovered', {
      uses: [
        { nodeKey: 'tool:s1', sourceMessageId: 's1', provenance: 'discovered' },
      ],
    })
    expect(sourceNote(hit, nodes)).toBe(
      '搜索「three.js renderer resize、webgl dpr」',
    )
  })

  it('counts the places a source was used', () => {
    const read = source('a', 'read', {
      uses: [
        { nodeKey: 'tool:r1', sourceMessageId: 'r1', provenance: 'read' },
        { nodeKey: 'tool:r2', sourceMessageId: 'r2', provenance: 'read' },
        { nodeKey: 'tool:r3', sourceMessageId: 'r3', provenance: 'read' },
      ],
    })
    expect(sourceNote(read, new Map())).toBe('3 处记录')
  })

  it('says nothing it does not know: one use, no loaded call', () => {
    const once = source('a', 'read', {
      uses: [{ nodeKey: 'tool:r1', sourceMessageId: 'r1', provenance: 'read' }],
    })
    expect(sourceNote(once, new Map())).toBe('')
    const hit = source('hit', 'discovered', {
      uses: [
        {
          nodeKey: 'tool:gone',
          sourceMessageId: 'x',
          provenance: 'discovered',
        },
        { nodeKey: 'tool:s1', sourceMessageId: 's1', provenance: 'discovered' },
      ],
    })
    // The call that is still loaded names its query; the count stays.
    expect(
      sourceNote(hit, new Map([['tool:s1', search('s1', ['three.js'])]])),
    ).toBe('搜索「three.js」· 2 处记录')
    expect(
      sourceNote(hit, new Map([['tool:s1', search('s1', 'not a list')]])),
    ).toBe('2 处记录')
  })
})
