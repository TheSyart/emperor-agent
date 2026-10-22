// @vitest-environment jsdom
// FIX-05 (UI-10, UI-35, UI-36): the 终端 pane fits only to a usable size,
// tells the PTY only about real size changes (debounced), measures with a
// resolved font family and takes keyboard focus only when the user asks.
import { createApp, h, nextTick, ref, type App } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface Size {
  cols: number
  rows: number
}

const xterm = vi.hoisted(() => ({
  proposed: { cols: 80, rows: 24 } as
    { cols: number; rows: number } | undefined,
  terminals: [] as Array<{
    cols: number
    rows: number
    options: Record<string, unknown>
    focused: number
    disposed: boolean
    lines: string[]
  }>,
}))

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 100
    rows = 30
    focused = 0
    disposed = false
    textarea: HTMLTextAreaElement | null = null
    constructor(readonly options: Record<string, unknown>) {
      xterm.terminals.push(this)
    }
    loadAddon(addon: { activate(terminal: unknown): void }) {
      addon.activate(this)
    }
    open(parent: HTMLElement) {
      this.textarea = document.createElement('textarea')
      this.textarea.className = 'xterm-helper-textarea'
      parent.append(this.textarea)
    }
    onData() {
      return { dispose() {} }
    }
    lines: string[] = []
    write() {}
    writeln(line: string) {
      this.lines.push(line)
    }
    focus() {
      this.focused += 1
      this.textarea?.focus()
    }
    resize(cols: number, rows: number) {
      this.cols = cols
      this.rows = rows
    }
    dispose() {
      this.disposed = true
      this.textarea?.remove()
    }
  },
}))

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    terminal: {
      cols: number
      rows: number
      resize(c: number, r: number): void
    } | null = null
    activate(terminal: never) {
      this.terminal = terminal
    }
    proposeDimensions() {
      return xterm.proposed ? { ...xterm.proposed } : undefined
    }
    // Like the real addon: never below 2 × 1, resizes when the size differs.
    fit() {
      const size = this.proposeDimensions()
      if (!size || !this.terminal) return
      const cols = Math.max(2, size.cols)
      const rows = Math.max(1, size.rows)
      if (cols !== this.terminal.cols || rows !== this.terminal.rows)
        this.terminal.resize(cols, rows)
    }
    dispose() {}
  },
}))

const { core } = vi.hoisted(() => ({ core: vi.fn() }))
vi.mock('../../api/http', () => ({ core }))
vi.mock('../../api/backend', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/backend')>()),
  onTerminalEvent: vi.fn(() => () => undefined),
}))

import TerminalPane from './TerminalPane.vue'

const observers = new Set<() => void>()
class ResizeObserverStub {
  constructor(private readonly callback: () => void) {}
  observe(): void {
    observers.add(this.callback)
  }
  disconnect(): void {
    observers.delete(this.callback)
  }
}

function summary(id: string) {
  return {
    id,
    sessionId: 's1',
    pid: 1,
    cwd: '/tmp/demo',
    title: id,
    createdAt: 1,
    exited: false,
    exitCode: null as number | null,
  }
}

let listed: Array<ReturnType<typeof summary>> = []

function fakeCore(operation: string, payload?: Record<string, unknown>) {
  switch (operation) {
    case 'terminals.list':
      return Promise.resolve(listed)
    case 'terminals.create': {
      const created = summary(`t${listed.length + 1}`)
      listed = [...listed, created]
      return Promise.resolve(created)
    }
    case 'terminals.read':
      return Promise.resolve({
        terminal:
          listed.find((item) => item.id === payload?.terminalId) ??
          summary(String(payload?.terminalId)),
        chunks: [],
        latestSeq: 0,
      })
    default:
      return Promise.resolve({ ok: true })
  }
}

let app: App | null = null
let container: HTMLDivElement | null = null
const sessionId = ref('s1')
const visible = ref(true)
const focusRequest = ref(0)
let resizes: Array<Size & { at: number }> = []

function mount(): HTMLDivElement {
  container = document.createElement('div')
  document.body.append(container)
  app = createApp({
    setup: () => () =>
      h(TerminalPane, {
        sessionId: sessionId.value,
        visible: visible.value,
        focusRequest: focusRequest.value,
      }),
  })
  app.mount(container)
  return container
}

