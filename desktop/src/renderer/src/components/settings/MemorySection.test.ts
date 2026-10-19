// @vitest-environment jsdom
import { createApp, h, nextTick, ref, type App } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { APP_CONTEXT_KEY } from '../../composables/useAppContext'
import type { MemoryPayload } from '../../types'
import MemorySection from './MemorySection.vue'
import {
  createSettingsHeader,
  SETTINGS_HEADER_KEY,
  type SettingsHeaderHost,
} from './settingsHeader'

async function flushPromises(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await nextTick()
  }
}

function memoryPayload(longTerm: string): MemoryPayload {
  return {
    long_term: longTerm,
    episodes: ['memory/episodes/2026-10-18.md'],
    watchlist: { content: '- [ ] 发布前检查', lastDecision: null },
    versions: {
      versions: [
        {
          id: 'v1',
          target: 'memory',
          path: 'memory/MEMORY.local.md',
          reason: 'save',
          createdAt: 1_760_000_000,
          size: 12,
        },
      ],
    },
  } as unknown as MemoryPayload
}

let container: HTMLDivElement | null = null
let app: App | null = null

function mount() {
  const boot = ref({ memory: memoryPayload('旧的长期记忆') })
  const ctx = {
    boot,
    configContent: ref('# 用户档案'),
    loadConfig: vi.fn(async () => {}),
    saveConfig: vi.fn(async () => {}),
    saveMemory: vi.fn(async () => {}),
    refreshMemory: vi.fn(async () => {}),
    loadEpisode: vi.fn(async (date: string) => ({ date, content: '情景' })),
    saveEpisode: vi.fn(async () => {}),
    saveWatchlist: vi.fn(async () => {}),
    checkWatchlist: vi.fn(async () => {}),
    restoreMemoryVersion: vi.fn(async () => {}),
    loadMemoryVersion: vi.fn(async () => ({ content: '旧的长期记忆' })),
    startProfileInterview: vi.fn(async () => {}),
    runSafely: vi.fn(async (task: () => Promise<void>) => await task()),
  }
  const header: SettingsHeaderHost = createSettingsHeader()
  container = document.createElement('div')
  document.body.append(container)
  app = createApp(() => h(MemorySection))
  app.provide(APP_CONTEXT_KEY, ctx as never)
  app.provide(SETTINGS_HEADER_KEY, header)
  app.mount(container)
  return { ctx, boot, header }
}

function tabLabels(): string[] {
  return [
    ...(container?.querySelectorAll('[aria-label="记忆类型"] [role="radio"]') ??
      []),
  ].map((tab) => tab.textContent?.trim() ?? '')
}

function editor(): HTMLTextAreaElement | null {
  return container?.querySelector('textarea') ?? null
}

afterEach(() => {
  app?.unmount()
  app = null
  container?.remove()
  container = null
})

describe('MemorySection (UI-S07)', () => {
  it('has two tabs, 长期记忆 and 用户档案', async () => {
    mount()
    await flushPromises()
    expect(tabLabels()).toEqual(['长期记忆', '用户档案'])
  })

  it('opens the version list from the editor’s 历史 button', async () => {
    const { header } = mount()
    await flushPromises()
    expect(container?.querySelector('[data-version-id]')).toBeNull()
    const history = container?.querySelector<HTMLButtonElement>(
      '[data-testid="memory-history"]',
    )
    expect(history?.textContent?.trim()).toBe('历史')
    history?.click()
    await flushPromises()
    expect(header.page.value).toBe('history')
    expect(header.trail.value).toBe('历史')
    expect(container?.querySelector('[data-version-id="v1"]')).not.toBeNull()
    expect(editor()).toBeNull()
  })

  it('keeps 情景记忆 and Watchlist one menu away', async () => {
    const { header } = mount()
    await flushPromises()
    const more = header.actions.value.find((action) => action.id === 'more')
    expect(more?.menu?.map((item) => item.label)).toEqual([
      '情景记忆',
      'Watchlist',
    ])
    more?.menu?.find((item) => item.id === 'watchlist')?.onSelect()
    await flushPromises()
    expect(header.page.value).toBe('watchlist')
    expect(editor()?.value).toBe('- [ ] 发布前检查')
  })

  it('has no refresh action: memory refreshes after every turn', async () => {
    const { header } = mount()
    await flushPromises()
    expect(header.actions.value.map((action) => action.id)).not.toContain(
      'refresh',
    )
  })

  it('keeps an edited draft when memory refreshes in the background', async () => {
    const { boot } = mount()
    await flushPromises()
    const textarea = editor()
    expect(textarea?.value).toBe('旧的长期记忆')
    textarea!.value = '我的修改'
    textarea!.dispatchEvent(new Event('input'))
    await nextTick()

    boot.value = { memory: memoryPayload('后台写入的长期记忆') }
    await flushPromises()
    expect(editor()?.value).toBe('我的修改')
    expect(container?.textContent).toContain('未保存')
  })

  it('takes a background refresh while the draft is untouched', async () => {
    const { boot } = mount()
    await flushPromises()
    boot.value = { memory: memoryPayload('后台写入的长期记忆') }
    await flushPromises()
    expect(editor()?.value).toBe('后台写入的长期记忆')
    expect(container?.textContent).not.toContain('未保存')
  })
})
