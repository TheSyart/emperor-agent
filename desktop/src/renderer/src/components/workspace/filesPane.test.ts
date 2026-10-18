// @vitest-environment jsdom
import { createApp, h, nextTick, ref, isProxy, type App } from 'vue'
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
    case 'files.read':
    case 'files.preview': {
      const path = String(payload?.path ?? payload?.relativePath ?? 'draft.txt')
      return Promise.resolve({
        id: `file:/tmp/demo/${path}`,
        path: `/tmp/demo/${path}`,
        relativePath: path,
        mimeType: 'text/plain',
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
let exposed: {
  openPath: (path: string, line?: number) => Promise<void>
  openDirectory: (path: string) => Promise<void>
  openPreview: (
    request: import('./workspaceState').WorkspaceFileRequest,
  ) => Promise<void>
}
const treeWidths: number[] = []
const owner = ref('s1')

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

function mount(projectPath = '/tmp/demo'): HTMLDivElement {
  container = document.createElement('div')
  document.body.append(container)
  app = createApp({
    setup: () => () =>
      h(FilesPane, {
        ref: (instance: unknown) => {
          if (instance) exposed = instance as typeof exposed
        },
        sessionId: owner.value,
        projectPath,
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
  owner.value = 's1'
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
  it('opens Chat and unsent attachment previews in tabs without listing a workspace', async () => {
    const root = mount('')
    await flush()
    expect(core).not.toHaveBeenCalledWith('files.list', expect.anything())
    expect(root.querySelector('.file-tree-column')).toBeNull()
    const request = {
      owner: 's1',
      target: {
        source: 'attachment' as const,
        attachmentId: 'att_2026-10_12345678',
      },
    }
    await exposed.openPreview(request)
    await exposed.openPreview(request)
    await flush()
    expect(tabLabels(root)).toEqual(['draft.txt'])
    expect(root.querySelector('[role="dialog"]')).toBeNull()
    expect(root.querySelector('.file-code-view')?.textContent).toContain(
      'const a = 1',
    )
    root.querySelector<HTMLButtonElement>('[aria-label="刷新文件"]')!.click()
    await flush()
    expect(
      core.mock.calls.filter(([op]) => op === 'files.preview'),
    ).toHaveLength(2)
    await exposed.openPreview({ ...request, owner: 'other' })
    expect(
      core.mock.calls.filter(([op]) => op === 'files.preview'),
    ).toHaveLength(2)
  })

  it('sends plain cloneable preview inputs across the Electron boundary', async () => {
    core.mockImplementation((op: string, payload?: Record<string, unknown>) => {
      if (op === 'files.preview' && isProxy(payload))
        return Promise.reject(new Error('IPC cannot clone a Vue proxy'))
      return fakeCore(op, payload)
    })
    const root = mount('')
    await exposed.openPreview({
      owner: 's1',
      target: { source: 'attachment', attachmentId: 'att_2026-10_12345678' },
    })
    await flush()
    root.querySelector<HTMLButtonElement>('[aria-label="刷新文件"]')!.click()
    await flush()
    expect(root.querySelector('[role="alert"]')).toBeNull()
    expect(root.querySelector('.file-code-view')?.textContent).toContain(
      'const a = 1',
    )
  })

  it('refreshes the visible file after closing the active tab', async () => {
    const root = mount('')
    await exposed.openPreview({
      owner: 's1',
      target: { source: 'project', sessionId: 's1', path: 'a.ts' },
    })
    await exposed.openPreview({
      owner: 's1',
      target: { source: 'project', sessionId: 's1', path: 'b.ts' },
    })
    await flush()
    root.querySelector<HTMLButtonElement>('[aria-label="关闭 b.ts"]')!.click()
    await flush()
    root.querySelector<HTMLButtonElement>('[aria-label="刷新文件"]')!.click()
    await flush()
    expect(core).toHaveBeenLastCalledWith('files.preview', {
      source: 'project',
      sessionId: 's1',
      path: 'a.ts',
    })
    expect(tabLabels(root)).toEqual(['a.ts'])
  })

  it('keeps at most twelve file tabs, dropping the oldest', async () => {
    const root = mount('')
    for (let i = 1; i <= 13; i++)
      await exposed.openPreview({
        owner: 's1',
        target: { source: 'project', sessionId: 's1', path: `f${i}.ts` },
      })
    await flush()
    const labels = tabLabels(root)
    expect(labels).toHaveLength(12)
    expect(labels[0]).toBe('f2.ts')
    expect(labels.at(-1)).toBe('f13.ts')
    expect(root.querySelector('.file-tab.active')?.textContent).toContain(
      'f13.ts',
    )
  })

  it('drops a file response after the viewed session changes', async () => {
    let resolveRead!: (value: unknown) => void
    core.mockImplementation((op: string, payload?: Record<string, unknown>) =>
      op === 'files.preview'
        ? new Promise((resolve) => {
            resolveRead = resolve
          })
        : fakeCore(op, payload),
    )
    const root = mount('')
    const opening = exposed.openPreview({
      owner: 's1',
      target: { source: 'attachment', attachmentId: 'att_2026-10_12345678' },
    })
    owner.value = 's2'
    await flush()
    resolveRead({
      id: 'old',
      path: '/old.txt',
      name: 'old.txt',
      mimeType: 'text/plain',
      kind: 'text',
      content: 'old session secret',
      bytes: 18,
      truncated: false,
    })
    await opening
    await flush()
    expect(root.textContent).not.toContain('old session secret')
    expect(root.querySelectorAll('.file-tab')).toHaveLength(0)
  })

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

  it('keeps the tree when a file opens while the tree is still loading', async () => {
    const root = mount()
    // No flush: the root listing is still in flight.
    await exposed.openPath('a.ts')
    await flush()
    expect(tabLabels(root)).toEqual(['a.ts'])
    expect(
      [...root.querySelectorAll('.file-tree-row')].map((row) =>
        row.getAttribute('data-path'),
      ),
    ).toEqual(['src', 'README.md', 'a.ts'])
  })

  it('openDirectory opens a folder in the tree and focuses its row', async () => {
    const scrolled: Element[] = []
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this)
    }
    const root = mount()
    await flush()
    await exposed.openDirectory('./src/')
    await flush()
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView
    const row = root.querySelector<HTMLElement>('[data-path="src"]')
    expect(row?.getAttribute('aria-expanded')).toBe('true')
    expect(document.activeElement).toBe(row)
    expect(scrolled).toEqual([row])
    expect(core).toHaveBeenCalledWith('files.list', {
      sessionId: 's1',
      relativePath: 'src',
      limit: 500,
    })
    // No file tab opens; the draft stays.
    expect(tabLabels(root)).toEqual(['打开文件'])
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
