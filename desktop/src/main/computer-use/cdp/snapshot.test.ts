import { describe, expect, it } from 'vitest'
import type { IsolatedWorlds } from './isolated'
import type { CdpSession } from './session'
import {
  actionsOf,
  mapRole,
  statesOf,
  takeSnapshot,
  walkFrame,
  type AxNode,
  type Candidate,
} from './snapshot'

/** Shaped after a real Chromium dump of the /form fixture page. */
function formTree(): AxNode[] {
  const node = (
    nodeId: string,
    role: string,
    name: string,
    childIds: string[] = [],
    extra: Partial<AxNode> = {},
  ): AxNode => ({
    nodeId,
    role: { type: 'role', value: role },
    name: { type: 'computedString', value: name },
    childIds,
    backendDOMNodeId: Number(nodeId),
    ...extra,
  })
  const prop = (name: string, value: unknown) => ({
    name,
    value: { type: 'x', value },
  })
  return [
    node('1', 'RootWebArea', 'Fixture form', [
      '2',
      '4',
      '6',
      '8',
      '12',
      '13',
      '20',
    ]),
    node('2', 'paragraph', '', ['3'], { parentId: '1' }),
    node('3', 'StaticText', 'Sign up for the fixture newsletter.', [], {
      parentId: '2',
    }),
    node('4', 'LabelText', '', ['5'], { parentId: '1' }),
    node('5', 'textbox', 'Name ', [], {
      parentId: '4',
      properties: [
        prop('focusable', true),
        prop('editable', 'plaintext'),
        prop('focused', true),
      ],
    }),
    node('6', 'LabelText', '', ['7'], { parentId: '1' }),
    node('7', 'textbox', 'Password ', [], { parentId: '6' }),
    node('8', 'combobox', 'Country ', ['9'], {
      parentId: '1',
      value: { type: 'string', value: 'China' },
      properties: [prop('expanded', false)],
    }),
    node('9', 'MenuListPopup', '', ['10', '11'], { parentId: '8' }),
    node('10', 'option', 'China', [], {
      parentId: '9',
      properties: [prop('selected', true)],
    }),
    node('11', 'option', 'Japan', [], { parentId: '9' }),
    node('12', 'checkbox', ' I agree', [], {
      parentId: '1',
      properties: [prop('checked', 'true'), prop('invalid', 'false')],
    }),
    node('13', 'generic', '', ['14', '15'], { parentId: '1' }),
    node('14', 'button', 'Submit', [], { parentId: '13' }),
    node('15', 'button', 'Disabled', [], {
      parentId: '13',
      properties: [prop('disabled', true)],
    }),
    node('20', 'Iframe', 'other', [], { parentId: '1' }),
    node('21', 'heading', 'Ignored heading', [], {
      parentId: '1',
      ignored: true,
    }),
  ]
}

function names(candidates: Candidate[]): string[] {
  return candidates.map((candidate) => `${candidate.role}:${candidate.name}`)
}

describe('semantic snapshot', () => {
  it('walks in document order, trims names and hides select options', () => {
    const iframes: string[] = []
    const notes: string[] = []
    const out = walkFrame(
      formTree(),
      'main',
      { maxDepth: 8 },
      (iframe) => {
        iframes.push(iframe.nodeId)
        return null
      },
      notes,
    )
    expect(names(out)).toEqual([
      'textbox:Name',
      'textbox:Password',
      'combobox:Country',
      'checkbox:I agree',
      'button:Submit',
      'button:Disabled',
    ])
    expect(out.find((item) => item.role === 'combobox')?.select).toBe(true)
    expect(iframes).toEqual(['20'])
  })

  it('splices same-process frames in place', () => {
    const inner: Candidate = {
      node: { nodeId: 'x', backendDOMNodeId: 99 },
      frameId: 'child',
      role: 'button',
      nativeRole: 'button',
      name: 'Inner button',
      depth: 0,
      select: false,
    }
    const out = walkFrame(
      formTree(),
      'main',
      { maxDepth: 8 },
      () => [inner],
      [],
    )
    expect(names(out).at(-1)).toBe('button:Inner button')
  })

  it('filters by role, name and frame', () => {
    const tree = formTree()
    expect(
      names(
        walkFrame(
          tree,
          'main',
          { maxDepth: 8, role: 'option' },
          () => null,
          [],
        ),
      ),
    ).toEqual(['option:China', 'option:Japan'])
    expect(
      names(
        walkFrame(
          tree,
          'main',
          { maxDepth: 8, nameContains: 'sub' },
          () => null,
          [],
        ),
      ),
    ).toEqual(['button:Submit'])
    expect(
      walkFrame(
        tree,
        'main',
        { maxDepth: 8, frameId: 'other' },
        () => null,
        [],
      ),
    ).toEqual([])
  })

  it('maps platform roles onto the unified vocabulary', () => {
    const none = new Map<string, unknown>()
    expect(mapRole('switch', none)).toBe('checkbox')
    expect(mapRole('menuitemradio', none)).toBe('radio')
    expect(mapRole('spinbutton', none)).toBe('slider')
    expect(mapRole('gridcell', none)).toBe('cell')
    expect(mapRole('img', none)).toBe('image')
    expect(mapRole('alertdialog', none)).toBe('dialog')
    expect(mapRole('StaticText', none)).toBe('text')
    expect(mapRole('navigation', none)).toBe('other')
    expect(
      mapRole(
        'generic',
        new Map<string, unknown>([
          ['editable', 'richtext'],
          ['focusable', true],
        ]),
      ),
    ).toBe('textbox')
    expect(mapRole('generic', new Map([['editable', 'plaintext']]))).toBe(
      'other',
    )
  })

  it('reads states and derives actions', () => {
    const tree = formTree()
    expect(statesOf(tree.find((node) => node.nodeId === '12')!)).toEqual([
      'checked',
    ])
    expect(statesOf(tree.find((node) => node.nodeId === '15')!)).toEqual([
      'disabled',
    ])
    expect(statesOf(tree.find((node) => node.nodeId === '5')!)).toEqual([
      'focused',
    ])
    expect(actionsOf('textbox', false)).toEqual(['fill', 'type'])
    expect(actionsOf('combobox', true)).toEqual(['select'])
    expect(actionsOf('combobox', false)).toEqual(['fill', 'click'])
    expect(actionsOf('heading', false)).toEqual([])
  })
})

