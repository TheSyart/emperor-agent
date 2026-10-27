// @vitest-environment jsdom
/**
 * GRP-04 / BRD-07: the avatar library picker — loaded only when it opens,
 * grouped by theme, searchable, the avatars other contacts use marked
 * 「在用」 and still selectable (card tests: 头像库按主题筛选和搜索).
 */
import { createApp, h, nextTick, ref, type App } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ContactAvatarEntry } from '../ui/contactAvatars'

const { loadManifest } = vi.hoisted(() => ({ loadManifest: vi.fn() }))
vi.mock('../ui/contactAvatars', async (original) => ({
  ...(await original<typeof import('../ui/contactAvatars')>()),
  loadContactAvatarManifest: loadManifest,
}))

const { default: AvatarLibraryPicker } =
  await import('./AvatarLibraryPicker.vue')

const MANIFEST: ContactAvatarEntry[] = [
  {
    id: 'AV-01-1',
    sheet: 'AV-01',
    rect: [0, 0, 192, 192],
    theme: 'engineering',
    label: '架构师',
    tint: '#E0D8EC',
  },
  {
    id: 'AV-01-2',
    sheet: 'AV-01',
    rect: [192, 0, 192, 192],
    theme: 'engineering',
    label: '代码审稿人',
    tint: '#ECDAD0',
  },
  {
    id: 'AV-07-1',
    sheet: 'AV-07',
    rect: [0, 0, 192, 192],
    theme: 'court-military',
    label: '将军',
    tint: '#D6E8DC',
  },
  {
    id: 'AV-10-3',
    sheet: 'AV-10',
    rect: [384, 0, 192, 192],
    theme: 'animals',
    label: '橘猫',
    tint: '#F0E4C8',
  },
]

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await nextTick()
  }
}

let app: App | null = null
let container: HTMLDivElement | null = null
const open = ref(false)
const selected = vi.fn()

function mount() {
  container = document.createElement('div')
  document.body.append(container)
  app = createApp(() =>
    h(AvatarLibraryPicker, {
      open: open.value,
      'onUpdate:open': (value: boolean) => (open.value = value),
      selected: 'AV-01-1',
      inUse: { 'AV-01-2': '审稿人' },
      onSelect: selected,
    }),
  )
  app.mount(container)
}

function cells(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[data-avatar-cell]')]
}

function cellIds(): string[] {
  return cells().map((cell) => cell.dataset.avatarCell ?? '')
}

function themeFilter(label: string): HTMLButtonElement {
  const found = [
    ...document.querySelectorAll<HTMLButtonElement>(
      '[data-avatar-theme] button',
    ),
  ].find((item) => item.textContent?.trim() === label)
  if (!found) throw new Error(`no theme ${label}`)
  return found
}

beforeEach(() => {
  open.value = false
  loadManifest.mockReset()
  loadManifest.mockResolvedValue(MANIFEST)
  selected.mockReset()
})

afterEach(() => {
  app?.unmount()
  container?.remove()
  app = null
  container = null
})

describe('AvatarLibraryPicker', () => {
  it('loads the library only when it opens', async () => {
    mount()
    await flush()
    expect(loadManifest).not.toHaveBeenCalled()
    open.value = true
    await flush()
    expect(loadManifest).toHaveBeenCalledTimes(1)
    expect(cellIds()).toEqual(['AV-01-1', 'AV-01-2', 'AV-07-1', 'AV-10-3'])
    expect(document.body.textContent).toContain('4 个')
  })

  it('filters by theme and searches by name or theme', async () => {
    mount()
    open.value = true
    await flush()
    themeFilter('武将').click()
    await flush()
    expect(cellIds()).toEqual(['AV-07-1'])
    expect(themeFilter('武将').getAttribute('aria-pressed')).toBe('true')
    const search = document.querySelector<HTMLInputElement>(
      'input[aria-label="搜索头像"]',
    )!
    search.value = '猫'
    search.dispatchEvent(new Event('input'))
    await flush()
    // A search looks through every theme.
    expect(cellIds()).toEqual(['AV-10-3'])
    expect(themeFilter('全部').getAttribute('aria-pressed')).toBe('true')
    search.value = '工程'
    search.dispatchEvent(new Event('input'))
    await flush()
    expect(cellIds()).toEqual(['AV-01-1', 'AV-01-2'])
    search.value = '没有这个'
    search.dispatchEvent(new Event('input'))
    await flush()
    expect(cellIds()).toEqual([])
    expect(document.body.textContent).toContain('没有找到')
  })

  it('marks the ones in use and still lets them be picked', async () => {
    mount()
    open.value = true
    await flush()
    const used = cells().find((cell) => cell.dataset.avatarCell === 'AV-01-2')!
    expect(used.textContent).toContain('在用')
    expect(used.getAttribute('title')).toContain('审稿人')
    expect(
      cells()
        .find((cell) => cell.dataset.avatarCell === 'AV-01-1')!
        .getAttribute('aria-selected'),
    ).toBe('true')
    used.click()
    await flush()
    expect(selected).toHaveBeenCalledWith('AV-01-2')
    expect(open.value).toBe(false)
  })
})
