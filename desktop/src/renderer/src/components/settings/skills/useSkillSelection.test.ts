// @vitest-environment jsdom
import { createApp, defineComponent, h, nextTick, type App } from 'vue'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
import { afterEach, describe, expect, it } from 'vitest'
import {
  skillFromQuery,
  skillQuery,
  useSkillSelection,
} from './useSkillSelection'

describe('skill selection query', () => {
  it('reads the first non-empty skill value', () => {
    expect(skillFromQuery({ skill: 'writer' })).toBe('writer')
    expect(skillFromQuery({ skill: ['a', 'b'] })).toBe('a')
    expect(skillFromQuery({ skill: '' })).toBeNull()
    expect(skillFromQuery({})).toBeNull()
  })

  it('sets or drops only the skill key', () => {
    expect(skillQuery({ foo: 'bar' }, 'writer')).toEqual({
      foo: 'bar',
      skill: 'writer',
    })
    expect(skillQuery({ foo: 'bar', skill: 'old' }, null)).toEqual({
      foo: 'bar',
    })
  })
})

let app: App | null = null

afterEach(() => {
  app?.unmount()
  app = null
  document.body.innerHTML = ''
})

async function mount(path: string) {
  const blank = defineComponent({ render: () => h('div') })
  const router: Router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/plugins/:tab?', name: 'plugins', component: blank },
      { path: '/chat', name: 'chat', component: blank },
    ],
  })
  await router.push(path)
  await router.isReady()
  let selection!: ReturnType<typeof useSkillSelection>
  app = createApp(
    defineComponent({
      setup() {
        selection = useSkillSelection()
        return () => h('div')
      },
    }),
  )
  app.use(router)
  app.mount(document.createElement('div'))
  return { router, selection }
}

describe('useSkillSelection', () => {
  it('writes ?skill= on the current route and keeps other keys', async () => {
    const { router, selection } = await mount('/plugins/skills?foo=1')
    expect(selection.selected.value).toBeNull()
    await selection.select('writer')
    expect(router.currentRoute.value.fullPath).toBe(
      '/plugins/skills?foo=1&skill=writer',
    )
    expect(selection.selected.value).toBe('writer')
    await selection.select(null)
    expect(router.currentRoute.value.query).toEqual({ foo: '1' })
    expect(selection.selected.value).toBeNull()
  })

  it('keeps the selection while another route shows (kept-alive page)', async () => {
    const { router, selection } = await mount('/plugins/skills?skill=writer')
    expect(selection.selected.value).toBe('writer')
    await router.push('/chat')
    await nextTick()
    expect(selection.selected.value).toBe('writer')
    // Selecting from a page that is not showing does not touch that route.
    await selection.select('other')
    expect(router.currentRoute.value.fullPath).toBe('/chat')
    await router.push('/plugins/skills?skill=next')
    await nextTick()
    expect(selection.selected.value).toBe('next')
  })
})
