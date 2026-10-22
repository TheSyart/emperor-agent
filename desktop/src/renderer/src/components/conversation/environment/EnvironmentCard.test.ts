// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createApp, h, nextTick, ref, type App } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EMPTY_CHAT_SNAPSHOT } from '../../../conversation/chatSnapshot'
import type { ChatNode, ChatSnapshot } from '../../../conversation/types'
import type { DisplayResource } from '../resources/resourceModel'

// UI-S13: tests pick the card's sources; the rest reads the real index.
const resources = vi.hoisted(() => ({
  sources: null as DisplayResource[] | null,
}))
vi.mock('../resources/resourceIndex', async (importOriginal) => {
  const real =
    await importOriginal<typeof import('../resources/resourceIndex')>()
  return {
    ...real,
    resourcesFromSnapshot: (
      ...args: Parameters<typeof real.resourcesFromSnapshot>
    ) =>
      resources.sources === null
        ? real.resourcesFromSnapshot(...args)
        : { sources: resources.sources, outputs: [] },
  }
})
const { openResourceImages } = vi.hoisted(() => ({
  openResourceImages: vi.fn(),
}))
vi.mock('../resources/resourceImages', () => ({ openResourceImages }))

vi.mock('../../../api/http', () => ({ core: async () => [] }))
vi.mock('../../../composables/useAppContext', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../../../composables/useAppContext')
  >()),
  useAppContext: () => ({ boot: ref(null), showError: () => undefined }),
}))
vi.mock('vue-router', () => ({
  useRouter: () => ({ push: async () => undefined }),
  useRoute: () => ({ params: {}, query: {}, path: '/chat/s1', name: 'chat' }),
}))
import EnvironmentCard from './EnvironmentCard.vue'
import {
  consumeWorkspaceRequest,
  workspaceRequest,
} from '../../workspace/workspaceState'
import type { SourcesViewState } from './sourcesModel'
import { resetFrameStateForTest, useFrameState } from '../../shell/frameState'
import { previewLayout } from '../computer-use/computerUsePreviewState'

let app: App | undefined
let element: HTMLDivElement | undefined
afterEach(() => {
  app?.unmount()
  element?.remove()
  document.body.innerHTML = ''
  resources.sources = null
  openResourceImages.mockReset()
  const pending = workspaceRequest().value
  if (pending) consumeWorkspaceRequest(pending)
  resetFrameStateForTest()
  previewLayout.reservedHeight = 0
})

const written: ChatNode = {
  key: 'tool:write',
  kind: 'tool',
  id: 'write',
  target: 'chat',
  anchorSeq: 1,
  visibility: 'visible',
  turn: 1,
  step: 1,
  data: {
    callId: 'write',
    name: 'write',
    argsRaw: '{}',
    turn: 1,
    step: 1,
    time: 0,
    status: 'settled',
    approvals: [],
    result: {
      seq: 2,
      time: 1,
      content: [{ type: 'text', text: 'created' }],
      isError: false,
      meta: { operation: 'create', path: '/work/report.pdf' },
    },
  },
}

const snapshot = ref<ChatSnapshot>(EMPTY_CHAT_SNAPSHOT)

function mount(props: Record<string, unknown> = {}) {
  snapshot.value = {
    ...EMPTY_CHAT_SNAPSHOT,
    order: [written.key],
    nodes: new Map([[written.key, written]]),
  }
  element = document.createElement('div')
  document.body.append(element)
  app = createApp({
    render: () =>
      h(EnvironmentCard, {
        sessionId: 's1',
        snapshot: snapshot.value,
        ...props,
      }),
  })
  app.mount(element)
}

function file(
  id: string,
  provenance: DisplayResource['provenance'],
  patch: Partial<DisplayResource> = {},
): DisplayResource {
  return {
    id,
    kind: 'file',
    href: `/work/${id}`,
    label: id,
    subtitle: `/work/${id}`,
    sourceMessageId: 'm1',
    role: 'source',
    provenance,
    ...patch,
  }
}

