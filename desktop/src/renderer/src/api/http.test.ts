import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from './http'

const g = globalThis as unknown as { window?: any; fetch?: unknown }

afterEach(() => {
  delete g.window
  vi.restoreAllMocks()
})

describe('api Core IPC routes (MIG-IPC-010)', () => {
  it('maps supported GET routes to CoreApi operations when the bridge is available', async () => {
    const calls: unknown[][] = []
    g.window = { emperor: { invokeCore: async (...args: unknown[]) => { calls.push(args); return { totals: {} } } } }
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    await expect(api('/api/tokens')).resolves.toEqual({ totals: {} })

    expect(calls).toEqual([['memory.tokens']])
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('maps supported JSON mutation routes to CoreApi operations', async () => {
    const calls: unknown[][] = []
    g.window = { emperor: { invokeCore: async (...args: unknown[]) => { calls.push(args); return { job: { id: 'job-1' } } } } }
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    await api('/api/scheduler/jobs', {
      method: 'POST',
      body: JSON.stringify({ name: 'daily', message: 'run' }),
    })

    expect(calls).toEqual([['scheduler.createJob', { name: 'daily', message: 'run' }]])
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('decodes dynamic Core route identifiers from the correct path segment', async () => {
    const calls: unknown[][] = []
    g.window = { emperor: { invokeCore: async (...args: unknown[]) => { calls.push(args); return {} } } }

    await api('/api/scheduler/jobs/job%201/run', { method: 'POST', body: JSON.stringify({}) })
    await api('/api/team/members/reviewer%201/wake', { method: 'POST', body: JSON.stringify({ reason: 'manual' }) })
    await api('/api/memory/versions/ver%201/restore', { method: 'POST', body: JSON.stringify({}) })
    await api('/api/tasks/task%201/transcript?limit=25')

    expect(calls).toEqual([
      ['scheduler.runJob', 'job 1'],
      ['team.wakeMember', 'reviewer 1', { reason: 'manual' }],
      ['memory.restoreVersion', 'ver 1'],
      ['tasks.transcript', 'task 1', { limit: 25 }],
    ])
  })

  it('maps session and project routes to CoreApi operations', async () => {
    const calls: unknown[][] = []
    g.window = { emperor: { invokeCore: async (...args: unknown[]) => { calls.push(args); return {} } } }

    await api('/api/sessions?archived=1')
    await api('/api/sessions', { method: 'POST', body: JSON.stringify({ title: 'Work' }) })
    await api('/api/sessions/sess%201', { method: 'PATCH', body: JSON.stringify({ title: 'Renamed' }) })
    await api('/api/sessions/sess%201/activate', { method: 'POST', body: JSON.stringify({}) })
    await api('/api/sessions/sess%201', { method: 'DELETE' })
    await api('/api/projects/resolve', { method: 'POST', body: JSON.stringify({ path: '/tmp/project' }) })

    expect(calls).toEqual([
      ['sessions.list', { includeArchived: true }],
      ['sessions.create', { title: 'Work' }],
      ['sessions.rename', 'sess 1', { title: 'Renamed' }],
      ['sessions.activate', 'sess 1'],
      ['sessions.delete', 'sess 1'],
      ['projects.resolve', '/tmp/project'],
    ])
  })

  it('maps remaining read-only route parity endpoints to CoreApi operations', async () => {
    const calls: unknown[][] = []
    g.window = { emperor: { invokeCore: async (...args: unknown[]) => { calls.push(args); return {} } } }

    await api('/api/bootstrap?session=sess%201')
    await api('/api/control')
    await api('/api/plans')
    await api('/api/plans/plan%201')
    await api('/api/external')
    await api('/api/memory/versions?limit=5')
    await api('/api/tools')
    await api('/api/skills')
    await api('/api/diagnostics')

    expect(calls).toEqual([
      ['bootstrap', { sessionId: 'sess 1' }],
      ['control.get'],
      ['plans.list'],
      ['plans.get', 'plan 1'],
      ['external.get'],
      ['memory.listVersions', { limit: 5 }],
      ['skills.tools'],
      ['skills.list'],
      ['diagnostics.get'],
    ])
  })

  it('maps transport and control mutation route parity endpoints to CoreApi operations', async () => {
    const calls: unknown[][] = []
    g.window = { emperor: { invokeCore: async (...args: unknown[]) => { calls.push(args); return {} } } }

    await api('/api/runtime/stop', { method: 'POST', body: JSON.stringify({}) })
    await api('/api/control/mode', { method: 'POST', body: JSON.stringify({ mode: 'plan' }) })
    await api('/api/control/interactions/ask%201/cancel', { method: 'POST', body: JSON.stringify({}) })

    expect(calls).toEqual([
      ['chat.stopRuntime', {}],
      ['control.setMode', 'plan'],
      ['control.cancelInteraction', 'ask 1'],
    ])
  })

  it('maps the remaining JSON route parity endpoints to CoreApi operations', async () => {
    const calls: unknown[][] = []
    g.window = { emperor: { invokeCore: async (...args: unknown[]) => { calls.push(args); return {} } } }
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    await api('/api/model-config')
    await api('/api/config')
    await api('/api/mcp-config')
    await api('/api/watchlist')
    await api('/api/scheduler')
    await api('/api/team')
    await api('/api/sidebar-state')
    await api('/api/desktop-pet')
    await api('/api/memory/episode?date=2026-05-01')
    await api('/api/tasks')
    await api('/api/tasks/task%201')
    await api('/api/team/members/alice%201')
    await api('/api/skill?name=demo')
    await api('/api/model-config', { method: 'POST', body: JSON.stringify({ models: [] }) })
    await api('/api/config', { method: 'POST', body: JSON.stringify({ content: 'user' }) })
    await api('/api/mcp-config', { method: 'POST', body: JSON.stringify({ servers: {} }) })
    await api('/api/memory', { method: 'POST', body: JSON.stringify({ content: 'memory' }) })
    await api('/api/memory/episode', { method: 'POST', body: JSON.stringify({ content: 'episode', date: '2026-05-01' }) })
    await api('/api/watchlist', { method: 'POST', body: JSON.stringify({ content: '- [ ] item' }) })
    await api('/api/watchlist/check', { method: 'POST' })
    await api('/api/desktop-pet', { method: 'POST', body: JSON.stringify({ enabled: true }) })
    await api('/api/team/members', { method: 'POST', body: JSON.stringify({ name: 'alice', role: 'reader' }) })
    await api('/api/team/messages', { method: 'POST', body: JSON.stringify({ to: 'alice', content: 'hi' }) })
    await api('/api/team/members/alice%201/shutdown', { method: 'POST', body: JSON.stringify({}) })
    await api('/api/sidebar-state', { method: 'PATCH', body: JSON.stringify({ collapsed: true }) })
    await api('/api/scheduler/jobs/job%201', { method: 'PATCH', body: JSON.stringify({ enabled: false }) })
    await api('/api/skill?name=demo', { method: 'DELETE' })
    await api('/api/scheduler/jobs/job%201', { method: 'DELETE' })

    expect(calls).toEqual([
      ['model.getConfig'],
      ['config.get'],
      ['mcp.getConfig'],
      ['memory.getWatchlist'],
      ['scheduler.get'],
      ['team.get'],
      ['sidebar.get'],
      ['desktopPet.get'],
      ['memory.getEpisode', '2026-05-01'],
      ['tasks.list'],
      ['tasks.get', 'task 1'],
      ['team.getMember', 'alice 1'],
      ['skills.get', 'demo'],
      ['model.saveConfig', { models: [] }],
      ['config.save', { content: 'user' }],
      ['mcp.saveConfig', { servers: {} }],
      ['memory.save', 'memory'],
      ['memory.saveEpisode', 'episode', '2026-05-01'],
      ['memory.saveWatchlist', '- [ ] item'],
      ['memory.checkWatchlist'],
      ['desktopPet.setEnabled', true],
      ['team.spawnMember', { name: 'alice', role: 'reader' }],
      ['team.sendMessage', { to: 'alice', content: 'hi' }],
      ['team.shutdownMember', 'alice 1'],
      ['sidebar.patch', { collapsed: true }],
      ['scheduler.updateJob', 'job 1', { enabled: false }],
      ['skills.delete', 'demo'],
      ['scheduler.deleteJob', 'job 1'],
    ])
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('fails fast for unmapped routes when the Core bridge is available', async () => {
    g.window = { emperor: { invokeCore: vi.fn() } }
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    await expect(api('/api/skills/import', { method: 'POST', body: new FormData() })).rejects.toThrow(
      'No Core IPC route mapping for POST /api/skills/import',
    )

    expect(g.window.emperor.invokeCore).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('fails fast instead of using retired HTTP fallback when the Core bridge is unavailable', async () => {
    g.window = { emperor: {} }
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    await expect(api('/api/skills/import', { method: 'POST', body: new FormData() })).rejects.toThrow(
      'Core IPC bridge is unavailable; use the Electron desktop window.',
    )

    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
