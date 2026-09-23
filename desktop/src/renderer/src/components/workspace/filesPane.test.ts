// @vitest-environment jsdom
import { createApp, h, nextTick, type App } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { core } = vi.hoisted(() => ({ core: vi.fn() }))
vi.mock('../../api/http', () => ({ core }))

import FilesPane from './FilesPane.vue'

const ENTRIES = [
  { name: 'src', path: 'src', kind: 'directory' },
  { name: 'README.md', path: 'README.md', kind: 'file' },
  { name: 'a.ts', path: 'a.ts', kind: 'file' },
]

function fakeCore(operation: string, payload?: Record<string, unknown>) {
  switch (operation) {
    case 'files.list':
      return Promise.resolve({
        projectRoot: '/tmp/demo',
        relativePath: String(payload?.relativePath ?? ''),
        entries: payload?.relativePath ? [] : ENTRIES,
      })
    case 'files.search':
      return Promise.resolve({
        projectRoot: '/tmp/demo',
        entries: [{ name: 'deep.ts', path: 'src/lib/deep.ts', kind: 'file' }],
      })
    case 'files.read': {
      const path = String(payload?.relativePath)
      return Promise.resolve({
        kind: 'text',
        name: path.split('/').pop(),
        content: 'const a = 1\nconst b = 2\n',
        truncated: false,
        bytes: 24,
      })
    }
    default:
      return Promise.resolve(null)
  }
}

let app: App | null = null
let container: HTMLDivElement | null = null
let exposed: { openPath: (path: string, line?: number) => Promise<void> }
const treeWidths: number[] = []

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

function mount(): HTMLDivElement {
  container = document.createElement('div')
  document.body.append(container)
  app = createApp({
    setup: () => () =>
      h(FilesPane, {
        ref: (instance: unknown) => {
          if (instance) exposed = instance as typeof exposed
        },
        sessionId: 's1',
        projectPath: '/tmp/demo',
        treeWidth: 300,
        onTreeWidth: (width: number) => treeWidths.push(width),
      }),
  })
  app.mount(container)
  return container
}

function tabLabels(root: HTMLElement): string[] {
  return [...root.querySelectorAll('.file-tab [role="tab"]')].map(
    (tab) => tab.textContent?.trim() ?? '',
  )
}

function treeRow(root: HTMLElement, name: string): HTMLButtonElement {
  return [...root.querySelectorAll<HTMLButtonElement>('.file-tree-row')].find(
    (row) => row.textContent?.includes(name),
  )!
}

function pressCloseTab(target: EventTarget): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key: 'w',
    code: 'KeyW',
    metaKey: true,
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  })
  // jsdom reports a non-mac platform: Ctrl+W is the binding there.
  Object.defineProperty(event, 'metaKey', { value: false })
  target.dispatchEvent(event)
  return event
}

beforeEach(() => {
  core.mockImplementation(fakeCore)
  treeWidths.length = 0
})

afterEach(() => {
  app?.unmount()
  app = null
  container?.remove()
  container = null
  core.mockReset()
  vi.useRealTimers()
})

