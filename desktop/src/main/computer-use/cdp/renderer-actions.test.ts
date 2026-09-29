import { describe, expect, it } from 'vitest'
import type { IsolatedWorlds } from './isolated'
import {
  clickTarget,
  fillTarget,
  pressKey,
  quadArea,
  scrollIn,
  selectOption,
  strokeFor,
  typeText,
  type FieldState,
  type RendererPage,
} from './renderer-actions'
import type { CdpSession } from './session'
import type { RefTarget } from './snapshot'

interface Sent {
  method: string
  params: Record<string, unknown>
  sessionId?: string
}

const field = (over: Partial<FieldState> = {}): FieldState => ({
  secret: false,
  editable: true,
  disabled: false,
  readOnly: false,
  value: 'typed',
  ...over,
})

function kit(
  options: {
    quads?: ReadonlyArray<readonly number[]> | Error
    hit?: number
    contains?: boolean
    fields?: FieldState[]
    select?: {
      ok: boolean
      reason?: string
      value?: string
      options?: string[]
    }
    moved?: boolean
    crossOriginFrames?: boolean
    activeIsFrame?: boolean
    failKey?: string
  } = {},
) {
  const sent: Sent[] = []
  const calls: Array<{ name: string; args: readonly unknown[] }> = []
  const fields = [...(options.fields ?? [field(), field()])]
  const cdp = {
    send: async (
      method: string,
      params: Record<string, unknown> = {},
      opts: { sessionId?: string } = {},
    ) => {
      sent.push({
        method,
        params,
        ...(opts.sessionId === undefined ? {} : { sessionId: opts.sessionId }),
      })
      if (
        method === 'Input.dispatchKeyEvent' &&
        params.key === options.failKey &&
        params.type !== 'keyUp'
      )
        throw new Error('renderer gone')
      if (method === 'DOM.getContentQuads') {
        if (options.quads instanceof Error) throw options.quads
        return { quads: options.quads ?? [[10, 10, 30, 10, 30, 30, 10, 30]] }
      }
      if (method === 'Page.getLayoutMetrics')
        return { cssVisualViewport: { pageX: 0, pageY: 100 } }
      if (method === 'DOM.getNodeForLocation')
        return options.hit === undefined ? {} : { backendNodeId: options.hit }
      return {}
    },
  } as unknown as CdpSession
  const worlds = {
    contains: async () => options.contains ?? true,
    callOnElement: async (
      _frame: string,
      _node: number,
      name: string,
      args: readonly unknown[],
    ) => {
      calls.push({ name, args })
      if (name === 'fieldState') return fields.shift() ?? field()
      if (name === 'selectOption')
        return options.select ?? { ok: true, value: String(args[0]) }
      if (name === 'scrollBy') return { moved: options.moved ?? true }
      return undefined
    },
    callInFrame: async (
      _frame: string,
      name: string,
      args: readonly unknown[],
    ) => {
      calls.push({ name, args })
      if (name === 'activeIsFrame') return options.activeIsFrame ?? false
      if (name === 'scrollPage') return { moved: options.moved ?? true }
      return undefined
    },
  } as unknown as IsolatedWorlds
  const page: RendererPage = {
    cdp,
    worlds,
    mainFrameId: 'F0',
    crossOriginFrames: options.crossOriginFrames ?? false,
  }
  let dispatched = 0
  const hooks = { dispatched: () => (dispatched += 1) }
  return {
    page,
    sent,
    calls,
    hooks,
    get dispatched() {
      return dispatched
    },
    input: () => sent.filter((item) => item.method.startsWith('Input.')),
  }
}

const target = (over: Partial<RefTarget> = {}): RefTarget => ({
  backendNodeId: 7,
  frameId: 'F0',
  role: 'button',
  name: 'Run',
  secret: false,
  select: false,
  ...over,
})

const signal = new AbortController().signal

