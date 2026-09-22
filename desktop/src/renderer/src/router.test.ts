import { describe, expect, it } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'

async function makeRouter() {
  const { routeRecords } = await import('./router')
  return createRouter({ history: createMemoryHistory(), routes: routeRecords })
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
  })

  it.each([
    ['/settings', 'general'],
    ['/settings/model', 'model'],
    ['/settings/appearance', 'general'],
    ['/settings/archived', 'general'],
    ['/settings/integrations', 'mcp'],
    ['/settings/hooks', 'hooks'],
    ['/plugins', 'plugins'],
    ['/plugins/skills', 'skills'],
    ['/plugins/tools', 'tools'],
    ['/plugins/mcp', 'mcp'],
    ['/tools', 'tools'],
    ['/mcp', 'mcp'],
    ['/model', 'model'],
    ['/scheduler', 'scheduler'],
    ['/configs', 'configs'],
    ['/pet', 'pet'],
    ['/memory', 'memory'],
    ['/tokens', 'tokens'],
    ['/skills', 'skills'],
  ])(
    'redirects legacy page %s into the settings modal (%s)',
    async (path, section) => {
      const route = await resolve(path)
      expect(route.path).toBe('/chat')
      expect(route.query.settings).toBe(section)
    },
  )

  it('keeps the selected skill of a legacy skill deep link', async () => {
    const route = await resolve('/skills/agent-reach')
    expect(route.query).toEqual({ settings: 'skills', skill: 'agent-reach' })
  })

  it('redirects the retired team route and unknown paths to chat', async () => {
    expect((await resolve('/team')).path).toBe('/chat')
    expect((await resolve('/nope/deeper')).path).toBe('/chat')
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
