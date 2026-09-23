// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createRouter, createWebHistory, type Router } from 'vue-router'
import {
  installNavHistory,
  readNavHistory,
  refreshNavHistory,
  useNavHistory,
} from './navHistory'

describe('readNavHistory', () => {
  it('reads vue-router back / forward locations', () => {
    expect(readNavHistory({ back: '/chat/a', forward: null })).toEqual({
      canGoBack: true,
      canGoForward: false,
    })
    expect(readNavHistory({ back: null, forward: '/scheduler' })).toEqual({
      canGoBack: false,
      canGoForward: true,
    })
    expect(readNavHistory({ back: '', forward: undefined })).toEqual({
      canGoBack: false,
      canGoForward: false,
    })
    expect(readNavHistory(null)).toEqual({
      canGoBack: false,
      canGoForward: false,
    })
    expect(readNavHistory('garbage')).toEqual({
      canGoBack: false,
      canGoForward: false,
    })
  })
})

describe('installNavHistory', () => {
  let router: Router | null = null
  let uninstall: (() => void) | null = null

  afterEach(() => {
    uninstall?.()
    uninstall = null
    router = null
    refreshNavHistory(null)
  })

  it('refreshes availability after every navigation', async () => {
    const page = { render: () => null }
    router = createRouter({
      history: createWebHistory(),
      routes: [
        { path: '/', component: page },
        { path: '/a', component: page },
        { path: '/b', component: page },
      ],
    })
    uninstall = installNavHistory(router)
    await router.push('/')
    const nav = useNavHistory()
    await router.push('/a')
    expect(nav.canGoBack).toBe(true)
    expect(nav.canGoForward).toBe(false)
    await router.push('/b')
    expect(nav.canGoBack).toBe(true)
    // Mirrors window.history.state (forward entries after a traversal).
    refreshNavHistory({ back: '/a', current: '/b', forward: '/c' })
    expect(nav.canGoForward).toBe(true)
  })
})