describe('renderer actions', () => {
  it('measures quad areas regardless of winding', () => {
    expect(quadArea([0, 0, 10, 0, 10, 10, 0, 10])).toBe(100)
    expect(quadArea([0, 0, 0, 10, 10, 10, 10, 0])).toBe(100)
    expect(quadArea([5, 5, 5, 5, 5, 5, 5, 5])).toBe(0)
  })

  it('clicks the centre of a hit-tested ref and reports it', async () => {
    const k = kit({ hit: 9 })
    const changes = await clickTarget(
      k.page,
      target(),
      'r3.1',
      { count: 2 },
      k.hooks,
      signal,
    )
    expect(changes).toEqual(['clicked Run'])
    expect(k.dispatched).toBe(1)
    const location = k.sent.find(
      (item) => item.method === 'DOM.getNodeForLocation',
    )
    // Document coordinates: the centre (20,20) plus the page scroll (0,100).
    expect(location?.params).toMatchObject({ x: 20, y: 120 })
    expect(
      k.input().map((item) => [item.params.type, item.params.clickCount]),
    ).toEqual([
      ['mouseMoved', undefined],
      ['mousePressed', 1],
      ['mouseReleased', 1],
      ['mousePressed', 2],
      ['mouseReleased', 2],
    ])
  })

  it('refuses a covered, unrendered or arealess ref before any input', async () => {
    for (const [options, reason] of [
      [{ hit: 9, contains: false }, /covered by another element/],
      [{ hit: undefined }, /covered by another element/],
      [{ quads: new Error('gone') }, /not rendered/],
      [{ quads: [[1, 1, 1, 1, 1, 1, 1, 1]], hit: 9 }, /no clickable area/],
    ] as const) {
      const k = kit(options)
      await expect(
        clickTarget(k.page, target(), 'r3.1', {}, k.hooks, signal),
      ).rejects.toMatchObject({
        code: 'STALE_ELEMENT',
        message: expect.stringMatching(reason),
      })
      expect(k.dispatched).toBe(0)
      expect(k.input()).toEqual([])
    }
  })

  it('clicks inside a cross-origin frame on that frame’s own session', async () => {
    const k = kit({ hit: 9 })
    await clickTarget(
      k.page,
      target({ sessionId: 'S1' }),
      'r3.1',
      {},
      k.hooks,
      signal,
    )
    expect(k.input().every((item) => item.sessionId === 'S1')).toBe(true)
  })

  it('fills a text field and warns when the page reformats the value', async () => {
    const k = kit({ fields: [field(), field({ value: '(555) 010-0000' })] })
    const result = await fillTarget(
      k.page,
      target({ role: 'textbox', name: 'Phone' }),
      'r3.2',
      '5550100000',
      k.hooks,
      signal,
    )
    expect(result.changes).toEqual(['Phone filled (10 chars)'])
    expect(result.warnings).toHaveLength(1)
    expect(k.calls.map((call) => call.name)).toEqual([
      'fieldState',
      'focusAndSelectAll',
      'fieldState',
    ])
    expect(k.input()).toEqual([
      { method: 'Input.insertText', params: { text: '5550100000' } },
    ])
  })

  it('clears a field with Delete, and refuses secret, non-text and read-only fields before input', async () => {
    const cleared = kit({ fields: [field(), field({ value: '' })] })
    await fillTarget(cleared.page, target(), 'r3.2', '', cleared.hooks, signal)
    expect(cleared.input().map((item) => item.params.key)).toEqual([
      'Delete',
      'Delete',
    ])
    for (const [state, code] of [
      [field({ secret: true }), 'PERMISSION_DENIED'],
      [field({ editable: false }), 'INVALID_REQUEST'],
      [field({ readOnly: true }), 'INVALID_REQUEST'],
    ] as const) {
      const k = kit({ fields: [state] })
      await expect(
        fillTarget(k.page, target(), 'r3.2', 'x', k.hooks, signal),
      ).rejects.toMatchObject({ code })
      expect(k.dispatched).toBe(0)
      expect(k.input()).toEqual([])
    }
    const framed = kit()
    await expect(
      fillTarget(
        framed.page,
        target({ sessionId: 'S1' }),
        'r3.2',
        'x',
        framed.hooks,
        signal,
      ),
    ).rejects.toMatchObject({ reason: 'cross-origin-frame-input' })
  })

  it('types line breaks as Enter and focuses a named ref first', async () => {
    const k = kit()
    const changes = await typeText(
      k.page,
      target({ role: 'textbox' }),
      'one\ntwo',
      k.hooks,
      signal,
    )
    expect(changes).toEqual(['typed 7 chars'])
    expect(k.calls.map((call) => call.name)).toEqual(['fieldState', 'focus'])
    expect(
      k
        .input()
        .map((item) =>
          item.method === 'Input.insertText'
            ? item.params.text
            : `${item.params.type}:${item.params.key}`,
        ),
    ).toEqual(['one', 'keyDown:Enter', 'keyUp:Enter', 'two'])
  })

  it('refuses keys without a ref when the focus is inside a cross-origin frame', async () => {
    const k = kit({ crossOriginFrames: true, activeIsFrame: true })
    await expect(
      typeText(k.page, undefined, 'x', k.hooks, signal),
    ).rejects.toMatchObject({
      reason: 'cross-origin-frame-input',
    })
    expect(k.dispatched).toBe(0)
    const plain = kit()
    await typeText(plain.page, undefined, 'x', plain.hooks, signal)
    expect(plain.calls).toEqual([])
  })

  it('parses a key before anything else and releases modifiers even when the key fails', async () => {
    expect(() => strokeFor('Hyper+Q')).toThrow(
      expect.objectContaining({ code: 'INVALID_REQUEST' }),
    )
    const stroke = strokeFor('Meta+Shift+P')
    const k = kit({ failKey: stroke.key })
    await expect(
      pressKey(k.page, undefined, stroke, 'Meta+Shift+P', k.hooks, signal),
    ).rejects.toThrow('renderer gone')
    const ups = k
      .input()
      .filter((item) => item.params.type === 'keyUp')
      .map((item) => item.params.key)
    expect(ups).toEqual(['Shift', 'Meta'])
  })

  it('selects by label and names the choices when the option is missing', async () => {
    const k = kit()
    expect(
      await selectOption(
        k.page,
        target({ select: true, name: 'Size' }),
        'r3.4',
        'Large',
        k.hooks,
        signal,
      ),
    ).toEqual(['Size = Large'])
    const missing = kit({
      select: { ok: false, reason: 'no-such-option', options: ['S', 'M'] },
    })
    await expect(
      selectOption(
        missing.page,
        target({ select: true }),
        'r3.4',
        'XL',
        missing.hooks,
        signal,
      ),
    ).rejects.toThrow('no option "XL"; options: S, M')
    const notSelect = kit()
    await expect(
      selectOption(
        notSelect.page,
        target(),
        'r3.4',
        'XL',
        notSelect.hooks,
        signal,
      ),
    ).rejects.toThrow(/not a drop-down list/)
    expect(notSelect.dispatched).toBe(0)
  })

  it('scrolls an element or the page and reports whether anything moved', async () => {
    const k = kit()
    expect(
      await scrollIn(
        k.page,
        target(),
        { direction: 'up', amount: 2, unit: 'line' },
        k.hooks,
        signal,
      ),
    ).toBe(true)
    expect(k.calls).toEqual([{ name: 'scrollBy', args: [0, -2, 'line'] }])
    const edge = kit({ moved: false })
    expect(
      await scrollIn(
        edge.page,
        undefined,
        { direction: 'right', amount: 1, unit: 'page' },
        edge.hooks,
        signal,
      ),
    ).toBe(false)
    expect(edge.calls).toEqual([{ name: 'scrollPage', args: [1, 0, 'page'] }])
  })
})
