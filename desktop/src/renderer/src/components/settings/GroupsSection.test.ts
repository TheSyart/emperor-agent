// @vitest-environment jsdom
/**
 * GRP-08 (D14): 设置 › 群聊 — the collaboration a new group starts with
 * (自主 by default, or 主持人审核) and the loop guard (on by default). New
 * groups start from these; an existing group keeps its own (Core).
 */
import { createApp, h, nextTick, type App } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { APP_CONTEXT_KEY } from '../../composables/useAppContext'
import { createSettingsHeader, SETTINGS_HEADER_KEY } from './settingsHeader'

const { core } = vi.hoisted(() => ({ core: vi.fn() }))
vi.mock('../../api/http', () => ({ core }))

const { default: GroupsSection } = await import('./GroupsSection.vue')

let app: App | null = null
let container: HTMLDivElement | null = null
const showError = vi.fn()

async function settle(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve()
  await nextTick()
}

async function mount(): Promise<HTMLDivElement> {
  container = document.createElement('div')
  document.body.append(container)
  app = createApp({ render: () => h(GroupsSection) })
  app.provide(APP_CONTEXT_KEY, { showError, showToast: vi.fn() } as never)
  app.provide(SETTINGS_HEADER_KEY, createSettingsHeader())
  app.mount(container)
  await settle()
  return container
}

let saved = { collaboration: 'autonomous', loopGuard: true }

beforeEach(() => {
  saved = { collaboration: 'autonomous', loopGuard: true }
  showError.mockReset()
  core.mockReset()
  core.mockImplementation(
    async (op: string, change?: Record<string, unknown>) => {
      if (op === 'groups.defaults') return saved
      if (op === 'groups.setDefaults') {
        saved = { ...saved, ...change }
        return saved
      }
      throw new Error(`unexpected ${op}`)
    },
  )
})

afterEach(() => {
  app?.unmount()
  container?.remove()
  app = null
  container = null
})

describe('设置 › 群聊', () => {
  it('shows the defaults a new group starts with', async () => {
    const root = await mount()
    expect(root.textContent).toContain('新群的默认设置')
    expect(root.textContent).toContain('已有的群不变')
    const autonomous = root.querySelector<HTMLElement>(
      '[data-default-collaboration="autonomous"]',
    )!
    expect(autonomous.getAttribute('aria-checked')).toBe('true')
    expect(
      root
        .querySelector('[data-default="loopGuard"] [role="switch"]')
        ?.getAttribute('aria-checked'),
    ).toBe('true')
  })

  it('saves the collaboration and the loop guard', async () => {
    const root = await mount()
    root
      .querySelector<HTMLElement>('[data-default-collaboration="moderated"]')!
      .click()
    await settle()
    root
      .querySelector<HTMLElement>('[data-default="loopGuard"] [role="switch"]')!
      .click()
    await settle()
    expect(
      core.mock.calls.filter(([op]) => op === 'groups.setDefaults'),
    ).toEqual([
      ['groups.setDefaults', { collaboration: 'moderated' }],
      ['groups.setDefaults', { loopGuard: false }],
    ])
    expect(
      root
        .querySelector('[data-default-collaboration="moderated"]')
        ?.getAttribute('aria-checked'),
    ).toBe('true')
  })

  it('says when a change could not be saved and goes back', async () => {
    core.mockImplementation(async (op: string) => {
      if (op === 'groups.defaults') return saved
      throw new Error('磁盘满了')
    })
    const root = await mount()
    root
      .querySelector<HTMLElement>('[data-default="loopGuard"] [role="switch"]')!
      .click()
    await settle()
    expect(showError).toHaveBeenCalled()
    expect(
      root
        .querySelector('[data-default="loopGuard"] [role="switch"]')
        ?.getAttribute('aria-checked'),
    ).toBe('true')
  })
})
