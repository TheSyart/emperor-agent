import { CORE_BRIDGE_UNAVAILABLE_MESSAGE, hasCoreBridge, invokeCore } from './backend'

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  if (hasCoreBridge()) {
    return callCore<T>(path, options)
  }
  throw new Error(CORE_BRIDGE_UNAVAILABLE_MESSAGE)
}

export async function callCore<T>(path: string, options: RequestInit = {}): Promise<T> {
  const mapped = coreRoute(path, options)
  if (mapped) return await invokeCore(mapped.operation, ...mapped.args) as T
  const method = String(options.method || 'GET').toUpperCase()
  throw new Error(`No Core IPC route mapping for ${method} ${new URL(path, 'http://local').pathname}`)
}

export function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function coreRoute(path: string, options: RequestInit): { operation: string; args: unknown[] } | null {
  const method = String(options.method || 'GET').toUpperCase()
  const url = new URL(path, 'http://local')
  const body = parseBody(options.body)
  const hasJsonBody = typeof options.body === 'string'
  const pathname = url.pathname

  if (method === 'GET') {
    if (pathname === '/api/bootstrap') return op('bootstrap', { sessionId: url.searchParams.get('session') || null })
    if (pathname === '/api/sessions') return op('sessions.list', { includeArchived: url.searchParams.get('archived') === '1' })
    if (pathname === '/api/projects') return op('projects.list')
    if (pathname === '/api/control') return op('control.get')
    if (pathname === '/api/plans') return op('plans.list')
    if (pathname.startsWith('/api/plans/')) return op('plans.get', decodeLast(pathname))
    if (pathname === '/api/external') return op('external.get')
    if (pathname === '/api/tools') return op('skills.tools')
    if (pathname === '/api/skills') return op('skills.list')
    if (pathname === '/api/diagnostics') return op('diagnostics.get')
    if (pathname === '/api/tokens') return op('memory.tokens')
    if (pathname === '/api/memory') return op('memory.get')
    if (pathname === '/api/model-config') return op('model.getConfig')
    if (pathname === '/api/config') return op('config.get')
    if (pathname === '/api/mcp-config') return op('mcp.getConfig')
    if (pathname === '/api/watchlist') return op('memory.getWatchlist')
    if (pathname === '/api/scheduler') return op('scheduler.get')
    if (pathname === '/api/team') return op('team.get')
    if (pathname === '/api/sidebar-state') return op('sidebar.get')
    if (pathname === '/api/desktop-pet') return op('desktopPet.get')
    if (pathname === '/api/memory/episode') return op('memory.getEpisode', url.searchParams.get('date') || null)
    if (pathname === '/api/memory/versions') return op('memory.listVersions', queryOptions(url))
    if (pathname.startsWith('/api/memory/versions/')) return op('memory.getVersion', decodeLast(pathname))
    if (pathname.startsWith('/api/tasks/') && pathname.endsWith('/transcript')) return op('tasks.transcript', decodeSegment(pathname, 2), queryOptions(url))
    if (pathname.startsWith('/api/tasks/')) return op('tasks.get', decodeLast(pathname))
    if (pathname === '/api/tasks') return op('tasks.list')
    if (pathname.startsWith('/api/team/members/')) return op('team.getMember', decodeLast(pathname))
    if (pathname === '/api/skill') return op('skills.get', url.searchParams.get('name') || '')
  }

  if (method === 'POST') {
    if (!hasJsonBody && pathname !== '/api/compact' && pathname !== '/api/watchlist/check') return null
    if (pathname === '/api/runtime/stop') return op('chat.stopRuntime', body)
    if (pathname === '/api/control/mode') return op('control.setMode', String(body.mode || ''))
    if (pathname.match(/^\/api\/control\/interactions\/[^/]+\/cancel$/)) return op('control.cancelInteraction', decodeSegment(pathname, 3))
    if (pathname === '/api/sessions') return op('sessions.create', body)
    if (pathname.match(/^\/api\/sessions\/[^/]+\/activate$/)) return op('sessions.activate', decodeSegment(pathname, 2))
    if (pathname === '/api/projects/resolve') return op('projects.resolve', String(body.path || ''))
    if (pathname === '/api/model-config') return op('model.saveConfig', body)
    if (pathname === '/api/compact') return op('memory.compact')
    if (pathname === '/api/skill') return op('skills.save', String(body.name || ''), String(body.content || ''))
    if (pathname === '/api/skills/import') return op('skills.importArchive', String(body.path || ''))
    if (pathname === '/api/config') return op('config.save', body)
    if (pathname === '/api/mcp-config') return op('mcp.saveConfig', body)
    if (pathname === '/api/memory') return op('memory.save', String(body.content || ''))
    if (pathname === '/api/memory/episode') return op('memory.saveEpisode', String(body.content || ''), body.date ?? null)
    if (pathname.startsWith('/api/memory/versions/') && pathname.endsWith('/restore')) return op('memory.restoreVersion', decodeSegment(pathname, 3))
    if (pathname === '/api/watchlist') return op('memory.saveWatchlist', String(body.content || ''))
    if (pathname === '/api/watchlist/check') return op('memory.checkWatchlist')
    if (pathname === '/api/desktop-pet') return op('desktopPet.setEnabled', Boolean(body.enabled))
    if (pathname === '/api/scheduler/jobs') return op('scheduler.createJob', body)
    if (pathname.match(/^\/api\/scheduler\/jobs\/[^/]+\/run$/)) return op('scheduler.runJob', decodeSegment(pathname, 3))
    if (pathname.match(/^\/api\/scheduler\/jobs\/[^/]+\/pause$/)) return op('scheduler.pauseJob', decodeSegment(pathname, 3))
    if (pathname.match(/^\/api\/scheduler\/jobs\/[^/]+\/resume$/)) return op('scheduler.resumeJob', decodeSegment(pathname, 3))
    if (pathname === '/api/team/members') return op('team.spawnMember', body)
    if (pathname === '/api/team/messages') return op('team.sendMessage', body)
    if (pathname.match(/^\/api\/team\/members\/[^/]+\/wake$/)) return op('team.wakeMember', decodeSegment(pathname, 3), body)
    if (pathname.match(/^\/api\/team\/members\/[^/]+\/shutdown$/)) return op('team.shutdownMember', decodeSegment(pathname, 3))
  }

  if (method === 'PATCH') {
    if (!hasJsonBody) return null
    if (pathname.match(/^\/api\/sessions\/[^/]+$/)) return op('sessions.rename', decodeLast(pathname), body)
    if (pathname === '/api/sidebar-state') return op('sidebar.patch', body)
    if (pathname.match(/^\/api\/scheduler\/jobs\/[^/]+$/)) return op('scheduler.updateJob', decodeLast(pathname), body)
  }

  if (method === 'DELETE') {
    if (pathname === '/api/skill') return op('skills.delete', url.searchParams.get('name') || '')
    if (pathname.match(/^\/api\/sessions\/[^/]+$/)) return op('sessions.delete', decodeLast(pathname))
    if (pathname.match(/^\/api\/scheduler\/jobs\/[^/]+$/)) return op('scheduler.deleteJob', decodeLast(pathname))
  }

  return null
}

function op(operation: string, ...args: unknown[]): { operation: string; args: unknown[] } {
  return { operation, args }
}

function parseBody(body: BodyInit | null | undefined): Record<string, any> {
  if (typeof body !== 'string' || !body.trim()) return {}
  try {
    const parsed = JSON.parse(body)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function decodeLast(pathname: string): string {
  const parts = pathname.split('/').filter(Boolean)
  return decodeURIComponent(parts.at(-1) || '')
}

function decodeSegment(pathname: string, index: number): string {
  const parts = pathname.split('/').filter(Boolean)
  return decodeURIComponent(parts[index] || '')
}

function queryOptions(url: URL): Record<string, number> {
  const out: Record<string, number> = {}
  for (const key of ['offset', 'limit']) {
    const raw = url.searchParams.get(key)
    if (raw == null) continue
    const value = Number(raw)
    if (Number.isFinite(value)) out[key] = value
  }
  return out
}
