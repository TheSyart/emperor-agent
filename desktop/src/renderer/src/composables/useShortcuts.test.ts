// @vitest-environment jsdom
import { createApp, defineComponent, h, type App } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { pushModalLayer } from '../components/ui/modalStack'
import { isEditableTarget, useShortcuts } from './useShortcuts'

let app: App | null = null
let host: HTMLElement | null = null
const files = vi.fn()

beforeEach(() => {
  // jsdom reports no platform: the matcher runs its Ctrl (non-mac) table.
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Win32')
  files.mockReset()
  host = document.createElement('div')
  document.body.append(host)
  app = createApp(
    defineComponent({
      setup() {
        useShortcuts({ 'workspace.files': files })
        return () => h('input', { class: 'field' })
      },
    }),
  )
  app.mount(host)
})

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
  vi.restoreAllMocks()
})

function press(target: EventTarget, init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    ...init,
  })
  target.dispatchEvent(event)
  return event
}

describe('useShortcuts', () => {
  it('runs the bound handler from a text field and claims the key', () => {
    const input = host!.querySelector('input')!
    const inner = vi.fn()
    input.addEventListener('keydown', inner)
    const event = press(input, { key: 'p', code: 'KeyP', ctrlKey: true })
    expect(files).toHaveBeenCalledTimes(1)
    expect(event.defaultPrevented).toBe(true)
    // Capture phase: the field itself never sees the handled key.
    expect(inner).not.toHaveBeenCalled()
  })

  it('ignores unbound and unmodified keys', () => {
    const input = host!.querySelector('input')!
    const plain = press(input, { key: 'p', code: 'KeyP' })
    const other = press(input, { key: 'z', code: 'KeyZ', ctrlKey: true })
    expect(files).not.toHaveBeenCalled()
    expect(plain.defaultPrevented).toBe(false)
    expect(other.defaultPrevented).toBe(false)
  })

  it('stays out of the way while a modal layer is open', () => {
    const pop = pushModalLayer({ onEscape: () => undefined })
    press(document.body, { key: 'p', code: 'KeyP', ctrlKey: true })
    expect(files).not.toHaveBeenCalled()
    pop()
    press(document.body, { key: 'p', code: 'KeyP', ctrlKey: true })
    expect(files).toHaveBeenCalledTimes(1)
  })

  it('removes the listener on unmount', () => {
    app!.unmount()
    app = null
    press(document.body, { key: 'p', code: 'KeyP', ctrlKey: true })
    expect(files).not.toHaveBeenCalled()
  })

  it('recognizes text-entry targets', () => {
    expect(isEditableTarget(document.createElement('input'))).toBe(true)
    expect(isEditableTarget(document.createElement('textarea'))).toBe(true)
    expect(isEditableTarget(document.createElement('button'))).toBe(false)
    expect(isEditableTarget(null)).toBe(false)
  })
})
