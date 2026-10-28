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

  describe('a group (GRP-16)', () => {
    function groupSessions(sessions: SessionStore, groupId = 'grp-review0001') {
      const group = sessions.create('评审', {
        id: groupId,
        surface: 'group',
        groupId,
      })
      const members = ['ct-arch', 'ct-rev'].map((contactId) =>
        sessions.create(`${contactId} · 评审`, {
          surface: 'group_member',
          contactId,
          groupId,
        }),
      )
      return { group, members, ids: [group.id, ...members.map((m) => m.id)] }
    }

    it('trashes the group and its member sessions together, the last ones too', () => {
      const { service, sessions, calls } = setup()
      const { group, ids } = groupSessions(sessions)

      expect(service.deleteGroup(group.id)).toMatchObject({
        deleted: true,
        restorable: true,
      })
      expect(sessions.list({ includeArchived: true })).toEqual([])
      for (const id of ids) {
        expect(calls).toContain(`unload:${id}`)
        expect(calls).toContain(`terminals:${id}`)
      }
      const raw = sessions.listTrashed()
      expect(raw.map((item) => item.id).sort()).toEqual([...ids].sort())
      expect(new Set(raw.map((item) => item.deleted_at)).size).toBe(1)
      // 最近删除 lists the group alone.
      expect(service.listDeleted()).toEqual([
        expect.objectContaining({ id: group.id, surface: 'group' }),
      ])
    })

    it('restores the group with its member sessions', async () => {
      const { service, sessions } = setup()
      sessions.create('另一个对话')
      const { group, ids } = groupSessions(sessions)
      service.deleteGroup(group.id)

      await expect(service.restoreDeleted(group.id)).resolves.toMatchObject({
        id: group.id,
        surface: 'group',
      })
      expect(
        sessions
          .list({ includeArchived: true })
          .filter((item) => item.group_id === group.id)
          .map((item) => item.id)
          .sort(),
      ).toEqual([...ids].sort())
      expect(sessions.listTrashed()).toEqual([])
    })

    it('purges the group with its member sessions and its files', async () => {
      const forgetGroup = vi.fn(async () => undefined)
      const { service, sessions, calls } = setup({ forgetGroup })
      sessions.create('另一个对话')
      const { group, members } = groupSessions(sessions)
      service.deleteGroup(group.id)

      await expect(service.purgeDeleted(group.id)).resolves.toEqual({
        purged: true,
      })
      expect(sessions.listTrashed()).toEqual([])
      expect(forgetGroup).toHaveBeenCalledWith(group.id)
      for (const member of members)
        expect(calls).toContain(`turn-files:${member.id}`)
    })

    it('expires the group and its member sessions together', async () => {
      const forgetGroup = vi.fn(async () => undefined)
      const { service, sessions } = setup({ forgetGroup })
      sessions.create('另一个对话')
      const { group, ids } = groupSessions(sessions)
      service.deleteGroup(group.id)

      const purged = await service.purgeExpiredDeleted(
        Date.now() + 31 * 24 * 60 * 60 * 1000,
      )
      expect(purged.sort()).toEqual([...ids].sort())
      expect(forgetGroup).toHaveBeenCalledWith(group.id)
    })

    it('still lists a member session deleted on its own', async () => {
      const { service, sessions } = setup()
      const { members } = groupSessions(sessions)
      await service.delete(members[0]!.id)
      expect(service.listDeleted().map((item) => item.id)).toEqual([
        members[0]!.id,
      ])
    })

    it('refuses a session that is not a group', () => {
      const { service, deps } = setup()
      const chat = service.create({ title: 'Chat' })
      service.create({ title: 'Keeper' })
      expect(() => service.deleteGroup(chat.id)).toThrow()
      expect(() => service.deleteGroup('grp-none')).toThrow()
      expect(deps.unloadSession).not.toHaveBeenCalled()
    })
  })
})
