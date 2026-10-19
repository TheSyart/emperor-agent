import { beforeAll, describe, expect, it } from 'vitest'
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
  beforeAll(async () => {
    // Cold Vite/SFC transforms are setup work. Keep loading the real views,
    // but finish that work before the short navigation assertions start.
    const router = await makeRouter()
    for (const path of [
      '/chat',
      '/scheduler',
      '/capabilities',
      '/pulls',
      '/github/issues',
      '/github/ci',
      '/explore',
    ])
      await router.push(path)
  }, 60_000)

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
    const issue = await resolve('/github/issues/acme/app/7')
    expect(issue.name).toBe('github-issues')
    expect(issue.params).toEqual({ owner: 'acme', repo: 'app', number: '7' })
    const run = await resolve('/github/ci/acme/app/36566264518')
    expect(run.name).toBe('github-ci')
    expect(run.params).toEqual({
      owner: 'acme',
      repo: 'app',
      runId: '36566264518',
    })
    expect((await resolve('/github/ci')).name).toBe('github-ci')
    expect((await resolve('/github')).name).toBe('github-issues')
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
      'github-issues',
      'github-ci',
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
    // Nor does a settings sub page.
    ['/chat?settings=tools&page=chrome', '/capabilities/tools', {}],
  ])(
    'redirects the moved settings section %s to %s',
    async (path, target, query) => {
      const route = await resolve(path)
      expect(route.path).toBe(target)
      expect(route.query).toEqual(query)
    },
  )

  it.each([
    ['/settings', 'general', undefined],
    ['/settings/model', 'model', undefined],
    ['/settings/appearance', 'general', undefined],
    ['/settings/archived', 'general', 'archived'],
    // Hooks and 诊断 are sub pages of 高级; 桌宠 is a switch in 常规 (UI-S07).
    ['/settings/hooks', 'advanced', 'hooks'],
    ['/settings/diagnostics', 'advanced', 'diagnostics'],
    ['/model', 'model', undefined],
    // 配置 (USER.local.md) is edited in 记忆 › 用户档案 now.
    ['/configs', 'memory', undefined],
    ['/settings/configs', 'memory', undefined],
    ['/pet', 'general', undefined],
    ['/memory', 'memory', undefined],
    ['/tokens', 'tokens', undefined],
  ])(
    'redirects legacy page %s into the settings modal (%s)',
    async (path, section, page) => {
      const route = await resolve(path)
      expect(route.path).toBe('/chat')
      expect(route.query.settings).toBe(section)
      expect(route.query.page).toBe(page)
    },
  )

  it('keeps the settings modal for sections that stayed there', async () => {
    const route = await resolve('/chat/s1?settings=model&foo=1')
    expect(route.path).toBe('/chat/s1')
    expect(route.query).toEqual({ settings: 'model', foo: '1' })
  })

  it.each([
    ['/chat/s1?settings=hooks', { settings: 'advanced', page: 'hooks' }],
    [
      '/chat/s1?settings=diagnostics&foo=1',
      { settings: 'advanced', page: 'diagnostics', foo: '1' },
    ],
    ['/chat/s1?settings=pet&page=detail', { settings: 'general' }],
  ])('opens the folded section %s where it lives now', async (path, query) => {
    const route = await resolve(path)
    expect(route.path).toBe('/chat/s1')
    expect(route.query).toEqual(query)
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
it('keeps the external child route rooted without rewriting its identity', async () => {
  const route = await resolve('/chat/78abd5498fc6469f/agents/dlg-retained')
  expect(route.name).toBe('external-agent')
  expect(route.params).toEqual({
    sessionId: '78abd5498fc6469f',
    delegationId: 'dlg-retained',
  })
  const { isConversationRoute } = await import('./router')
  expect(isConversationRoute(route.name)).toBe(true)
})
