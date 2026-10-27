// @vitest-environment jsdom
/**
 * BRD-05 朱批: after the user allows an action, the skin's `approved`
 * picture (the 「单」 seal) shows for a moment beside the composer. It is
 * never on the permission card, never replaces its words, and a deny or a
 * send that did not go out stamps nothing.
 */
import { createApp, h, nextTick, ref, type App } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SkinView } from '../../../shared/skin-contract'
import type { ControlInteraction } from '../types'

const ZHUPI: SkinView = {
  id: 'zhupi',
  name: '朱批',
  author: '',
  license: '',
  description: '',
  official: true,
  base: 'light',
  tokens: {},
  reset: { light: {} },
  fonts: { heading: 'songti' },
  slots: { approved: 'app://skin/zhupi/seal.webp?v=1' },
  preview: {},
}
const PLAIN: SkinView = { ...ZHUPI, id: 'richang', base: 'auto', slots: {} }

const permission = {
  id: 'ask_1',
  kind: 'ask',
  questions: [
    {
      id: 'permission',
      header: '权限',
      question: '允许执行吗？',
      options: [
        { id: 'allow_once', label: '允许本次' },
        { id: 'deny', label: '拒绝' },
      ],
    },
  ],
  meta: {
    interaction_type: 'permission',
    permission: {
      operations: [{ tool_name: 'bash', risk: 'low', summary: 'ls' }],
    },
  },
} as unknown as ControlInteraction

let app: App | null = null
let container: HTMLDivElement | null = null

async function mount(
  render: () => ReturnType<typeof h>,
  send = vi.fn(() => true),
) {
  const { APP_CONTEXT_KEY } = await import('../composables/useAppContext')
  container = document.createElement('div')
  document.body.append(container)
  app = createApp({ render })
  app.provide(APP_CONTEXT_KEY, {
    boot: ref({}),
    sendInteractionAnswer: send,
  } as never)
  app.mount(container)
  await nextTick()
  return { root: container, send }
}

function click(root: HTMLElement, text: string): void {
  ;[...root.querySelectorAll('button')]
    .find((button) => button.textContent?.trim() === text)!
    .click()
}

beforeEach(() => {
  vi.resetModules()
  localStorage.clear()
  ;(window as unknown as { emperor?: unknown }).emperor = {
    skinGet: async (id: string) => ({
      ok: true,
      skin: id === 'zhupi' ? ZHUPI : PLAIN,
    }),
  }
})

afterEach(async () => {
  vi.useRealTimers()
  app?.unmount()
  container?.remove()
  app = null
  ;(await import('./skinState')).resetSkinForTests()
})

describe('the 「单」 seal', () => {
  it('counts an allow, not a deny or a send that failed', async () => {
    const state = await import('./skinState')
    const { default: ApprovalPanel } =
      await import('../components/conversation/takeover/ApprovalPanel.vue')
    const { root } = await mount(() =>
      h(ApprovalPanel, { interaction: permission }),
    )
    click(root, '拒绝')
    expect(state.approvals.value).toBe(0)
    app!.unmount()
    container!.remove()
    const failed = await mount(
      () => h(ApprovalPanel, { interaction: permission }),
      vi.fn(() => false),
    )
    click(failed.root, '允许本次')
    expect(state.approvals.value).toBe(0)
    app!.unmount()
    container!.remove()
    const ok = await mount(() => h(ApprovalPanel, { interaction: permission }))
    click(ok.root, '允许本次')
    expect(state.approvals.value).toBe(1)
    // The card's words stay its own.
    expect(
      ok.root.querySelector('[data-takeover="approval"]')?.textContent,
    ).toContain('允许本次')
    expect(ok.root.querySelector('[data-takeover="approval"] img')).toBeNull()
  })

  it('shows for a moment after an allow when the skin has one', async () => {
    vi.useFakeTimers()
    const state = await import('./skinState')
    const { default: SkinStamp } = await import('./SkinStamp.vue')
    state.initSkin()
    await state.selectSkin('zhupi')
    const { root } = await mount(() => h(SkinStamp))
    expect(root.querySelector('img')).toBeNull()
    state.markApproved()
    await nextTick()
    const img = root.querySelector<HTMLImageElement>(
      'img[data-skin-slot="approved"]',
    )!
    expect(img.getAttribute('src')).toBe('app://skin/zhupi/seal.webp?v=1')
    expect(img.getAttribute('aria-hidden')).toBe('true')
    vi.advanceTimersByTime(1600)
    await nextTick()
    expect(root.querySelector('img')).toBeNull()
  })

  it('shows nothing with a skin that has no seal', async () => {
    const state = await import('./skinState')
    const { default: SkinStamp } = await import('./SkinStamp.vue')
    state.initSkin()
    await state.selectSkin('richang')
    const { root } = await mount(() => h(SkinStamp))
    state.markApproved()
    await nextTick()
    expect(root.querySelector('img')).toBeNull()
  })
})