async function settle(ms = 0): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
  if (ms) await vi.advanceTimersByTimeAsync(ms)
  for (let i = 0; i < 4; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

/** The column changed size: the next fit would propose `size`. */
function observe(size: Size | undefined): void {
  xterm.proposed = size
  for (const callback of observers) callback()
}

function current() {
  return xterm.terminals.at(-1)!
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
  observers.clear()
  xterm.terminals.length = 0
  xterm.proposed = { cols: 80, rows: 24 }
  listed = [summary('t1')]
  resizes = []
  sessionId.value = 's1'
  visible.value = true
  focusRequest.value = 0
  core.mockImplementation(
    (operation: string, payload?: Record<string, unknown>) => {
      if (operation === 'terminals.resize')
        resizes.push({
          cols: Number(payload?.cols),
          rows: Number(payload?.rows),
          at: Date.now(),
        })
      return fakeCore(operation, payload)
    },
  )
})

afterEach(() => {
  app?.unmount()
  app = null
  container?.remove()
  container = null
  document.documentElement.style.removeProperty('--font-mono')
  core.mockReset()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('TerminalPane (FIX-05)', () => {
  it('6 · collapsing the workspace column never resizes the PTY to 2 columns', async () => {
    mount()
    await settle(300)
    expect(resizes.map(({ cols, rows }) => ({ cols, rows }))).toEqual([
      { cols: 80, rows: 24 },
    ])
    // The column animates shut: narrower and narrower, then nothing.
    for (const cols of [40, 19, 8, 2]) {
      observe({ cols, rows: cols < 10 ? 1 : 24 })
      await settle(16)
    }
    visible.value = false
    await settle()
    observe({ cols: 2, rows: 1 })
    await settle(500)
    expect(resizes.some((size) => size.cols < 20 || size.rows < 5)).toBe(false)
    // Below the floor the terminal keeps its size instead of fitting.
    expect(current().cols).toBeGreaterThanOrEqual(20)
    // Reopened at the same size: nothing to tell the PTY.
    const sent = resizes.length
    visible.value = true
    await settle()
    observe({ cols: 80, rows: 24 })
    await settle(300)
    expect(resizes).toHaveLength(sent)
    // A really new size goes out once.
    observe({ cols: 96, rows: 24 })
    await settle(300)
    expect(resizes.at(-1)).toMatchObject({ cols: 96, rows: 24 })
    expect(resizes).toHaveLength(sent + 1)
  })

  it('7 · dragging the column width sends at most one resize per 100 ms', async () => {
    mount()
    await settle(300)
    resizes = []
    const started = Date.now()
    for (let step = 0; step < 40; step += 1) {
      observe({ cols: 60 + step, rows: 24 })
      await settle(16)
    }
    await settle(300)
    const elapsed = Date.now() - started
    expect(resizes.length).toBeGreaterThan(0)
    expect(resizes.length).toBeLessThanOrEqual(Math.ceil(elapsed / 100))
    for (let i = 1; i < resizes.length; i += 1)
      expect(resizes[i]!.at - resizes[i - 1]!.at).toBeGreaterThanOrEqual(100)
    expect(resizes.at(-1)).toMatchObject({ cols: 99, rows: 24 })
  })

  it('9 · a session switch leaves keyboard focus where it was', async () => {
    const composer = document.createElement('textarea')
    document.body.append(composer)
    composer.focus()
    try {
      mount()
      await settle(300)
      expect(xterm.terminals.every((terminal) => terminal.focused === 0)).toBe(
        true,
      )
      expect(document.activeElement).toBe(composer)
      listed = [summary('t9')]
      sessionId.value = 's2'
      await settle(300)
      expect(xterm.terminals.length).toBeGreaterThan(1)
      expect(xterm.terminals.every((terminal) => terminal.focused === 0)).toBe(
        true,
      )
      expect(document.activeElement).toBe(composer)
    } finally {
      composer.remove()
    }
  })

  it('takes focus only when the user activates it: the pane picked, a tab clicked, a new terminal', async () => {
    focusRequest.value = 1
    const root = mount()
    await settle(300)
    expect(current().focused).toBe(1)
    // A session switch is not an activation.
    listed = [summary('t1'), summary('t2')]
    sessionId.value = 's2'
    focusRequest.value = 0
    await settle(300)
    expect(current().focused).toBe(0)
    // Clicking a tab is.
    root
      .querySelector<HTMLButtonElement>(
        '.workspace-tab-bar [data-tab-id="t2"]',
      )!
      .click()
    await settle(300)
    expect(current().focused).toBe(1)
    // So is 新建终端.
    root
      .querySelector<HTMLButtonElement>('button[aria-label="新建终端"]')!
      .click()
    await settle(300)
    expect(current().focused).toBe(1)
    expect(document.activeElement?.className).toContain('xterm-helper-textarea')
  })

  it('6 · uses the shared editor tab bar, the same one as 文件 (UI-S06)', async () => {
    listed = [summary('t1'), { ...summary('t2'), title: '' }]
    const root = mount()
    await settle(300)
    const strip = root.querySelector<HTMLElement>(
      '.terminal-pane .workspace-tab-bar .ds-tabs',
    )!
    expect(strip.dataset.variant).toBe('editor')
    expect(
      [...strip.querySelectorAll('[role="tab"]')].map((tab) =>
        tab.textContent?.trim(),
      ),
    ).toEqual(['t1', '终端 2'])
    expect(
      strip.querySelector('[data-tab-id="t1"]')?.getAttribute('aria-selected'),
    ).toBe('true')
    // Each terminal closes from its tab.
    expect(
      root.querySelector('.workspace-tab-bar button[aria-label="关闭 t1"]'),
    ).not.toBeNull()
  })

  it('arrow keys move between terminals without pulling focus into the shell', async () => {
    listed = [summary('t1'), summary('t2')]
    const root = mount()
    await settle(300)
    const first = root.querySelector<HTMLButtonElement>(
      '.workspace-tab-bar [data-tab-id="t1"]',
    )!
    first.focus()
    first.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
    )
    await settle(300)
    expect(core).toHaveBeenCalledWith('terminals.read', {
      sessionId: 's1',
      terminalId: 't2',
      afterSeq: 0,
    })
    expect(current().focused).toBe(0)
    expect(document.activeElement?.getAttribute('data-tab-id')).toBe('t2')
  })

  it('5 · an exited terminal says so in Chinese, with its exit code (UI-S10)', async () => {
    listed = [{ ...summary('t1'), exited: true, exitCode: 0 }]
    const root = mount()
    await settle(300)
    expect(current().lines).toContain('\r\n[进程已退出，退出码 0]')
    expect(current().lines.join('')).not.toContain('process exited')
    expect(
      root.querySelector('.workspace-tab-bar [data-tab-id="t1"]')?.textContent,
    ).toContain('已退出')
  })

  it('an empty pane keeps only the + in the tab bar, no second big button', async () => {
    listed = []
    core.mockImplementation(
      (operation: string, payload?: Record<string, unknown>) =>
        operation === 'terminals.create'
          ? Promise.reject(new Error('no PTY here'))
          : fakeCore(operation, payload),
    )
    const root = mount()
    await settle(300)
    expect(root.querySelector('.terminal-empty-action')).toBeNull()
    const buttons = [...root.querySelectorAll('button')].filter((button) =>
      (button.getAttribute('aria-label') ?? button.textContent ?? '').includes(
        '新建终端',
      ),
    )
    expect(buttons).toHaveLength(1)
    expect(buttons[0]!.closest('.workspace-tab-bar')).not.toBeNull()
    expect(root.querySelector('.terminal-empty')?.textContent).toContain(
      '没有打开的终端',
    )
  })

  it('hands xterm a resolved font family, never a CSS var()', async () => {
    document.documentElement.style.setProperty(
      '--font-mono',
      "'SF Mono', Menlo, monospace",
    )
    mount()
    await settle(300)
    const family = String(current().options.fontFamily)
    expect(family).not.toContain('var(')
    expect(family.startsWith("'SF Mono'")).toBe(true)
  })
})
