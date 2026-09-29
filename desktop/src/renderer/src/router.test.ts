import { describe, expect, it } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'

async function makeRouter() {
  const { installRouteGuards, routeRecords } = await import('./router')
  const router = createRouter({
    history: createMemoryHistory(),
    routes: routeRecords,
  })
  installRouteGuards(router)
  return router
}

async function resolve(path: string) {
  const router = await makeRouter()
  await router.push(path)
  return router.currentRoute.value
}

describe('renderer routes', () => {
  it('serves chat and trajectory tabs per session', async () => {
    const chat = await resolve('/chat/s_123')
    expect(chat.name).toBe('chat')
    expect(chat.params.sessionId).toBe('s_123')

    const trajectory = await resolve('/chat/s_123/trajectory')
    expect(trajectory.name).toBe('trajectory')
    expect(trajectory.params.sessionId).toBe('s_123')

    expect((await resolve('/chat')).name).toBe('chat')
    expect((await resolve('/')).path).toBe('/chat')
  }, 10_000)

  it('serves the full pages', async () => {
    expect((await resolve('/scheduler')).name).toBe('scheduler')
    const capabilities = await resolve('/capabilities')
    expect(capabilities.name).toBe('capabilities')
    expect(capabilities.params.tab ?? '').toBe('')
    for (const tab of ['plugins', 'skills', 'mcp', 'tools']) {
      const route = await resolve(`/capabilities/${tab}`)
      expect(route.name).toBe('capabilities')
      expect(route.params.tab).toBe(tab)
    }
    const pulls = await resolve('/pulls/acme/app/42')
    expect(pulls.name).toBe('pulls')
    expect(pulls.params).toEqual({ owner: 'acme', repo: 'app', number: '42' })
    expect((await resolve('/pulls')).name).toBe('pulls')
    expect((await resolve('/explore')).name).toBe('explore')
  })

  it('tells conversation routes (workspace column) from pages', async () => {
    const { isConversationRoute } = await import('./router')
    expect(isConversationRoute('chat')).toBe(true)
    expect(isConversationRoute('trajectory')).toBe(true)
    for (const name of [
      'scheduler',
      'capabilities',
      'pulls',
      'explore',
      undefined,
    ])
      expect(isConversationRoute(name)).toBe(false)
  })

  it.each([
    ['/skills', '/capabilities/skills', {}],
    ['/skills/agent-reach', '/capabilities/skills', { skill: 'agent-reach' }],
    ['/mcp', '/capabilities/mcp', {}],
    ['/tools', '/capabilities/tools', {}],
    ['/settings/scheduler', '/scheduler', {}],
    ['/settings/plugins', '/capabilities', {}],
    ['/settings/tools', '/capabilities/tools', {}],
    ['/settings/integrations', '/capabilities/mcp', {}],
    // 插件 was renamed 能力; its old URLs keep their tab and query.
    ['/plugins', '/capabilities', {}],
    ['/plugins/tools', '/capabilities/tools', {}],
    ['/plugins/skills?skill=web', '/capabilities/skills', { skill: 'web' }],
  ])('moves legacy link %s to the page %s', async (path, target, query) => {
    const route = await resolve(path)
    expect(route.path).toBe(target)
    expect(route.query).toEqual(query)
  })

  it.each([
    ['/chat/s1?settings=scheduler', '/scheduler', {}],
    ['/chat?settings=plugins', '/capabilities', {}],
    [
      '/chat/s1?settings=skills&skill=web',
      '/capabilities/skills',
      { skill: 'web' },
    ],
    [
      '/chat/s1?settings=mcp&visualTheme=light',
      '/capabilities/mcp',
      { visualTheme: 'light' },
    ],
    ['/chat?settings=tools', '/capabilities/tools', {}],
    // `skill` only travels with the Skills section.
    ['/chat?settings=plugins&skill=web', '/capabilities', {}],
  ])(
    'redirects the moved settings section %s to %s',
    async (path, target, query) => {
      const route = await resolve(path)
      expect(route.path).toBe(target)
      expect(route.query).toEqual(query)
    },
  )

  it.each([
    ['/settings', 'general'],
    ['/settings/model', 'model'],
    ['/settings/appearance', 'general'],
    ['/settings/archived', 'general'],
    ['/settings/hooks', 'hooks'],
    ['/model', 'model'],
    // 配置 (USER.local.md) is edited in 记忆 › 用户档案 now.
    ['/configs', 'memory'],
    ['/settings/configs', 'memory'],
    ['/pet', 'pet'],
    ['/memory', 'memory'],
    ['/tokens', 'tokens'],
  ])(
    'redirects legacy page %s into the settings modal (%s)',
    async (path, section) => {
      const route = await resolve(path)
      expect(route.path).toBe('/chat')
      expect(route.query.settings).toBe(section)
    },
  )

  it('keeps the settings modal for sections that stayed there', async () => {
    const route = await resolve('/chat/s1?settings=hooks')
    expect(route.path).toBe('/chat/s1')
    expect(route.query.settings).toBe('hooks')
  })

  it('redirects the retired team route and unknown paths to chat', async () => {
    expect((await resolve('/team')).path).toBe('/chat')
    expect((await resolve('/nope/deeper')).path).toBe('/chat')
    expect((await resolve('/capabilities/nope')).path).toBe('/chat')
  })

  it('builds session locations for both tabs', async () => {
    const { sessionLocation } = await import('./router')
    expect(sessionLocation('s1')).toEqual({
      name: 'chat',
      params: { sessionId: 's1' },
    })
    expect(sessionLocation('s1', 'trajectory')).toEqual({
      name: 'trajectory',
      params: { sessionId: 's1' },
    })
    expect(sessionLocation('')).toEqual({ name: 'chat' })
  })
})
