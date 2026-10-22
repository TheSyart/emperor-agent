// @vitest-environment jsdom
// UI-S03 (DSH-22): the one disclosure motion — 200ms height + opacity — and
// none at all under reduced motion.
import { createApp, h, nextTick, ref } from 'vue'
import { afterEach, describe, expect, it } from 'vitest'
import CollapseTransition from './CollapseTransition.vue'

const original = window.matchMedia
let app: ReturnType<typeof createApp> | null = null

afterEach(() => {
  app?.unmount()
  app = null
  window.matchMedia = original
})

function prefer(reduced: boolean): void {
  window.matchMedia = ((query: string) => ({
    matches: query.includes('reduce') ? reduced : false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof window.matchMedia
}

function mountBody(): {
  open: { value: boolean }
  body: () => HTMLElement | null
} {
  const open = ref(false)
  const host = document.createElement('div')
  document.body.append(host)
  app = createApp({
    render: () =>
      h(CollapseTransition, null, () =>
        open.value ? h('div', { class: 'body' }, 'steps') : null,
      ),
  })
  app.mount(host)
  return { open, body: () => host.querySelector<HTMLElement>('.body') }
}

describe('CollapseTransition', () => {
  it('animates height and opacity together', async () => {
    prefer(false)
    const { open, body } = mountBody()
    open.value = true
    await nextTick()
    const style = body()!.style
    expect(style.transition).toContain('height')
    expect(style.transition).toContain('opacity')
    expect(style.overflow).toBe('hidden')
  })

  it('has no motion under reduced motion', async () => {
    prefer(true)
    const { open, body } = mountBody()
    open.value = true
    await nextTick()
    expect(body()!.getAttribute('style') ?? '').toBe('')
    open.value = false
    await nextTick()
    expect(body()).toBeNull()
  })
})
