// @vitest-environment jsdom
// UI-S07: 设置 › 用量 opens on the metrics and the trend; the heatmap, the
// model ranking and the cache view wait one click away, in 「详细」.
import { createApp, h, nextTick, ref, type App } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { APP_CONTEXT_KEY } from '../../composables/useAppContext'
import type { TokensPayload } from '../../types'
import TokensSection from './TokensSection.vue'
import {
  createSettingsHeader,
  SETTINGS_HEADER_KEY,
  type SettingsHeaderHost,
} from './settingsHeader'

const row = (input: number, output: number, cacheRead = 0, calls = 1) => ({
  input,
  output,
  cache_read: cacheRead,
  cache_create: 0,
  calls,
})

function payload(): TokensPayload {
  const model = {
    ...row(700, 340, 900, 4),
    provider: 'deepseek',
    model: 'deepseek-chat',
  }
  return {
    totals: row(700, 340, 900, 4),
    byDate: { '2026-10-18': row(700, 340, 900, 4) },
    byModel: { 'deepseek/deepseek-chat': model },
    byUsageType: { main_agent: row(700, 340, 900, 4) },
    byDateModel: { '2026-10-18': { 'deepseek/deepseek-chat': model } },
    byHour: { '14': row(700, 340) },
    streak: {} as TokensPayload['streak'],
    sessions: 2,
  } as unknown as TokensPayload
}

async function flushPromises(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await nextTick()
  }
}

let container: HTMLDivElement | null = null
let app: App | null = null

function mount(): { header: SettingsHeaderHost } {
  const header = createSettingsHeader()
  container = document.createElement('div')
  document.body.append(container)
  app = createApp(() => h(TokensSection))
  app.provide(APP_CONTEXT_KEY, {
    tokens: ref(payload()),
    tokensLoading: ref(false),
    loadTokens: vi.fn(async () => {}),
    runSafely: async (task: () => Promise<void>) => await task(),
  } as never)
  app.provide(SETTINGS_HEADER_KEY, header)
  app.mount(container)
  return { header }
}

function views(): string[] {
  return [...(container?.querySelectorAll('[data-view]') ?? [])].map(
    (view) => view.getAttribute('data-view') ?? '',
  )
}

afterEach(() => {
  app?.unmount()
  app = null
  container?.remove()
  container = null
})

describe('TokensSection (UI-S07)', () => {
  it('shows only the metrics and the trend by default', async () => {
    mount()
    await flushPromises()
    expect(
      container?.querySelector('[data-testid="token-metrics"]'),
    ).not.toBeNull()
    expect(views()).toEqual(['trend'])
    expect(container?.querySelector('[aria-label="用量视图"]')).toBeNull()
  })

  it('keeps the heatmap, the ranking and the cache view in 详细', async () => {
    const { header } = mount()
    await flushPromises()
    const details = container?.querySelector<HTMLButtonElement>(
      '[data-testid="usage-details"]',
    )
    expect(details?.textContent).toContain('详细')
    details?.click()
    await flushPromises()
    expect(header.page.value).toBe('details')
    expect(header.trail.value).toBe('详细')
    expect(
      [
        ...(container?.querySelectorAll(
          '[aria-label="用量视图"] [role="radio"]',
        ) ?? []),
      ].map((option) => option.textContent?.trim()),
    ).toEqual(['活跃度', '模型', '缓存'])
    expect(views()).toEqual(['activity'])
  })
})
