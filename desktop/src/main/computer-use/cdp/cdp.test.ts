import { describe, expect, it, vi } from 'vitest'
import {
  CONTAINS_NODE_SOURCE,
  ISOLATED_FUNCTIONS,
  isolatedCall,
} from './isolated-functions'
import { parseKey } from './key-map'
import { CdpSession, type DebuggerLike } from './session'

class FakeDebugger implements DebuggerLike {
  attached = false
  inUse = false
  readonly handlers = new Map<string, Array<(...args: never[]) => void>>()
  replies = new Map<string, () => Promise<unknown>>()
  attach(): void {
    if (this.inUse) throw new Error('Another debugger is already attached')
    this.attached = true
  }
  detach(): void {
    this.attached = false
  }
  isAttached(): boolean {
    return this.attached
  }
  sendCommand(method: string): Promise<unknown> {
    return this.replies.get(method)?.() ?? Promise.resolve({ ok: method })
  }
  on(event: string, listener: (...args: never[]) => void): this {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), listener])
    return this
  }
  removeListener(event: string, listener: (...args: never[]) => void): this {
    this.handlers.set(
      event,
      (this.handlers.get(event) ?? []).filter((item) => item !== listener),
    )
    return this
  }
  fire(event: string, ...args: unknown[]): void {
    for (const listener of this.handlers.get(event) ?? [])
      (listener as (...values: unknown[]) => void)(...args)
  }
}

describe('CdpSession', () => {
  it('sends commands and fans out events', async () => {
    const dbg = new FakeDebugger()
    const session = new CdpSession(dbg)
    session.attach()
    expect(await session.send('Page.enable')).toEqual({ ok: 'Page.enable' })
    const seen: string[] = []
    session.subscribe((method) => seen.push(method))
    dbg.fire('message', {}, 'Page.frameNavigated', { frame: {} }, '')
    expect(seen).toEqual(['Page.frameNavigated'])
  })

  it('reports DevTools owning the debugger as DRIVER_UNAVAILABLE', () => {
    const dbg = new FakeDebugger()
    dbg.inUse = true
    expect(() => new CdpSession(dbg).attach()).toThrow(/in use/)
  })

  it('times out and aborts commands', async () => {
    const dbg = new FakeDebugger()
    dbg.replies.set('Slow.command', () => new Promise(() => undefined))
    const session = new CdpSession(dbg)
    session.attach()
    await expect(
      session.send('Slow.command', {}, { timeoutMs: 20 }),
    ).rejects.toMatchObject({ code: 'TIMEOUT_NO_EFFECT' })
    const controller = new AbortController()
    const pending = session.send(
      'Slow.command',
      {},
      { signal: controller.signal },
    )
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'TIMEOUT_NO_EFFECT' })
  })

  it('fails pending commands and reports once on detach', async () => {
    const dbg = new FakeDebugger()
    dbg.replies.set('Slow.command', () => new Promise(() => undefined))
    const onDetached = vi.fn()
    const session = new CdpSession(dbg, onDetached)
    session.attach()
    const pending = session.send('Slow.command')
    dbg.fire('detach', {}, 'target closed')
    await expect(pending).rejects.toMatchObject({ code: 'DRIVER_UNAVAILABLE' })
    await expect(session.send('Page.enable')).rejects.toMatchObject({
      code: 'DRIVER_UNAVAILABLE',
    })
    dbg.fire('detach', {}, 'again')
    expect(onDetached).toHaveBeenCalledTimes(1)
    expect(session.detachReason).toBe('target closed')
  })

  it('maps protocol errors with a cdp-error reason', async () => {
    const dbg = new FakeDebugger()
    dbg.replies.set('DOM.getBoxModel', () =>
      Promise.reject(new Error('Could not compute box model.')),
    )
    const session = new CdpSession(dbg)
    session.attach()
    await expect(session.send('DOM.getBoxModel')).rejects.toMatchObject({
      reason: 'cdp-error',
    })
  })
})

