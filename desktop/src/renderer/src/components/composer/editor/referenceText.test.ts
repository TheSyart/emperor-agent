import { describe, expect, it } from 'vitest'
import {
  messageSegments,
  referencesFit,
  spansFromText,
  type ComposerCatalog,
} from './referenceText'

const catalog: ComposerCatalog = {
  skill: (id) => ({ 'image-gen': 'Image Gen' })[id],
  plugin: () => undefined,
}

describe('reference text', () => {
  it('shows saved chips where they sit, greying those no longer known', () => {
    const text = '用 /image-gen 和 /old-skill'
    expect(
      messageSegments(
        text,
        [
          {
            kind: 'skill',
            id: 'image-gen',
            label: 'Image Gen',
            start: 2,
            end: 12,
          },
          {
            kind: 'skill',
            id: 'old-skill',
            label: '旧技能',
            start: 15,
            end: 25,
          },
        ],
        catalog,
      ),
    ).toEqual([
      { kind: 'text', text: '用 ' },
      {
        kind: 'chip',
        chip: { kind: 'skill', id: 'image-gen', label: 'Image Gen' },
        available: true,
      },
      { kind: 'text', text: ' 和 ' },
      {
        kind: 'chip',
        chip: { kind: 'skill', id: 'old-skill', label: '旧技能' },
        available: false,
      },
    ])
  })

  it('recovers chips of older messages from the names known now', () => {
    expect(
      messageSegments(
        '@skill(Image-Gen) 与 @mcp(aihot) /image-gen',
        undefined,
        catalog,
      ),
    ).toEqual([
      {
        kind: 'chip',
        chip: { kind: 'skill', id: 'image-gen', label: 'Image Gen' },
        available: true,
      },
      { kind: 'text', text: ' 与 MCP: aihot ' },
      {
        kind: 'chip',
        chip: { kind: 'skill', id: 'image-gen', label: 'Image Gen' },
        available: true,
      },
    ])
    // References that no longer fit the text fall back the same way.
    expect(
      messageSegments(
        'x /image-gen',
        [{ kind: 'skill', id: 'image-gen', label: 'Old', start: 0, end: 10 }],
        catalog,
      ).find((segment) => segment.kind === 'chip'),
    ).toMatchObject({ chip: { label: 'Image Gen' } })
  })

  it('finds only complete, known, lower-case names at a word start', () => {
    expect(
      spansFromText(
        'a/image-gen /Image-gen /image-gen. /image-gen',
        catalog,
      ).map((span) => span.start),
    ).toEqual([35])
    expect(referencesFit('', [])).toBe(true)
  })
})
