// @vitest-environment jsdom
/**
 * UI-S04: the profile-interview prompt no longer sits above the composer
 * of every chat. It shows once, on the hero of an empty chat, while the
 * interview is pending; after that it lives in 设置 › 记忆 › 用户档案.
 */
import { createApp, h, nextTick, ref, type App } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  APP_CONTEXT_KEY,
  type AppContext,
} from '../../composables/useAppContext'
import type { ProfileOnboardingStatus } from '../../types'
import HeroProfilePrompt from './HeroProfilePrompt.vue'
import { PROFILE_PROMPT_KEY, resetProfilePromptForTest } from './profilePrompt'

let app: App | null = null
let host: HTMLDivElement | null = null

function context(status: ProfileOnboardingStatus = 'pending') {
  return {
    boot: ref({
      profileOnboarding: {
        status,
        sessionId: null,
        interactionId: null,
        attemptCount: 0,
        lastError: null,
        canStart: status === 'pending' || status === 'skipped',
        canSkip: status === 'pending',
      },
    }),
    startProfileInterview: vi.fn(async () => undefined),
    skipProfileInterview: vi.fn(async () => undefined),
    runSafely: async (task: () => Promise<void>) => {
      await task()
    },
  }
}

function mount(
  sessionId: string,
  ctx = context(),
  props: Record<string, unknown> = {},
) {
  app?.unmount()
  host?.remove()
  host = document.createElement('div')
  document.body.append(host)
  app = createApp({
    render: () => h(HeroProfilePrompt, { sessionId, ...props }),
  })
  app.provide(APP_CONTEXT_KEY, ctx as unknown as AppContext)
  app.mount(host)
  return { root: host, ctx }
}

function prompt(root: HTMLElement): HTMLElement | null {
  return root.querySelector<HTMLElement>('.hero-profile-prompt')
}

function button(root: HTMLElement, label: string): HTMLButtonElement {
  const found = [...root.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => item.textContent?.trim() === label,
  )
  if (!found) throw new Error(`no ${label} button`)
  return found
}

beforeEach(() => {
  localStorage.clear()
  resetProfilePromptForTest()
})

afterEach(() => {
  app?.unmount()
  app = null
  host?.remove()
  host = null
})

describe('the profile-interview prompt on the hero', () => {
  it('offers the interview on the hero of an empty chat', async () => {
    const { root, ctx } = mount('chat-a')
    await nextTick()
    expect(prompt(root)?.textContent).toContain('补充个人偏好')
    button(root, '开始访谈').click()
    await nextTick()
    expect(ctx.startProfileInterview).toHaveBeenCalledOnce()
    button(root, '不再提醒').click()
    await nextTick()
    expect(ctx.skipProfileInterview).toHaveBeenCalledOnce()
  })

  it('shows once: on the first hero only, and never after a restart', async () => {
    expect(prompt(mount('chat-a').root)).not.toBeNull()
    await nextTick()
    // Another empty chat in the same window: no prompt.
    expect(prompt(mount('chat-b').root)).toBeNull()
    // Back on the first one, it is still there until answered.
    expect(prompt(mount('chat-a').root)).not.toBeNull()
    expect(localStorage.getItem(PROFILE_PROMPT_KEY)).toBe('shown')
    // The next launch remembers it was shown.
    resetProfilePromptForTest({ keepStorage: true })
    expect(prompt(mount('chat-c').root)).toBeNull()
    expect(prompt(mount('chat-a').root)).toBeNull()
  })

  it('stays away unless the interview is pending and nothing waits for an answer', async () => {
    expect(prompt(mount('chat-a', context('completed')).root)).toBeNull()
    expect(prompt(mount('chat-a', context('skipped')).root)).toBeNull()
    expect(
      prompt(mount('chat-a', context('pending'), { blocked: true }).root),
    ).toBeNull()
    // None of those used up the one showing.
    expect(prompt(mount('chat-a').root)).not.toBeNull()
  })
})
