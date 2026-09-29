// @vitest-environment jsdom
import { createApp, defineComponent, h, nextTick, type App } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { afterEach, describe, expect, it } from 'vitest'
import {
  pluginFromQuery,
  pluginQuery,
  usePluginSelection,
} from './usePluginSelection'

describe('plugin selection query', () => {
  it('reads a plugin id with a slash and a known scope', () => {
    expect(pluginFromQuery({ plugin: 'acme/demo', scope: 'user' })).toEqual({
      pluginId: 'acme/demo',
      scope: 'user',
    })
    expect(pluginFromQuery({ plugin: 'github', scope: 'managed' })).toEqual({
      pluginId: 'github',
      scope: 'managed',
    })
    expect(pluginFromQuery({ plugin: 'github', scope: 'nowhere' })).toBeNull()
    expect(pluginFromQuery({ plugin: '', scope: 'user' })).toBeNull()
    expect(pluginFromQuery({})).toBeNull()
  })

  it('sets or drops only plugin and scope', () => {
    expect(
      pluginQuery({ q: 'x' }, { pluginId: 'acme/demo', scope: 'project' }),
    ).toEqual({ q: 'x', plugin: 'acme/demo', scope: 'project' })
    expect(pluginQuery({ q: 'x', plugin: 'a', scope: 'user' }, null)).toEqual({
      q: 'x',
    })
  })
})

let app: App | null = null
afterEach(() => {
  app?.unmount()
  app = null
})

describe('usePluginSelection', () => {
  it('follows the route it mounted on and writes the query', async () => {
    const blank = defineComponent({ render: () => h('div') })
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/capabilities/:tab?', name: 'capabilities', component: blank },
        { path: '/chat', name: 'chat', component: blank },
      ],
    })
    await router.push('/capabilities/plugins?plugin=acme/demo&scope=user')
    await router.isReady()
    let selection!: ReturnType<typeof usePluginSelection>
    app = createApp(
      defineComponent({
        setup() {
          selection = usePluginSelection()
          return () => h('div')
        },
      }),
    )
    app.use(router)
    app.mount(document.createElement('div'))
    expect(selection.selected.value).toEqual({
      pluginId: 'acme/demo',
      scope: 'user',
    })

    await selection.select({ pluginId: 'github', scope: 'managed' })
    expect(router.currentRoute.value.fullPath).toBe(
      '/capabilities/plugins?plugin=github&scope=managed',
    )
    await nextTick()
    expect(selection.selected.value).toEqual({
      pluginId: 'github',
      scope: 'managed',
    })

    await router.push('/chat')
    await selection.select(null)
    expect(router.currentRoute.value.fullPath).toBe('/chat')
    await nextTick()
    expect(selection.selected.value).toEqual({
      pluginId: 'github',
      scope: 'managed',
    })
  })
})