describe('cross-origin frames (OOPIF)', () => {
  const ax = (
    nodeId: string,
    role: string,
    name: string,
    extra: Partial<AxNode> = {},
  ): AxNode => ({
    nodeId,
    role: { type: 'role', value: role },
    name: { type: 'computedString', value: name },
    childIds: [],
    ...extra,
  })
  const quad = (x: number, y: number, w: number, h: number) => [
    x,
    y,
    x + w,
    y,
    x + w,
    y + h,
    x,
    y + h,
  ]

  function fakeCdp(): CdpSession {
    const main = {
      'Page.getFrameTree': {
        frameTree: {
          frame: { id: 'F1', url: 'http://127.0.0.1:1/frames' },
          childFrames: [
            { frame: { id: 'F2', url: 'http://localhost:2/embed' } },
            { frame: { id: 'F3', url: 'http://localhost:3/other' } },
          ],
        },
      },
      'Accessibility.getFullAXTree': {
        nodes: [
          ax('1', 'RootWebArea', 'Frames', { childIds: ['2', '3', '4'] }),
          ax('2', 'button', 'Outer button', {
            parentId: '1',
            backendDOMNodeId: 12,
          }),
          ax('3', 'Iframe', 'embed', { parentId: '1', backendDOMNodeId: 13 }),
          ax('4', 'Iframe', 'other', { parentId: '1', backendDOMNodeId: 14 }),
        ],
      },
      'Page.getLayoutMetrics': {
        cssVisualViewport: {
          clientWidth: 1280,
          clientHeight: 800,
          pageX: 0,
          pageY: 0,
        },
      },
    } as Record<string, unknown>
    const child = {
      'Page.getFrameTree': {
        frameTree: {
          frame: { id: 'F2', url: 'http://localhost:2/embed', parentId: 'F1' },
        },
      },
      'Accessibility.getFullAXTree': {
        nodes: [
          ax('100', 'RootWebArea', 'Embed', { childIds: ['101'] }),
          ax('101', 'button', 'Cross-origin button', {
            parentId: '100',
            backendDOMNodeId: 201,
          }),
        ],
      },
    } as Record<string, unknown>
    return {
      send: async (
        method: string,
        params: Record<string, unknown> = {},
        options: { sessionId?: string } = {},
      ) => {
        const session = options.sessionId
        if (session === 'S1') {
          if (method === 'DOM.describeNode') return { node: { attributes: [] } }
          if (method === 'DOM.getContentQuads')
            return { quads: [quad(8, 8, 120, 20)] }
          if (method in child) return child[method]
          throw new Error(`child ${method}`)
        }
        if (method === 'Accessibility.getFullAXTree' && params.frameId !== 'F1')
          throw new Error('Frame with the given frameId is not found.')
        if (method === 'DOM.describeNode') {
          const id = params.backendNodeId
          if (id === 13)
            return {
              node: {
                frameId: 'F2',
                attributes: ['src', 'http://localhost:2/embed'],
              },
            }
          if (id === 14)
            return {
              node: {
                frameId: 'F3',
                attributes: ['src', 'http://localhost:3/other'],
              },
            }
          return { node: { attributes: [] } }
        }
        if (method === 'DOM.getFrameOwner') return { backendNodeId: 13 }
        if (method === 'DOM.getContentQuads')
          return {
            quads: [
              params.backendNodeId === 13
                ? quad(400, 120, 300, 100)
                : quad(10, 10, 80, 20),
            ],
          }
        if (method in main) return main[method]
        throw new Error(`main ${method}`)
      },
    } as unknown as CdpSession
  }

  it('expands attached OOPIFs with page-relative bounds and their session', async () => {
    const result = await takeSnapshot(fakeCdp(), {} as IsolatedWorlds, {
      revision: 4,
      maxElements: 50,
      maxTextBytes: 1000,
      maxDepth: 8,
      timeoutMs: 2000,
      includeText: false,
      oopifs: new Map([['F2', 'S1']]),
    })
    const inner = result.all.find(
      (element) => element.name === 'Cross-origin button',
    )!
    expect(inner).toMatchObject({
      frameId: 'F2',
      bounds: { x: 408, y: 128, width: 120, height: 20 },
    })
    expect(result.refs.get(inner.ref)).toMatchObject({
      sessionId: 'S1',
      backendNodeId: 201,
      frameId: 'F2',
    })
    const outer = result.all.find((element) => element.name === 'Outer button')!
    expect(result.refs.get(outer.ref)?.sessionId).toBeUndefined()
    expect(result.frameSessions.get('F2')).toBe('S1')
    // F3 is cross-origin but has no attached session: it is still noted.
    expect(result.notes).toEqual([
      'cross-origin frame http://localhost:3 not expanded',
    ])
  })
})

