// @vitest-environment jsdom
import { createApp, h, nextTick, ref, isProxy, type App } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { core, coreListeners } = vi.hoisted(() => ({
  core: vi.fn(),
  coreListeners: new Set<(event: unknown) => void>(),
}))
vi.mock('../../api/http', () => ({ core }))
vi.mock('../../api/backend', async (original) => ({
  ...(await original<typeof import('../../api/backend')>()),
  onCoreEvent: (listener: (event: unknown) => void) => {
    coreListeners.add(listener)
    return () => coreListeners.delete(listener)
  },
}))
function emitCore(event: Record<string, unknown>): void {
  for (const listener of [...coreListeners]) listener(event)
}

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
  return [
    ...root.querySelectorAll('.files-main .workspace-tab-bar [role="tab"]'),
  ].map((tab) => tab.textContent?.trim() ?? '')
}

function activeTab(root: HTMLElement): HTMLElement | null {
  return root.querySelector<HTMLElement>(
    '.files-main .workspace-tab-bar .tab-item[data-active]',
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
    expect(activeTab(root)?.textContent).toContain('f13.ts')
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
    expect(tabLabels(root)).toHaveLength(0)
  })

  it('puts the tree in a right column; with nothing open there is no tab, only the empty state', async () => {
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
    // No 「打开文件」 draft tab (UI-S06): the strip is empty until a file opens.
    expect(tabLabels(root)).toEqual([])
    expect(root.querySelector('.files-main .workspace-tab-bar')).not.toBeNull()
    expect(root.querySelector('.file-crumbs')?.textContent?.trim()).toBe('/')
    const empty = root.querySelector('.files-empty')!
    expect(empty.textContent).toContain('打开文件')
    expect(empty.textContent).toContain('从项目目录树中选择文件')
    expect(root.querySelectorAll('.file-tree-row')).toHaveLength(3)
  })

  it('opens files as tabs with a breadcrumb; 「+」 only focuses the filter', async () => {
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
    // No draft tab: the open file stays on screen, the caret is in the filter.
    expect(tabLabels(root)).toEqual(['README.md'])
    expect(document.activeElement).toBe(
      root.querySelector('.files-search input'),
    )
    expect(activeTab(root)?.textContent).toContain('README.md')
    treeRow(root, 'a.ts').click()
    await flush()
    expect(tabLabels(root)).toEqual(['README.md', 'a.ts'])
    expect(activeTab(root)?.textContent).toContain('a.ts')
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
    // No file tab opens.
    expect(tabLabels(root)).toEqual([])
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
    expect(tabLabels(root)).toEqual([])
  })

  it('6 · draws its tabs with the shared editor tab bar (the terminal uses the same one)', async () => {
    const root = mount()
    await flush()
    treeRow(root, 'README.md').click()
    await flush()
    const strip = root.querySelector<HTMLElement>(
      '.files-main .workspace-tab-bar .ds-tabs',
    )!
    expect(strip.dataset.variant).toBe('editor')
    // The full path shows on hover; the tab closes with its own ×.
    expect(activeTab(root)?.getAttribute('title')).toBe('README.md')
    expect(
      root.querySelector(
        '.workspace-tab-bar button[aria-label="关闭 README.md"]',
      ),
    ).not.toBeNull()
    expect(root.querySelector('.file-tab')).toBeNull()
  })

  it('copies the relative or the absolute path from one menu', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    const root = mount()
    await flush()
    treeRow(root, 'README.md').click()
    await flush()
    // One button, not two.
    expect(root.querySelector('button[aria-label="复制相对路径"]')).toBeNull()
    expect(root.querySelector('button[aria-label="复制绝对路径"]')).toBeNull()
    const copy = () =>
      root.querySelector<HTMLButtonElement>('button[aria-label="复制路径"]')!
    copy().click()
    await flush()
    const items = () => [
      ...document.body.querySelectorAll<HTMLButtonElement>(
        '[role="menu"][aria-label="复制路径"] [role="menuitem"]',
      ),
    ]
    expect(items().map((item) => item.textContent?.trim())).toEqual([
      '复制相对路径',
      '复制绝对路径',
    ])
    items()[0]!.click()
    await flush()
    expect(writeText).toHaveBeenLastCalledWith('README.md')
    copy().click()
    await flush()
    items()[1]!.click()
    await flush()
    expect(writeText).toHaveBeenLastCalledWith('/tmp/demo/README.md')
  })

  it('names the Finder action and the size in Chinese', async () => {
    const root = mount()
    await flush()
    treeRow(root, 'README.md').click()
    await flush()
    expect(root.querySelector('.file-preview-meta')?.textContent).toContain(
      '24 字节',
    )
    expect(root.textContent).not.toContain('bytes')
    expect(root.textContent).not.toContain('Finder')
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

  it('8 · reopening an open tab rereads the file once its size or mtime changed', async () => {
    const disk = { content: 'const v = 1\n', bytes: 12, modifiedAt: 1_000 }
    core.mockImplementation((op: string, payload?: Record<string, unknown>) => {
      if (op === 'files.stat')
        return Promise.resolve({
          bytes: disk.bytes,
          modifiedAt: disk.modifiedAt,
        })
      if (op === 'files.preview')
        return Promise.resolve({
          id: 'file:/tmp/demo/src/a.ts',
          path: '/tmp/demo/src/a.ts',
          relativePath: 'src/a.ts',
          mimeType: 'text/plain',
          kind: 'text',
          name: 'a.ts',
          content: disk.content,
          truncated: false,
          bytes: disk.bytes,
          modifiedAt: disk.modifiedAt,
        })
      return fakeCore(op, payload)
    })
    const root = mount('')
    // A reply link to src/a.ts:1 (a reference) opens the tab.
    const link = {
      owner: 's1',
      target: {
        source: 'reference' as const,
        sessionId: 's1',
        referenceId: 'ref_src_a',
      },
    }
    await exposed.openPreview({ ...link, line: 1 })
    await flush()
    expect(root.querySelector('.file-code-view')?.textContent).toContain(
      'const v = 1',
    )
    const reads = () =>
      core.mock.calls.filter(([op]) => op === 'files.preview').length
    // Unchanged on disk: the tab shows again without a new read.
    await exposed.openPreview({ ...link, line: 1 })
    await flush()
    expect(core).toHaveBeenLastCalledWith('files.stat', link.target)
    expect(reads()).toBe(1)
    // Edited on disk: following a link to line 2 shows the new text there.
    disk.content = 'const v = 1\nconst w = 2\n'
    disk.bytes = 24
    disk.modifiedAt = 2_000
    await exposed.openPreview({ ...link, line: 2 })
    await flush()
    expect(reads()).toBe(2)
    expect(tabLabels(root)).toEqual(['a.ts'])
    expect(root.querySelector('.file-code-view')?.textContent).toContain(
      'const w = 2',
    )
    expect(
      root
        .querySelector('.file-code-line.reference-line-active')
        ?.getAttribute('data-line'),
    ).toBe('2')
    // Same size, newer mtime: still a change.
    disk.modifiedAt = 3_000
    await exposed.openPreview({ ...link, line: 2 })
    await flush()
    expect(reads()).toBe(3)
  })

  it('reopens a project tab after a failed stat by reading it (the reason shows)', async () => {
    let gone = false
    core.mockImplementation((op: string, payload?: Record<string, unknown>) => {
      if (op === 'files.stat')
        return gone
          ? Promise.reject(new Error('文件或目录不存在。'))
          : Promise.resolve({ bytes: 24, modifiedAt: 1 })
      if (op === 'files.preview' && gone)
        return Promise.reject(new Error('文件或目录不存在。'))
      return fakeCore(op, payload)
    })
    const root = mount('')
    const request = {
      owner: 's1',
      target: { source: 'project' as const, sessionId: 's1', path: 'a.ts' },
    }
    await exposed.openPreview(request)
    await flush()
    gone = true
    await exposed.openPreview(request)
    await flush()
    expect(root.textContent).toContain('文件或目录不存在。')
  })

  describe('BUG-05 · videos', () => {
    const URL_A = `app://workspace-media/${'1'.repeat(32)}`
    const URL_B = `app://workspace-media/${'2'.repeat(32)}`
    const request = {
      owner: 's1',
      target: {
        source: 'project' as const,
        sessionId: 's1',
        path: 'clips/飞行 测试.mp4',
      },
    }

    /** files.mediaUrl answers these in turn (the last one repeats). */
    function videoCore(...answers: Array<string | Error>) {
      return (operation: string, payload?: Record<string, unknown>) => {
        if (operation === 'files.preview')
          return Promise.resolve({
            id: 'file:/tmp/demo/clips/飞行 测试.mp4',
            path: '/tmp/demo/clips/飞行 测试.mp4',
            relativePath: 'clips/飞行 测试.mp4',
            mimeType: 'video/mp4',
            kind: 'video',
            name: '飞行 测试.mp4',
            truncated: false,
            bytes: 17_829,
          })
        if (operation === 'files.mediaUrl') {
          const answer = answers.length > 1 ? answers.shift()! : answers[0]!
          return answer instanceof Error
            ? Promise.reject(answer)
            : Promise.resolve({ url: answer })
        }
        return fakeCore(operation, payload)
      }
    }

    function mediaUrlCalls() {
      return core.mock.calls.filter(([op]) => op === 'files.mediaUrl')
    }

    afterEach(() => {
      delete (window as unknown as { emperor?: unknown }).emperor
    })

    it('7 · plays a video from its media address with the native controls', async () => {
      core.mockImplementation(videoCore(URL_A))
      const root = mount('')
      await exposed.openPreview(request)
      await flush()
      const video = root.querySelector<HTMLVideoElement>('video')!
      expect(video).not.toBeNull()
      expect(video.hasAttribute('controls')).toBe(true)
      expect(video.getAttribute('preload')).toBe('metadata')
      expect(video.getAttribute('src')).toBe(URL_A)
      expect(mediaUrlCalls()).toEqual([['files.mediaUrl', request.target]])
      expect(isProxy(mediaUrlCalls()[0]![1])).toBe(false)
      expect(root.textContent).not.toContain('此格式暂不支持内容预览')
      expect(root.querySelector('.file-preview-meta')?.textContent).toContain(
        'video/mp4',
      )
    })

    it('8 · a video that cannot play asks once more, then offers the default app', async () => {
      const openWorkspaceMedia = vi.fn(async () => ({ ok: true }))
      ;(window as unknown as { emperor: unknown }).emperor = {
        openWorkspaceMedia,
      }
      core.mockImplementation(videoCore(URL_A))
      const root = mount('')
      await exposed.openPreview(request)
      await flush()
      root.querySelector('video')!.dispatchEvent(new Event('error'))
      await flush()
      // The grant still runs (same address): the codec is the problem.
      expect(mediaUrlCalls()).toHaveLength(2)
      expect(root.querySelector('video')).toBeNull()
      expect(root.textContent).toContain('这个视频的编码无法在应用里播放')
      const open = [...root.querySelectorAll('button')].find((button) =>
        button.textContent?.includes('用默认应用打开'),
      )!
      open.click()
      await flush()
      expect(openWorkspaceMedia).toHaveBeenCalledWith(URL_A)
    })

    it('an address that expired while watching is asked for again', async () => {
      core.mockImplementation(videoCore(URL_A, URL_B))
      const root = mount('')
      await exposed.openPreview(request)
      await flush()
      root.querySelector('video')!.dispatchEvent(new Event('error'))
      await flush()
      expect(root.querySelector('video')?.getAttribute('src')).toBe(URL_B)
      expect(root.textContent).not.toContain('无法在应用里播放')
    })

    it('a video removed since it opened says the file is gone', async () => {
      const gone = Object.assign(new Error('文件或目录不存在。'), {
        code: 'workspace_path_missing',
      })
      core.mockImplementation(videoCore(URL_A, gone))
      const root = mount('')
      await exposed.openPreview(request)
      await flush()
      root.querySelector('video')!.dispatchEvent(new Event('error'))
      await flush()
      expect(root.querySelector('video')).toBeNull()
      expect(root.textContent).toContain('文件已不存在')
      expect(root.textContent).not.toContain('用默认应用打开')
    })
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

// BUG-11: the pane follows the project: the tree and open files refresh
// when files change, a deleted open file says so, and a failed watch falls
// back to refreshing when a turn ends.
describe('FilesPane follows the project (BUG-11)', () => {
  function disk() {
    const state = {
      entries: [...ENTRIES] as Array<Record<string, unknown>>,
      content: 'const a = 1\n',
      gone: false,
    }
    core.mockImplementation((op: string, payload?: Record<string, unknown>) => {
      if (op === 'files.list')
        return Promise.resolve({
          projectRoot: '/tmp/demo',
          relativePath: String(payload?.relativePath ?? ''),
          entries: payload?.relativePath ? [] : state.entries,
        })
      if (op === 'files.preview') {
        if (state.gone)
          return Promise.reject(
            Object.assign(new Error('文件或目录不存在。'), {
              code: 'workspace_path_missing',
            }),
          )
        const path = String(payload?.path ?? 'a.ts')
        return Promise.resolve({
          id: `file:/tmp/demo/${path}`,
          path: `/tmp/demo/${path}`,
          relativePath: path,
          mimeType: 'text/plain',
          kind: 'text',
          name: path.split('/').pop(),
          content: state.content,
          truncated: false,
          bytes: state.content.length,
          modifiedAt: 1,
        })
      }
      if (op === 'files.watch') return Promise.resolve({ watching: true })
      if (op === 'files.unwatch') return Promise.resolve({ watching: false })
      return fakeCore(op, payload)
    })
    return state
  }
  const calls = (op: string) => core.mock.calls.filter(([name]) => name === op)
  const change = (patch: Record<string, unknown>) =>
    emitCore({
      event: 'workspace_files_changed',
      session_id: 's1',
      paths: [],
      overflow: false,
      ...patch,
    })

  it('1 · watches the project while mounted and stops when unmounted', async () => {
    disk()
    mount()
    await flush()
    expect(calls('files.watch')).toEqual([['files.watch', { sessionId: 's1' }]])
    app!.unmount()
    app = null
    await flush()
    expect(calls('files.unwatch')).toEqual([
      ['files.unwatch', { sessionId: 's1' }],
    ])
  })

  it('2 · a new file shows in the tree without a manual refresh', async () => {
    const state = disk()
    const root = mount()
    await flush()
    state.entries = [...ENTRIES, { name: 'b.ts', path: 'b.ts', kind: 'file' }]
    change({ paths: ['b.ts'] })
    await flush()
    expect(treeRow(root, 'b.ts')).toBeTruthy()
  })

  it('3 · the open file re-reads when it changes on disk', async () => {
    const state = disk()
    const root = mount()
    await flush()
    await exposed.openPath('a.ts')
    await flush()
    state.content = 'const a = 2\n'
    change({ paths: ['a.ts'] })
    await flush()
    expect(root.querySelector('.file-code-view')?.textContent).toContain(
      'const a = 2',
    )
  })

  it('4 · a background tab is marked, and re-read when it is shown', async () => {
    const state = disk()
    const root = mount()
    await flush()
    await exposed.openPath('a.ts')
    await exposed.openPath('README.md')
    await flush()
    const reads = calls('files.preview').length
    state.content = 'const a = 3\n'
    change({ paths: ['a.ts'] })
    await flush()
    expect(calls('files.preview')).toHaveLength(reads)
    const tab = [
      ...root.querySelectorAll<HTMLElement>('.workspace-tab-bar .tab-item'),
    ].find((item) => item.textContent?.includes('a.ts'))!
    expect(tab.querySelector('[data-tab-mark]')).not.toBeNull()
    tab.querySelector<HTMLElement>('[role="tab"]')!.click()
    await flush()
    expect(calls('files.preview')).toHaveLength(reads + 1)
    expect(root.querySelector('.file-code-view')?.textContent).toContain(
      'const a = 3',
    )
  })

  it('5 · a deleted open file says so, keeps what was shown, and can be closed', async () => {
    const state = disk()
    const root = mount()
    await flush()
    await exposed.openPath('a.ts')
    await flush()
    state.gone = true
    change({ paths: ['a.ts'] })
    await flush()
    const banner = root.querySelector('[data-file-deleted]')
    expect(banner?.textContent).toContain('这个文件已被删除')
    expect(root.querySelector('.file-code-view')?.textContent).toContain(
      'const a = 1',
    )
    banner!.querySelector<HTMLButtonElement>('button')!.click()
    await flush()
    expect(tabLabels(root)).toEqual([])
  })

  it('6 · an overflow re-reads the loaded tree and the open file', async () => {
    const state = disk()
    mount()
    await flush()
    await exposed.openPath('a.ts')
    await flush()
    const lists = calls('files.list').length
    const reads = calls('files.preview').length
    state.content = 'changed'
    change({ overflow: true })
    await flush()
    expect(calls('files.list').length).toBeGreaterThan(lists)
    expect(calls('files.preview')).toHaveLength(reads + 1)
  })

  it('7 · changes of another session are ignored', async () => {
    disk()
    mount()
    await flush()
    const lists = calls('files.list').length
    emitCore({
      event: 'workspace_files_changed',
      session_id: 'other',
      paths: ['b.ts'],
      overflow: false,
    })
    await flush()
    expect(calls('files.list')).toHaveLength(lists)
  })

  it('8 · when the watch fails, a finished turn refreshes the tree instead', async () => {
    const state = disk()
    const root = mount()
    await flush()
    change({ overflow: true, unavailable: true })
    await flush()
    state.entries = [...ENTRIES, { name: 'c.ts', path: 'c.ts', kind: 'file' }]
    emitCore({ event: 'assistant_done', session_id: 's1' })
    await flush()
    expect(treeRow(root, 'c.ts')).toBeTruthy()
  })

  it('9 · moves the watch with the session', async () => {
    disk()
    mount()
    await flush()
    owner.value = 's2'
    app!.unmount()
    app = null
    container?.remove()
    mount()
    await flush()
    expect(calls('files.watch').map(([, input]) => input)).toEqual([
      { sessionId: 's1' },
      { sessionId: 's2' },
    ])
  })
})