describe('FilesPane', () => {
  it('puts the tree in a right column and shows the 打开文件 draft', async () => {
    const root = mount()
    await flush()
    const pane = root.querySelector('.files-pane')!
    const columns = [...pane.children].map((child) => child.className)
    expect(columns[0]).toContain('files-main')
    expect(columns.at(-1)).toContain('file-tree-column')
    expect(
      root.querySelector<HTMLElement>('.file-tree-column')!.style.width,
    ).toBe('300px')
    expect(
      root.querySelector<HTMLInputElement>('.files-search input')!.placeholder,
    ).toBe('筛选文件…')
    expect(tabLabels(root)).toEqual(['打开文件'])
    // Nothing to close while the draft is the only tab.
    expect(root.querySelector('.file-tab.draft .file-tab-close')).toBeNull()
    expect(root.querySelector('.file-crumbs')?.textContent?.trim()).toBe('/')
    const empty = root.querySelector('.files-empty')!
    expect(empty.textContent).toContain('打开文件')
    expect(empty.textContent).toContain('从项目目录树中选择文件')
    expect(root.querySelectorAll('.file-tree-row')).toHaveLength(3)
  })

  it('opens files as tabs with a breadcrumb; 「+」 adds a draft and focuses the filter', async () => {
    const root = mount()
    await flush()
    treeRow(root, 'README.md').click()
    await flush()
    expect(tabLabels(root)).toEqual(['README.md'])
    expect(root.querySelector('.file-crumbs')?.textContent).toContain(
      'README.md',
    )
    root
      .querySelector<HTMLButtonElement>('button[aria-label="打开文件"]')!
      .click()
    await flush()
    expect(tabLabels(root)).toEqual(['README.md', '打开文件'])
    expect(document.activeElement).toBe(
      root.querySelector('.files-search input'),
    )
    expect(root.querySelector('.files-empty')).not.toBeNull()
    // Picking a file while the draft is active replaces the draft.
    treeRow(root, 'a.ts').click()
    await flush()
    expect(tabLabels(root)).toEqual(['README.md', 'a.ts'])
    expect(root.querySelector('.file-tab.active')?.textContent).toContain(
      'a.ts',
    )
  })

  it('openPath opens nested files at a line and expands the tree', async () => {
    const root = mount()
    await flush()
    await exposed.openPath('./src/lib/b.ts', 2)
    await flush()
    expect(tabLabels(root)).toEqual(['b.ts'])
    expect(root.querySelector('.file-crumbs')?.textContent).toMatch(
      /src\s*\/\s*lib\s*\/\s*b\.ts/,
    )
    expect(core).toHaveBeenCalledWith('files.list', {
      sessionId: 's1',
      relativePath: 'src/lib',
      limit: 500,
    })
    expect(
      root
        .querySelector('.file-code-line.reference-line-active')
        ?.getAttribute('data-line'),
    ).toBe('2')
  })

  it('closes the active tab on Ctrl/⌘W only while focus is inside the pane', async () => {
    const root = mount()
    await flush()
    treeRow(root, 'README.md').click()
    await flush()
    treeRow(root, 'a.ts').click()
    await flush()
    expect(tabLabels(root)).toEqual(['README.md', 'a.ts'])

    const outside = pressCloseTab(document.body)
    expect(outside.defaultPrevented).toBe(false)
    expect(tabLabels(root)).toEqual(['README.md', 'a.ts'])

    const preview = root.querySelector<HTMLElement>('.file-preview-content')!
    preview.focus()
    const inside = pressCloseTab(preview)
    await flush()
    expect(inside.defaultPrevented).toBe(true)
    expect(tabLabels(root)).toEqual(['README.md'])
    // Focus stays in the pane, so the next press closes the next tab.
    expect(root.contains(document.activeElement)).toBe(true)
    pressCloseTab(document.activeElement!)
    await flush()
    expect(tabLabels(root)).toEqual(['打开文件'])
  })

  it('filters through files.search as you type', async () => {
    vi.useFakeTimers()
    const root = mount()
    await vi.runAllTimersAsync()
    await flush()
    const filter = root.querySelector<HTMLInputElement>('.files-search input')!
    filter.value = 'deep'
    filter.dispatchEvent(new Event('input'))
    await vi.advanceTimersByTimeAsync(250)
    await flush()
    expect(core).toHaveBeenCalledWith('files.search', {
      sessionId: 's1',
      query: 'deep',
      limit: 500,
    })
    const row = treeRow(root, 'deep.ts')
    expect(row.querySelector('.file-tree-hint')?.textContent).toBe('src/lib')
    filter.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    )
    await flush()
    expect(filter.value).toBe('')
    expect(root.querySelectorAll('.file-tree-row')).toHaveLength(3)
  })

  it('reports the tree width once a keyboard resize settles', async () => {
    const root = mount()
    await flush()
    const separator = root.querySelector<HTMLElement>('.file-tree-resizer')!
    separator.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }),
    )
    await flush()
    expect(treeWidths).toEqual([310])
    expect(
      root.querySelector<HTMLElement>('.file-tree-column')!.style.width,
    ).toBe('310px')
  })
})