describe('field value masking', () => {
  const field = (
    nodeId: string,
    name: string,
    value: string,
    backendDOMNodeId: number,
  ): AxNode => ({
    nodeId,
    parentId: '1',
    role: { type: 'role', value: 'textbox' },
    name: { type: 'computedString', value: name },
    value: { type: 'string', value },
    childIds: [],
    backendDOMNodeId,
  })
  const attributesOf: Record<number, string[]> = {
    // A password field the page switched to plain text ("show password").
    11: ['type', 'text', 'name', 'user_pass'],
    12: ['type', 'text', 'autocomplete', 'off', 'id', 'totp-input'],
    13: ['type', 'text', 'placeholder', '短信验证码'],
    14: ['type', 'email', 'name', 'email'],
  }
  function fakeCdp(): CdpSession {
    return {
      send: async (method: string, params: Record<string, unknown> = {}) => {
        if (method === 'Page.getFrameTree')
          return { frameTree: { frame: { id: 'F1', url: 'https://a.test/' } } }
        if (method === 'Accessibility.getFullAXTree')
          return {
            nodes: [
              {
                nodeId: '1',
                role: { type: 'role', value: 'RootWebArea' },
                name: { type: 'computedString', value: 'Login' },
                childIds: ['2', '3', '4', '5'],
              },
              field('2', 'Password', 'hunter2', 11),
              field('3', 'Code', '123456', 12),
              field('4', '', '654321', 13),
              field('5', 'Email', 'me@a.test', 14),
            ],
          }
        if (method === 'Page.getLayoutMetrics')
          return {
            cssVisualViewport: {
              clientWidth: 800,
              clientHeight: 600,
              pageX: 0,
              pageY: 0,
            },
          }
        if (method === 'DOM.describeNode')
          return {
            node: {
              attributes: attributesOf[params.backendNodeId as number] ?? [],
            },
          }
        if (method === 'DOM.getContentQuads')
          return { quads: [[0, 0, 10, 0, 10, 10, 0, 10]] }
        throw new Error(`unexpected ${method}`)
      },
    } as unknown as CdpSession
  }
  const input = {
    revision: 1,
    maxElements: 50,
    maxTextBytes: 0,
    maxDepth: 8,
    timeoutMs: 2000,
    includeText: false,
  }

  it('masks revealed passwords and one-time codes in plain text boxes', async () => {
    const result = await takeSnapshot(fakeCdp(), {} as IsolatedWorlds, input)
    const values = Object.fromEntries(
      result.all.map((element) => [element.name ?? '', element.value]),
    )
    expect(values).toEqual({
      Password: '[has content]',
      Code: '[has content]',
      '': '[has content]',
      Email: 'me@a.test',
    })
    expect(result.redactions).toBe(3)
    // The input type travels with the element (credential checks use it).
    expect(result.all.map((element) => element.inputType)).toEqual([
      'text',
      'text',
      'text',
      'email',
    ])
    expect(JSON.stringify(result.all)).not.toMatch(/hunter2|123456|654321/)
    // Masking does not make the fields untypable.
    for (const ref of result.refs.values()) expect(ref.secret).toBe(false)
  })

  it('masks every value after a credential fill', async () => {
    const result = await takeSnapshot(fakeCdp(), {} as IsolatedWorlds, {
      ...input,
      maskValues: true,
    })
    expect(result.all.map((element) => element.value)).toEqual([
      '[has content]',
      '[has content]',
      '[has content]',
      '[has content]',
    ])
  })
})