const FIVE = [
  file('hit.html', 'discovered', {
    kind: 'web',
    href: 'https://example.com/hit',
    subtitle: 'example.com',
  }),
  file('main.js', 'read'),
  file('cited.md', 'cited'),
  file('需求说明.md', 'provided'),
  file('Tank.js', 'read'),
]

/** Each listed source as 「name word」. */
function sourceItems(): string[] {
  return [...element!.querySelectorAll<HTMLElement>('[data-source-item]')].map(
    (row) =>
      `${row.querySelector('.label')!.textContent!.trim()} ${row.querySelector('.value')!.textContent!.trim()}`,
  )
}

/** The 来源 view the card asked the workbench to show. */
function requestedView(): SourcesViewState {
  const view = workspaceRequest().value?.view
  return view!.props.value.view as SourcesViewState
}

/** The section head as 「label count」. */
function sourcesHead(): string {
  const head = element!.querySelector('[data-section="sources"] .sources-head')!
  return [...head.children].map((part) => part.textContent!.trim()).join(' ')
}

async function settle() {
  for (let i = 0; i < 6; i++) await nextTick()
}

describe('EnvironmentCard (UI-S05: a read-only summary)', () => {
  it('UI-S16: stops above the composer stack and the preview in CSS, unmeasured', async () => {
    const source = readFileSync(
      resolve(__dirname, 'EnvironmentCard.vue'),
      'utf8',
    )
    expect(source).toContain(
      'max-height: calc(\n    100% - var(--space-3) -\n      max(var(--space-4), var(--env-card-reserve, 0px))\n  );',
    )
    expect(source).not.toContain('ResizeObserver')
    previewLayout.reservedHeight = 208
    mount()
    await nextTick()
    const card = document.querySelector<HTMLElement>('.environment-card')!
    expect(card.style.maxHeight).toBe('')
    expect(card.style.getPropertyValue('--env-card-reserve')).toBe('208px')
    previewLayout.reservedHeight = 0
    await nextTick()
    expect(card.style.getPropertyValue('--env-card-reserve')).toBe('0px')
  })

  it('stays within 600 lines', () => {
    const source = readFileSync(
      resolve(__dirname, 'EnvironmentCard.vue'),
      'utf8',
    )
    expect(source.split('\n').length).toBeLessThanOrEqual(600)
  })

  it('keeps three entries in 「⋯」 and none of the Git writes', async () => {
    const onClose = vi.fn()
    mount({ onClose })
    await settle()
    element!
      .querySelector<HTMLButtonElement>('[aria-label="更多操作"]')!
      .click()
    await settle()
    const items = [...document.querySelectorAll('[role="menuitem"]')].map(
      (item) => item.textContent?.trim(),
    )
    expect(items).toEqual(['复制项目路径', '在访达中显示', '隐藏此卡片'])
    // Without a project the path entries are there but unavailable.
    const [copy, reveal, hide] =
      document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')
    expect(copy.disabled).toBe(true)
    expect(reveal.disabled).toBe(true)
    hide.click()
    await settle()
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('drops the 输出 row: what a turn wrote is in its files card (UI-S13)', async () => {
    mount({ hasMore: true })
    await settle()
    // The written file is an output, and outputs have no row any more.
    expect(element!.querySelector('[data-row="outputs"]')).toBeNull()
    expect(element!.querySelector('[data-section="sources"]')).toBeNull()
    expect(element!.querySelector('.card-body')!.textContent).not.toContain(
      '输出',
    )
  })

  it('lists at most three sources: yours, then read, then search hits (UI-S13)', async () => {
    resources.sources = FIVE
    mount()
    await settle()
    const section = element!.querySelector('[data-section="sources"]')!
    expect(sourcesHead()).toBe('来源 5')
    expect(sourceItems()).toEqual([
      '需求说明.md 提供的参考',
      'main.js 已查看',
      'Tank.js 已查看',
    ])
    const all = section.querySelector<HTMLButtonElement>(
      '[data-row="sources-all"]',
    )!
    expect(all.textContent!.trim()).toBe('查看全部 5 个')
    // The old summary row and its menu are gone.
    expect(element!.querySelector('[data-row="sources"]')).toBeNull()
    expect(element!.querySelector('[data-resource-face]')).toBeNull()
  })

  it('shows no 查看全部 for three sources or fewer (UI-S13)', async () => {
    resources.sources = FIVE.slice(0, 3)
    mount()
    await settle()
    expect(sourceItems()).toEqual([
      'main.js 已查看',
      'hit.html 搜索命中',
      'cited.md 已引用',
    ])
    expect(element!.querySelector('[data-row="sources-all"]')).toBeNull()
  })

  it('opens a source as before: an image in the lightbox, anything else in its detail (UI-S13)', async () => {
    const image = file('shot.png', 'provided', {
      kind: 'image',
      href: 'attachment:a1',
      attachmentId: 'a1',
      subtitle: 'image/png',
    })
    resources.sources = [image, ...FIVE]
    const details: unknown[] = []
    const listen = (event: Event) => details.push((event as CustomEvent).detail)
    window.addEventListener('emperor:resource-detail', listen)
    mount()
    await settle()
    const rows =
      element!.querySelectorAll<HTMLButtonElement>('[data-source-item]')
    expect(rows[0]!.querySelector('img')).not.toBeNull()
    rows[0]!.click()
    expect(openResourceImages).toHaveBeenCalledWith(
      image,
      's1',
      expect.arrayContaining([image]),
    )
    rows[1]!.click()
    window.removeEventListener('emperor:resource-detail', listen)
    expect(details).toEqual([{ resource: FIVE[3], sessionId: 's1' }])
  })

  it('查看全部 opens the 来源 view in the workbench and keeps the pane (UI-S13)', async () => {
    const frame = useFrameState()
    frame.workspacePane = 'files'
    frame.workspace = 0
    resources.sources = FIVE
    mount()
    await settle()
    element!
      .querySelector<HTMLButtonElement>('[data-row="sources-all"]')!
      .click()
    await settle()
    const request = workspaceRequest().value!
    // No pane asked for: the workbench keeps the one used last.
    expect(request.pane).toBe('launcher')
    expect(request.view).toMatchObject({ sessionId: 's1', title: '来源' })
    const view = requestedView()
    expect(view.sessionId).toBe('s1')
    expect(view.hasMore).toBe(false)
    expect(view.sources.map((item) => item.id)).toEqual([
      '需求说明.md',
      'main.js',
      'Tank.js',
      'hit.html',
      'cited.md',
    ])
    expect(frame.workspace).toBeGreaterThan(0)
    // A temporary view: the remembered pane does not change.
    expect(frame.workspacePane).toBe('files')
    // The open view follows the card's list as the chat goes on.
    resources.sources = [...FIVE, file('new.ts', 'read')]
    snapshot.value = { ...snapshot.value, order: [...snapshot.value.order] }
    await settle()
    expect(requestedView().sources).toHaveLength(6)
  })

  it('says 已加载 while older history is not loaded (UI-S13)', async () => {
    resources.sources = FIVE
    mount({ hasMore: true })
    await settle()
    const section = element!.querySelector('[data-section="sources"]')!
    expect(sourcesHead()).toBe('已加载来源 5')
    expect(
      section.querySelector('[data-row="sources-all"]')!.textContent!.trim(),
    ).toBe('查看已加载的 5 个')
    section
      .querySelector<HTMLButtonElement>('[data-row="sources-all"]')!
      .click()
    await settle()
    expect(requestedView().hasMore).toBe(true)
  })
})
