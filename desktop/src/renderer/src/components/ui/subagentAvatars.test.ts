// @vitest-environment jsdom
import { createApp, h, nextTick, ref } from 'vue'
import { expect, it } from 'vitest'
import Avatar from './Avatar.vue'
import { portraitLayout } from './spriteAvatar'
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
it('keeps the same portrait across reorder, phase changes and remount, with an inset frame-specific crop', async () => {
  const ids = ref(['sub-parent', 'sub-two'])
  const phase = ref('running')
  const el = document.createElement('div')
  const mount = () => {
    const app = createApp({
      render: () =>
        h(
          'div',
          ids.value.map((id) =>
            h(Avatar, {
              key: id,
              kind: 'sprite',
              id,
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
  expect(frame).toBe(subagentFrame('sub-parent').id)
  // 8% inset on every side, the measured window's aspect kept.
  const rect = subagentFrame('sub-parent').rect as [
    number,
    number,
    number,
    number,
  ]
  const layout = portraitLayout(rect, 100)
  expect(Math.max(layout.width, layout.height)).toBe(84)
  expect(Math.min(layout.x, layout.y)).toBe(8)
  ids.value.reverse()
  phase.value = 'completed'
  await nextTick()
  expect(portrait().getAttribute('data-avatar')).toBe(frame)
  app.unmount()
  app = mount()
  expect(portrait().getAttribute('data-avatar')).toBe(frame)
  expect(el.querySelectorAll('.ds-avatar canvas')).toHaveLength(2)
  app.unmount()
})
