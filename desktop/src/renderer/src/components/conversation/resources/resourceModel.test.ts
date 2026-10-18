import { describe, expect, it } from 'vitest'
import {
  displayResource,
  markdownResources,
  resourceUrlSpans,
  standaloneResource,
  resourceMarkdownSegments,
} from './resourceModel'

describe('resource identity', () => {
  it.each([
    [
      'https://github.com/TheSyart/emperor-agent',
      'repository',
      'TheSyart/emperor-agent',
    ],
    ['https://github.com/a/b/pull/42', 'pull_request', 'a/b · PR #42'],
    ['https://github.com/a/b/issues/7', 'issue', 'a/b · Issue #7'],
    [
      'https://github.com/a/b/commit/1234567890abcdef',
      'commit',
      'a/b · 1234567',
    ],
    ['https://github.com/a/b/releases/tag/v1.0', 'release', 'a/b · v1.0'],
    ['https://github.com/a/b/actions/runs/123', 'run', 'a/b · CI #123'],
  ])('identifies %s without fetching', (href, type, label) => {
    expect(displayResource(href, '', 'message-7')).toMatchObject({
      kind: 'github',
      label,
      href,
      sourceMessageId: 'message-7',
      github: { type },
    })
  })

  it('retains authored labels, query and fragment without trusting lookalike hosts', () => {
    expect(
      displayResource('https://docs.example.com/a?q=1#part', '指南', 'u1'),
    ).toMatchObject({
      kind: 'web',
      label: '指南',
      subtitle: 'docs.example.com',
      href: 'https://docs.example.com/a?q=1#part',
    })
    expect(
      displayResource('https://github.com.evil.test/a/b', '', 'u1')?.kind,
    ).toBe('web')
    expect(
      displayResource('https://git.company.test/a/b', '', 'u1')?.kind,
    ).toBe('web')
    expect(
      displayResource('https://github.com/a/b/blob/main/a.ts', '', 'u1'),
    ).toMatchObject({ kind: 'github', github: { type: 'page' } })
  })

  it('preserves files, line numbers and human titles', () => {
    expect(displayResource('README.md:12:3', '', 'u2')).toMatchObject({
      kind: 'file',
      label: 'README.md:12:3',
    })
    expect(
      displayResource('/Users/a/项目/设计 图.md#L42', '', 'u2'),
    ).toMatchObject({
      kind: 'file',
      label: '设计 图.md:42',
      sourceMessageId: 'u2',
    })
    expect(displayResource('docs/spec.md', '设计说明', 'u2')?.label).toBe(
      '设计说明',
    )
    expect(displayResource('src/', '', 'u2')?.kind).toBe('folder')
    expect(displayResource('images/a.png', '', 'u2')?.kind).toBe('image')
  })

  it.each([
    'javascript:alert(1)',
    'data:text/html,x',
    'https://user:secret@example.com',
    'mailto:a@b.test',
  ])('keeps %s out of resource actions', (href) => {
    expect(displayResource(href, '', 'u1')).toBeNull()
  })
})

describe('resource extraction', () => {
  it('upgrades only complete top-level paragraphs without breaking surrounding Markdown', () => {
    const segments = resourceMarkdownSegments(
      '## 标题\n\n说明 [链接](https://a.test)。\n\nhttps://github.com/a/b\n\n- [列表](https://b.test)\n',
      'a4',
    )
    expect(segments.map((s) => s.kind)).toEqual([
      'markdown',
      'resource',
      'markdown',
    ])
    expect(segments[0]).toMatchObject({
      text: '## 标题\n\n说明 [链接](https://a.test)。\n\n',
    })
    expect(segments[2]).toMatchObject({ text: '\n- [列表](https://b.test)\n' })
  })
  it('repeats reference definitions so a reference link works in every segment', () => {
    const segments = resourceMarkdownSegments(
      '先看 [文档][1]。\n\nhttps://github.com/a/b\n\n再看 [文档][1]。\n\n[1]: https://docs.example.com "Docs"\n',
      'a5',
    )
    expect(segments.map((s) => s.kind)).toEqual([
      'markdown',
      'resource',
      'markdown',
    ])
    for (const index of [0, 2]) {
      const text = (segments[index] as { text: string }).text
      expect(text).toContain('[1]: <https://docs.example.com> "Docs"')
    }
  })
  it('leaves unsplit Markdown untouched', () => {
    const text = '见 [文档][1]。\n\n[1]: https://docs.example.com\n'
    expect(resourceMarkdownSegments(text, 'a6')).toEqual([
      { kind: 'markdown', text },
    ])
  })
  it('extracts labeled and bare links while ignoring inline and fenced code', () => {
    const text =
      '参考 [项目](https://github.com/a/b) 和 https://docs.example.com/guide。\n\n`https://hidden.example.com`\n\n```txt\nhttps://fenced.example.com\n```'
    expect(markdownResources(text, 'a1').map((r) => [r.href, r.label])).toEqual(
      [
        ['https://github.com/a/b', '项目'],
        ['https://docs.example.com/guide', 'docs.example.com/guide'],
      ],
    )
  })

  it('only makes a lone paragraph link a card', () => {
    expect(
      standaloneResource('[项目](https://github.com/a/b)', 'a1')?.label,
    ).toBe('项目')
    expect(
      standaloneResource('https://github.com/a/b', 'a1')?.github?.type,
    ).toBe('repository')
    for (const text of [
      '参考 [项目](https://github.com/a/b)',
      '- [项目](https://github.com/a/b)',
      '`https://github.com/a/b`',
      '[一](https://a.test) [二](https://b.test)',
    ])
      expect(standaloneResource(text, 'a1')).toBeNull()
  })

  it('plain URL decorations preserve UTF-16 positions and skip code', () => {
    const text =
      '先看😀 https://github.com/a/b，再看 `https://skip.test` 和 https://docs.example.com/x?q=1。'
    const spans = resourceUrlSpans(text, 'u3')
    expect(spans.map((s) => text.slice(s.start, s.end))).toEqual([
      'https://github.com/a/b',
      'https://docs.example.com/x?q=1',
    ])
    expect(spans.every((s) => s.resource.sourceMessageId === 'u3')).toBe(true)
  })
})
