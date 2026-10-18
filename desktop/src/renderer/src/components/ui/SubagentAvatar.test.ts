// @vitest-environment jsdom
import { createApp, h, nextTick, ref } from 'vue'
import { expect, it } from 'vitest'
import SubagentAvatar from './SubagentAvatar.vue'
import { avatarSeed } from '../workspace/environmentModel'

it('keeps a child identity stable across updates, and offers all 36 approved portraits', async () => {
  const element = document.createElement('div')
  const id = ref('child-0')
  const status = ref('running')
  const app = createApp({
    render: () => h(SubagentAvatar, { id: id.value, status: status.value }),
  })
  app.mount(element)
  const character = () =>
    element.querySelector('[data-avatar]')!.getAttribute('data-avatar')
  const first = character()
  status.value = 'completed'
  await nextTick()
  expect(character()).toBe(first)
  expect(element.querySelector('[data-status="completed"]')).not.toBeNull()
  const kinds = new Set<string | null>()
  for (let i = 0; i < 300; i++) {
    id.value = `child-${i}`
    await nextTick()
    kinds.add(character())
    expect(element.querySelector('svg image')?.getAttribute('href')).toMatch(
      /\.webp/,
    )
  }
  expect(kinds.size).toBe(36)
  id.value = 'child-0'
  await nextTick()
  expect(character()).toBe(first)
  app.unmount()
})

// D07's pink gills cross the equal-cell boundary. D08 must use its own
// measured window rather than showing the whole bottom-middle grid cell.
it('frames the chameleon separately from its neighbor and preserves breathing room', () => {
  const element = document.createElement('div')
  let id = 0
  while (avatarSeed(`chameleon-${id}`) % 36 !== 34) id++
  const app = createApp({
    render: () => h(SubagentAvatar, { id: `chameleon-${id}` }),
  })
  app.mount(element)
  expect(element.querySelector('[data-avatar="D08"]')).not.toBeNull()
  const frame = element.querySelector('svg[data-portrait-frame]')!
  expect(frame.getAttribute('viewBox')).toBe('486 832 302 354')
  expect(frame.getAttribute('preserveAspectRatio')).toBe('xMidYMid meet')
  expect(frame.getAttribute('overflow')).toBe('hidden')
  expect(frame.getAttribute('x')).toBe('8')
  expect(frame.getAttribute('width')).toBe('84')
  const clip = frame.querySelector('clipPath rect')!
  expect(
    ['x', 'y', 'width', 'height'].map((attr) => clip.getAttribute(attr)),
  ).toEqual(['486', '832', '302', '354'])
  expect(frame.querySelector('image')!.getAttribute('clip-path')).toMatch(
    /^url\(#portrait-/,
  )
  app.unmount()
})