describe('isolated function registry', () => {
  const FORBIDDEN = [
    /\beval\b/,
    /\bFunction\s*\(/,
    /\bimport\s*\(/,
    /\bfetch\b/,
    /XMLHttpRequest/,
    /WebSocket/,
    /sendBeacon/,
    /postMessage/,
    /\bcookie\b/,
    /localStorage/,
    /sessionStorage/,
    /indexedDB/,
    /\bopen\s*\(/,
    /\blocation\s*=/,
    /\.submit\s*\(/,
    /innerHTML\s*=/,
  ]

  it('keeps a fixed set of names', () => {
    expect(Object.keys(ISOLATED_FUNCTIONS).sort()).toEqual([
      'activeIsFrame',
      'documentState',
      'fieldState',
      'fileInputState',
      'focus',
      'focusAndSelectAll',
      'hasText',
      'scrollBy',
      'scrollIntoView',
      'scrollPage',
      'selectOption',
      'textExcerpt',
    ])
    expect(Object.isFrozen(ISOLATED_FUNCTIONS)).toBe(true)
  })

  it.each([
    ...Object.entries(ISOLATED_FUNCTIONS),
    ['containsNode', { source: CONTAINS_NODE_SOURCE }] as const,
  ])('%s passes the source audit', (_name, fn) => {
    for (const pattern of FORBIDDEN) expect(fn.source).not.toMatch(pattern)
    expect(fn.source.trim()).toMatch(/^function \(/)
  })

  it('never returns secret field values', () => {
    expect(ISOLATED_FUNCTIONS.fieldState.source).toMatch(
      /value: secret \? null/,
    )
  })

  it('refuses unknown names and non-primitive arguments', () => {
    expect(() => isolatedCall('evaluate', ['1+1'])).toThrow(/unknown/)
    expect(() => isolatedCall('hasText', [{ toString: () => 'x' }])).toThrow(
      /primitives/,
    )
    expect(() => isolatedCall('hasText', [Number.NaN])).toThrow(/non-finite/)
    expect(() => isolatedCall('hasText', ['x'.repeat(20_000)])).toThrow(
      /too long/,
    )
    expect(isolatedCall('hasText', ['Thanks'])).toMatchObject({
      onElement: false,
      args: ['Thanks'],
    })
  })
})

describe('key map', () => {
  it.each([
    [
      'Enter',
      {
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
        text: '\r',
        modifiers: 0,
      },
    ],
    ['Tab', { key: 'Tab', windowsVirtualKeyCode: 9, modifiers: 0 }],
    [
      'a',
      {
        key: 'a',
        code: 'KeyA',
        windowsVirtualKeyCode: 65,
        text: 'a',
        modifiers: 0,
      },
    ],
    ['Shift+a', { key: 'A', code: 'KeyA', text: 'A', modifiers: 8 }],
    ['Meta+A', { key: 'A', code: 'KeyA', modifiers: 4 }],
    ['Control+Shift+Tab', { key: 'Tab', modifiers: 10 }],
    ['F5', { key: 'F5', code: 'F5', windowsVirtualKeyCode: 116 }],
    ['Control++', { key: '+', modifiers: 2 }],
    ['ArrowDown', { key: 'ArrowDown', windowsVirtualKeyCode: 40 }],
  ])('%s', (input, expected) => {
    expect(parseKey(input)).toMatchObject(expected)
  })

  it('drops text for chords and orders modifier presses', () => {
    const stroke = parseKey('Control+Shift+Tab')
    expect(stroke.text).toBeUndefined()
    expect(stroke.modifierKeys.map((item) => item.key)).toEqual([
      'Control',
      'Shift',
    ])
    expect(parseKey('Meta+c').text).toBeUndefined()
  })

  it('rejects unknown names', () => {
    expect(() => parseKey('Hyper+x')).toThrow(/modifier/)
    expect(() => parseKey('Launch')).toThrow(/unknown key/)
    expect(() => parseKey('Control+')).toThrow(/invalid/)
  })
})
