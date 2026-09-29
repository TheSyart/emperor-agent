import { describe, expect, it } from 'vitest'
import { EditorState, TextSelection } from 'prosemirror-state'
import {
  chipNode,
  composerDocFromText,
  composerSchema,
  referencesFit,
  serializeComposer,
  triggerAt,
  typedGestureAt,
  type ComposerCatalog,
} from './composerDocument'

const catalog: ComposerCatalog = {
  skill: (id) =>
    ({ 'image-gen': 'Image Gen', 'skill-creator': 'Skill Creator' })[id],
  plugin: (id) => ({ github: 'GitHub', 'computer-use': 'Computer Use' })[id],
}

function paragraph(...nodes: Array<string | ReturnType<typeof chipNode>>) {
  return composerSchema.nodes.paragraph!.create(
    null,
    nodes.map((node) =>
      typeof node === 'string' ? composerSchema.text(node) : node,
    ),
  )
}

/** A state with the caret at the end of the given text (one paragraph). */
function stateAt(text: string) {
  const doc = composerSchema.nodes.doc!.create(null, [
    paragraph(...(text ? [text] : [])),
  ])
  const state = EditorState.create({ doc })
  return state.apply(
    state.tr.setSelection(TextSelection.create(doc, doc.content.size - 1)),
  )
}

describe('composer document', () => {
  it('serializes chips as the gestures the model receives, with their offsets', () => {
    const doc = composerSchema.nodes.doc!.create(null, [
      paragraph('请用 ', chipNode('skill', 'image-gen', 'Image Gen'), ' 画猫'),
      paragraph(chipNode('plugin', 'github', 'GitHub'), ' 看 PR'),
    ])
    const output = serializeComposer(doc)
    expect(output.content).toBe('请用 /image-gen 画猫\n@github 看 PR')
    expect(output.references).toEqual([
      { kind: 'skill', id: 'image-gen', label: 'Image Gen', start: 3, end: 13 },
      { kind: 'plugin', id: 'github', label: 'GitHub', start: 17, end: 24 },
    ])
    expect(referencesFit(output.content, output.references)).toBe(true)
  })

  it('turns known names into chips and leaves everything else as text', () => {
    const doc = composerDocFromText(
      '/image-gen 画一只猫 和 /unknown 以及 a/b https://x.test/p x@github.com @github',
      catalog,
    )
    const output = serializeComposer(doc)
    expect(output.content).toBe(
      '/image-gen 画一只猫 和 /unknown 以及 a/b https://x.test/p x@github.com @github',
    )
    expect(
      output.references.map((reference) => `${reference.kind}:${reference.id}`),
    ).toEqual(['skill:image-gen', 'plugin:github'])
  })

  it('reads the old composer markers', () => {
    const output = serializeComposer(
      composerDocFromText('看 @skill(Skill-Creator) 与 @mcp(aihot)', catalog),
    )
    expect(output.content).toBe('看 /skill-creator 与 MCP: aihot')
    expect(output.references).toEqual([
      expect.objectContaining({
        kind: 'skill',
        id: 'skill-creator',
        label: 'Skill Creator',
      }),
    ])
  })

  it('places chips exactly where saved references say, labels included', () => {
    const text = '先 /old-skill 再说\n@acme/tools 好'
    const doc = composerDocFromText(text, catalog, [
      { kind: 'skill', id: 'old-skill', label: '旧技能', start: 2, end: 12 },
      { kind: 'plugin', id: 'acme/tools', label: 'Acme', start: 16, end: 27 },
    ])
    expect(serializeComposer(doc)).toEqual({
      content: text,
      references: [
        { kind: 'skill', id: 'old-skill', label: '旧技能', start: 2, end: 12 },
        { kind: 'plugin', id: 'acme/tools', label: 'Acme', start: 16, end: 27 },
      ],
    })
    // References that do not fit fall back to the known names.
    const fallback = composerDocFromText('/image-gen x', catalog, [
      { kind: 'skill', id: 'image-gen', label: 'X', start: 1, end: 5 },
    ])
    expect(serializeComposer(fallback).references[0]?.label).toBe('Image Gen')
  })

  it('rejects references that break the invariants', () => {
    const content = 'a /image-gen b'
    const ok = { kind: 'skill' as const, id: 'image-gen', label: 'x' }
    expect(referencesFit(content, [{ ...ok, start: 2, end: 12 }])).toBe(true)
    expect(referencesFit(content, [{ ...ok, start: 1, end: 11 }])).toBe(false)
    expect(
      referencesFit(content, [{ ...ok, id: 'Image-Gen', start: 2, end: 12 }]),
    ).toBe(false)
    expect(
      referencesFit('/image-gen /image-gen', [
        { ...ok, start: 11, end: 21 },
        { ...ok, start: 0, end: 10 },
      ]),
    ).toBe(false)
  })

  it('opens the list only for / or @ at the start or after whitespace', () => {
    expect(triggerAt(stateAt('/'))).toMatchObject({
      sigil: '/',
      query: '',
      atStart: true,
    })
    expect(triggerAt(stateAt('/ima'))).toMatchObject({
      query: 'ima',
      from: 1,
      to: 5,
      atStart: true,
    })
    expect(triggerAt(stateAt('画 /ima'))).toMatchObject({
      sigil: '/',
      query: 'ima',
      atStart: false,
    })
    expect(triggerAt(stateAt('问 @gi'))).toMatchObject({
      sigil: '@',
      query: 'gi',
    })
    for (const text of ['a/b', 'https://x.test/', 'x@y.com', '/ima ', '画'])
      expect(triggerAt(stateAt(text)), text).toBeNull()
  })

  it('knows a complete typed name before the caret', () => {
    expect(typedGestureAt(stateAt('画 /image-gen'), catalog)).toEqual({
      from: 3,
      to: 13,
      kind: 'skill',
      id: 'image-gen',
      label: 'Image Gen',
    })
    expect(typedGestureAt(stateAt('/unknown'), catalog)).toBeNull()
    expect(typedGestureAt(stateAt('a/image-gen'), catalog)).toBeNull()
    expect(typedGestureAt(stateAt('/Image-gen'), catalog)).toBeNull()
  })
})
