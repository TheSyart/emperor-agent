import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { SessionStore } from '../../sessions/store'
import { CoreMutationGuardError } from '../mutation-guard'
import {
  CoreSessionApplicationService,
  type SessionApplicationServiceDeps,
} from './session-application-service'

function setup(overrides: Partial<SessionApplicationServiceDeps> = {}) {
  const sessions = new SessionStore(
    mkdtempSync(join(tmpdir(), 'emperor-session-app-')),
  )
  const calls: string[] = []
  const deps: SessionApplicationServiceDeps = {
    sessions,
    resolveProject: (path) => ({ id: 'project_1', path, name: 'demo' }),
    unloadSession: vi.fn((sessionId: string) => {
      calls.push(`unload:${sessionId}`)
    }),
    forgetTurnFiles: vi.fn(async (sessionId: string) => {
      calls.push(`turn-files:${sessionId}`)
    }),
    closeTerminals: vi.fn((sessionId: string) => {
      calls.push(`terminals:${sessionId}`)
    }),
    activateSession: vi.fn((sessionId: string) => sessions.get(sessionId)!),
    ...overrides,
  }
  return {
    sessions,
    deps,
    calls,
    service: new CoreSessionApplicationService(deps),
  }
}

describe('CoreSessionApplicationService', () => {
  it('creates chat and build sessions and requires a project path for build', () => {
    const { service } = setup()
    expect(service.create({ title: 'Chat' }).mode).toBe('chat')
    expect(() => service.create({ mode: 'build' })).toThrow(
      'Build session requires project_path',
    )
    const build = service.create({ mode: 'build', project_path: '/tmp/demo' })
    expect(build.mode).toBe('build')
    expect(service.list().map((entry) => entry.id)).toContain(build.id)
  })

  it('renames, archives and restores; archiving stops a running turn', async () => {
    const stopSession = vi.fn()
    const { service } = setup({ stopSession })
    const entry = service.create({ title: 'One' })
    service.create({ title: 'Two' })
    await expect(service.rename(entry.id, 'Renamed')).resolves.toMatchObject({
      title: 'Renamed',
    })
    await expect(service.rename(entry.id, { title: '  ' })).rejects.toThrow(
      'title is required',
    )
    const archived = await service.rename(entry.id, { archived: true })
    expect(archived.archived_at).toBeTruthy()
    expect(stopSession).toHaveBeenCalledWith(entry.id, 'session archived')
    expect(service.list().map((item) => item.id)).not.toContain(entry.id)
    const restored = await service.rename(entry.id, { archived: false })
    expect(restored.archived_at).toBeNull()
    expect(stopSession).toHaveBeenCalledTimes(1)
  })

  it('unloads the kernel session, trashes the entry and closes terminals on delete', async () => {
    const { service, sessions, calls } = setup()
    const doomed = service.create({ title: 'Doomed' })
    service.create({ title: 'Keeper' })

    await expect(service.delete(doomed.id)).resolves.toMatchObject({
      deleted: true,
      restorable: true,
    })
    expect(sessions.get(doomed.id)).toBeNull()
    expect(calls).toEqual([`unload:${doomed.id}`, `terminals:${doomed.id}`])
    expect(service.listDeleted().map((item) => item.id)).toEqual([doomed.id])
    await expect(service.restoreDeleted(doomed.id)).resolves.toMatchObject({
      id: doomed.id,
      title: 'Doomed',
    })
    await expect(service.restoreDeleted(doomed.id)).rejects.toThrow('无法恢复')
  })

  it('purges a trashed build session with its project snapshots', async () => {
    const { service, calls } = setup()
    service.create({ title: 'Keeper' })
    const build = service.create({ mode: 'build', project_path: '/tmp/demo' })
    await service.delete(build.id)
    await expect(service.purgeDeleted(build.id)).resolves.toEqual({
      purged: true,
    })
    expect(calls.at(-1)).toBe(`turn-files:${build.id}`)
    expect(service.listDeleted()).toEqual([])
  })

  it('refuses to delete the last persisted session or an unknown one', async () => {
    const { service, deps } = setup()
    const only = service.create({ title: 'Only' })
    await expect(service.delete(only.id)).rejects.toBeInstanceOf(
      CoreMutationGuardError,
    )
    await expect(service.delete('missing')).rejects.toThrow(
      'cannot delete session',
    )
    expect(deps.unloadSession).not.toHaveBeenCalled()
  })

  it('activates a session through the host', () => {
    const { service, deps } = setup()
    const entry = service.create({ title: 'Active' })
    expect(service.activate(entry.id)).toEqual({
      active: entry.id,
      complete: true,
    })
    expect(deps.activateSession).toHaveBeenCalledWith(entry.id)
  })
})
