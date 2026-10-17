// @vitest-environment jsdom
import { createApp, h, nextTick, ref } from 'vue'
import { expect, it } from 'vitest'
import SubagentAvatar from './SubagentAvatar.vue'
import { subagentFrame, subagentFrames } from './subagentAvatars'

it('uses all 36 measured frames including the D08 left crop and FNV1a mapping', () => {
  expect(subagentFrames).toHaveLength(36)
  expect(subagentFrames.find((f) => f.id === 'D08')?.rect).toEqual([
    486, 832, 302, 354,
  ])
  expect(subagentFrame('sub-parent').id).toBe('A05')
  expect(
    new Set(
      Array.from({ length: 1000 }, (_, i) => subagentFrame(`sub-${i}`).id),
    ).size,
  ).toBe(36)
})
it('keeps the same portrait across reorder, phase changes and remount, with inset and frame-specific clipping', async () => {
  const ids = ref(['sub-parent', 'sub-two'])
  const phase = ref('running')
  const el = document.createElement('div')
  const mount = () => {
    const app = createApp({
      render: () =>
        h(
          'div',
          ids.value.map((id) =>
            h(SubagentAvatar, {
              key: id,
              sessionId: id,
              'data-phase': phase.value,
            }),
          ),
        ),
    })
    app.mount(el)
    return app
  }
  let app = mount()
  const portrait = () => el.querySelector('[data-agent-identity="sub-parent"]')!
  const frame = portrait().getAttribute('data-avatar')
  expect(portrait().querySelector('svg svg')?.getAttribute('x')).toBe('8')
  expect(portrait().querySelector('svg svg')?.getAttribute('width')).toBe('84')
  expect(portrait().querySelector('clipPath rect')?.getAttribute('x')).toBe(
    String(subagentFrame('sub-parent').rect[0]),
  )
  expect(portrait().querySelector('image')?.getAttribute('clip-path')).toMatch(
    /^url\(#.+\)$/,
  )
  ids.value.reverse()
  phase.value = 'completed'
  await nextTick()
  expect(portrait().getAttribute('data-avatar')).toBe(frame)
  app.unmount()
  app = mount()
  expect(portrait().getAttribute('data-avatar')).toBe(frame)
  expect(
    new Set([...el.querySelectorAll('clipPath')].map((n) => n.id)).size,
  ).toBe(2)
  app.unmount()
})
