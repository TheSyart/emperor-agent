// @vitest-environment jsdom
import { createApp, h, nextTick, ref, type App } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Modal from './Modal.vue'
import { modalLayerCount, pushModalLayer } from './modalStack'

function escape(target: EventTarget = document.body): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key: 'Escape',
    bubbles: true,
    cancelable: true,
  })
  target.dispatchEvent(event)
  return event
}

const cleanups: Array<() => void> = []

afterEach(() => {
  while (cleanups.length) cleanups.pop()?.()
  document.body.innerHTML = ''
})

function mountModal(props: { closable?: boolean } = {}) {
  const open = ref(true)
  const host = document.createElement('div')
  document.body.append(host)
  const app: App = createApp(() =>
    h(Modal, {
      ...props,
      open: open.value,
      'onUpdate:open': (value: boolean) => (open.value = value),
      title: 'Dialog',
    }),
  )
  app.mount(host)
  cleanups.push(() => app.unmount())
  return open
}

describe('modal stack', () => {
  it('hands Escape to the topmost layer only and marks it handled', () => {
    const below = vi.fn()
    const above = vi.fn()
    cleanups.push(pushModalLayer({ onEscape: below }))
    const popAbove = pushModalLayer({ onEscape: above })
    cleanups.push(popAbove)

    expect(escape().defaultPrevented).toBe(true)
    expect(above).toHaveBeenCalledTimes(1)
    expect(below).not.toHaveBeenCalled()

    popAbove()
    escape()
    expect(below).toHaveBeenCalledTimes(1)
  })

  it('ignores Escape an inner control already handled and other keys', () => {
    const layer = vi.fn()
    cleanups.push(pushModalLayer({ onEscape: layer }))
    const handled = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    })
    handled.preventDefault()
    document.body.dispatchEvent(handled)
    document.body.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    )
    expect(layer).not.toHaveBeenCalled()
  })

  it('stops listening once the last layer is gone', () => {
    const layer = vi.fn()
    const pop = pushModalLayer({ onEscape: layer })
    expect(modalLayerCount()).toBe(1)
    pop()
    pop()
    expect(modalLayerCount()).toBe(0)
    expect(escape().defaultPrevented).toBe(false)
    expect(layer).not.toHaveBeenCalled()
  })
})

describe('Modal Escape', () => {
  it('closes only the most recently opened Modal', async () => {
    const first = mountModal()
    const second = mountModal()
    await nextTick()
    expect(modalLayerCount()).toBe(2)

    escape()
    await nextTick()
    expect(second.value).toBe(false)
    expect(first.value).toBe(true)
    expect(modalLayerCount()).toBe(1)

    escape()
    await nextTick()
    expect(first.value).toBe(false)
    expect(modalLayerCount()).toBe(0)
  })

  it('swallows Escape when the top Modal is not closable', async () => {
    const below = vi.fn()
    cleanups.push(pushModalLayer({ onEscape: below }))
    const open = mountModal({ closable: false })
    await nextTick()
    expect(escape().defaultPrevented).toBe(true)
    await nextTick()
    expect(open.value).toBe(true)
    expect(below).not.toHaveBeenCalled()
  })

  it('leaves the stack when unmounted while open', async () => {
    mountModal()
    await nextTick()
    expect(modalLayerCount()).toBe(1)
    cleanups.pop()?.()
    expect(modalLayerCount()).toBe(0)
  })
})
