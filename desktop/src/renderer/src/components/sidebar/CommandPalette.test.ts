// @vitest-environment jsdom
// UI-S02 6: the rail's search opens a centered command palette that finds
// sessions by title at once and by what was said in them (Core
// `sessions.search`), keyboard first.
import { createApp, h, nextTick, ref, type App } from 'vue'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import CommandPalette from './CommandPalette.vue'

const mock = vi.hoisted(() => ({ core: vi.fn(), session: {} as any }))
vi.mock('../../api/http', () => ({ core: mock.core }))
vi.mock('../../composables/useSession', () => ({
  useSession: () => mock.session,
}))

let app: App | null = null
let root: HTMLDivElement | null = null
let router: Router
const open = ref(true)

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await nextTick()
  }
}

async function mount(): Promise<void> {
  router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/chat/:sessionId?', name: 'chat', component: {} }],
  })
  await router.push('/chat/a')
  root = document.createElement('div')
  document.body.append(root)
  open.value = true
  app = createApp(() =>
    h(CommandPalette, {
      open: open.value,
      'onUpdate:open': (value: boolean) => (open.value = value),
    }),
  )
  app.use(router)
  app.mount(root)
  await flush()
}

function input(): HTMLInputElement {
  return document.querySelector<HTMLInputElement>(
    '[data-testid="command-palette"] input',
  )!
}

function results(): string[] {
  return [
    ...document.querySelectorAll<HTMLElement>('[data-palette-result]'),
  ].map((item) => item.dataset.paletteResult ?? '')
}

async function type(text: string): Promise<void> {
  input().value = text
  input().dispatchEvent(new Event('input'))
  await flush()
}

function key(name: string): void {
  input().dispatchEvent(
    new KeyboardEvent('keydown', {
      key: name,
      bubbles: true,
      cancelable: true,
    }),
  )
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  mock.session = {
    sessions: ref([
      { id: 'a', title: '修复登录页移动端布局', mode: 'chat' },
      { id: 'b', title: '整理 0.2 发布说明', mode: 'chat' },
      { id: 'c', title: '周报提纲', mode: 'chat', archived_at: '2026-01-01' },
    ]),
  }
  mock.core.mockImplementation(async (key: string, input: any) => {
    if (key === 'sessions.search')
      return input.query === '发布'
        ? {
            hits: [
              {
                sessionId: 'z',
                title: '子智能体设置复核',
                role: 'assistant',
                snippet: '…下周的发布前要把这一项复核完…',
              },
            ],
          }
        : { hits: [] }
    return {}
  })
})

afterEach(() => {
  vi.useRealTimers()
  app?.unmount()
  app = null
  root?.remove()
  root = null
})

describe('CommandPalette (UI-S02 6)', () => {
  it('opens centered with the field focused', async () => {
    await mount()
    const palette = document.querySelector('[data-testid="command-palette"]')!
    expect(palette.getAttribute('role')).toBe('dialog')
    expect(document.activeElement).toBe(input())
  })

  it('finds titles at once and contents after a pause', async () => {
    await mount()
    await type('发布')
    expect(results()).toEqual(['b'])
    expect(mock.core).not.toHaveBeenCalledWith(
      'sessions.search',
      expect.anything(),
    )
    vi.advanceTimersByTime(250)
    await flush()
    expect(mock.core).toHaveBeenCalledWith('sessions.search', {
      query: '发布',
      limit: 20,
    })
    expect(results()).toEqual(['b', 'z'])
    const hit = document.querySelector('[data-palette-result="z"]')!
    expect(hit.textContent).toContain('子智能体设置复核')
    expect(hit.textContent).toContain('下周的发布前')
  })

  it('leaves archived sessions out of the title matches', async () => {
    await mount()
    await type('周报')
    expect(results()).toEqual([])
  })

  it('moves with the arrows and opens on Enter', async () => {
    await mount()
    await type('发布')
    vi.advanceTimersByTime(250)
    await flush()
    key('ArrowDown')
    await flush()
    expect(
      document
        .querySelector('[data-palette-result="z"]')
        ?.getAttribute('aria-selected'),
    ).toBe('true')
    key('Enter')
    await flush()
    expect(router.currentRoute.value.params.sessionId).toBe('z')
    expect(open.value).toBe(false)
  })

  it('closes on Escape', async () => {
    await mount()
    key('Escape')
    await flush()
    expect(open.value).toBe(false)
  })
})
