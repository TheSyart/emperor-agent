// @vitest-environment jsdom
import { createApp, nextTick, type App } from 'vue'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import SubagentAvatarPreview from './SubagentAvatarPreview.vue'

let app: App | undefined, root: HTMLDivElement
let focused = true,
  hidden = false,
  reduced = false
let motion: (() => void) | undefined
const frames = new Map<number, FrameRequestCallback>()
let serial = 0
const motionRemove = vi.fn()
async function settle() {
  for (let i = 0; i < 16; i++) await Promise.resolve()
  await nextTick()
}
async function mount() {
  root = document.createElement('div')
  document.body.append(root)
  app = createApp(SubagentAvatarPreview)
  app.mount(root)
  await settle()
}
async function tick(time: number) {
  expect(frames.size).toBe(1)
  const [id, callback] = [...frames][0]!
  frames.delete(id)
  callback(time)
  await nextTick()
}
const pose = () =>
  [...root.querySelectorAll<HTMLElement>('.layer')].map((layer) => ({
    opacity: layer.style.opacity,
    transform: layer.style.transform,
  }))
const focus = (value: boolean) => {
  focused = value
  window.dispatchEvent(new Event(value ? 'focus' : 'blur'))
}
const visibility = (value: boolean) => {
  hidden = value
  document.dispatchEvent(new Event('visibilitychange'))
}
beforeEach(() => {
  focused = true
  hidden = false
  reduced = false
  serial = 0
  frames.clear()
  vi.spyOn(document, 'hasFocus').mockImplementation(() => focused)
  vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden)
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn((callback: FrameRequestCallback) => {
      frames.set(++serial, callback)
      return serial
    }),
  )
  vi.stubGlobal(
    'cancelAnimationFrame',
    vi.fn((id: number) => frames.delete(id)),
  )
  vi.stubGlobal('matchMedia', () => ({
    get matches() {
      return reduced
    },
    addEventListener: (_: string, listener: () => void) => {
      motion = listener
    },
    removeEventListener: motionRemove,
  }))
  Object.defineProperty(HTMLImageElement.prototype, 'decode', {
    configurable: true,
    value: async () => {},
  })
})
afterEach(() => {
  app?.unmount()
  app = undefined
  root?.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})
it('honors initial document focus before scheduling the settings preview', async () => {
  focused = false
  await mount()
  expect(frames.size).toBe(0)
  focus(true)
  await tick(10000)
  expect(pose()[0]!.opacity).toBe('1')
  await tick(12560)
  expect(pose()[0]!.opacity).toBe('0.5')
})
it('freezes a midfade on blur and resumes the same timeline without a jump', async () => {
  await mount()
  await tick(100)
  await tick(2660)
  const frozen = pose()
  expect(frozen.map((layer) => layer.opacity)).toEqual(['0.5', '0.5'])
  focus(false)
  expect(frames.size).toBe(0)
  expect(pose()).toEqual(frozen)
  focus(true)
  await tick(50000)
  expect(pose()).toEqual(frozen)
  await tick(50080)
  expect(Number(pose()[1]!.opacity)).toBeGreaterThan(0.5)
})
it('requires both visibility and focus to resume', async () => {
  await mount()
  await tick(100)
  visibility(true)
  focus(false)
  focus(true)
  expect(frames.size).toBe(0)
  visibility(false)
  await tick(50000)
  expect(pose()[0]!.opacity).toBe('1')
  focus(false)
  visibility(true)
  visibility(false)
  expect(frames.size).toBe(0)
  focus(true)
  expect(frames.size).toBe(1)
})
it('keeps reduced motion static across focus and visibility events', async () => {
  reduced = true
  await mount()
  const frozen = pose()
  focus(false)
  visibility(true)
  focus(true)
  visibility(false)
  expect(frames.size).toBe(0)
  expect(pose()).toEqual(frozen)
  reduced = false
  motion!()
  expect(frames.size).toBe(1)
})
it('releases window, visibility, media listeners and RAF on unmount', async () => {
  const removeWindow = vi.spyOn(window, 'removeEventListener')
  const removeDocument = vi.spyOn(document, 'removeEventListener')
  await mount()
  expect(frames.size).toBe(1)
  app!.unmount()
  app = undefined
  expect(frames.size).toBe(0)
  expect(removeWindow.mock.calls.map(([name]) => name)).toEqual(
    expect.arrayContaining(['focus', 'blur']),
  )
  expect(removeDocument.mock.calls.map(([name]) => name)).toContain(
    'visibilitychange',
  )
  expect(motionRemove).toHaveBeenCalledWith('change', motion)
  focus(false)
  focus(true)
  visibility(true)
  visibility(false)
  motion!()
  expect(frames.size).toBe(0)
})
