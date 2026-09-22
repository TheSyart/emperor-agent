import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { SessionStore } from '../sessions/store'
import { SessionTransitionService } from './session-transition'

function setup() {
  const stateRoot = mkdtempSync(join(tmpdir(), 'emperor-clear-'))
  const sessions = new SessionStore(stateRoot)
  const parent = sessions.create('Old conversation', {
    mode: 'build',
    project: {
      project_id: 'project-1',
      project_path: '/workspace/project',
      project_name: 'project',
    },
  })
  const runSessionEnd = vi.fn(async () => undefined)
  const activate = vi.fn((sessionId: string) => sessions.get(sessionId))
  const inheritWorkspaceBinding = vi.fn()
  const service = new SessionTransitionService({
    stateRoot,
    sessions,
    assertBoundary: vi.fn(() => undefined),
    runSessionEnd,
    activate,
    inheritWorkspaceBinding,
  })
  return {
    stateRoot,
    sessions,
    parent,
    service,
    runSessionEnd,
    activate,
    inheritWorkspaceBinding,
  }
}

describe('SessionTransitionService', () => {
  it('creates a fresh child session while preserving the old session and project binding', async () => {
    const ctx = setup()
    const result = await ctx.service.clear({
      sessionId: ctx.parent.id,
      invocationId: 'clear-1',
    })

    expect(result.session).toMatchObject({
      mode: 'build',
      project_id: 'project-1',
      parent_session_id: ctx.parent.id,
      lineage_root_id: ctx.parent.id,
      transition_reason: 'clear',
      message_count: 0,
      control_pending: null,
    })
    expect(ctx.sessions.get(ctx.parent.id)?.title).toBe('Old conversation')
    expect(ctx.runSessionEnd).toHaveBeenCalledWith(ctx.parent.id, 'clear')
    expect(ctx.inheritWorkspaceBinding).toHaveBeenCalledWith(
      ctx.parent.id,
      result.session.id,
    )
    expect(ctx.activate).toHaveBeenCalledWith(result.session.id)
  })

  it('is durable and idempotent for repeated invocation IDs', async () => {
    const ctx = setup()
    const first = await ctx.service.clear({
      sessionId: ctx.parent.id,
      invocationId: 'clear-idempotent',
    })
    const second = await ctx.service.clear({
      sessionId: ctx.parent.id,
      invocationId: 'clear-idempotent',
    })
    expect(second.session.id).toBe(first.session.id)
    expect(ctx.runSessionEnd).toHaveBeenCalledTimes(1)
  })

  it('carries the source permission preset into the new session', async () => {
    const ctx = setup()
    const applyPermissionPreset = vi.fn()
    const service = new SessionTransitionService({
      ...ctx.service.deps,
      permissionPresetOf: (sessionId) =>
        sessionId === ctx.parent.id ? 'full-access' : null,
      applyPermissionPreset,
    })
    const result = await service.clear({
      sessionId: ctx.parent.id,
      invocationId: 'clear-preset',
    })
    expect(applyPermissionPreset).toHaveBeenCalledWith(
      result.session.id,
      'full-access',
    )
    expect(applyPermissionPreset.mock.invocationCallOrder[0]).toBeLessThan(
      ctx.activate.mock.invocationCallOrder.at(-1)!,
    )
  })

  it('checks pending interactions and queued prompts before preparing a transition', async () => {
    const ctx = setup()
    vi.mocked(ctx.service.deps.assertBoundary).mockImplementation(() => {
      throw new Error('pending interaction')
    })
    await expect(
      ctx.service.clear({ sessionId: ctx.parent.id, invocationId: 'blocked' }),
    ).rejects.toThrow('pending interaction')
    expect(ctx.sessions.list({ includeArchived: true })).toHaveLength(1)
  })

  it('recovers a prepared transition after a process restart without losing lineage', async () => {
    const ctx = setup()
    const controlDir = join(ctx.stateRoot, 'control')
    mkdirSync(controlDir, { recursive: true })
    writeFileSync(
      join(controlDir, 'session-transitions.json'),
      `${JSON.stringify(
        {
          version: 1,
          records: [
            {
              version: 1,
              invocationId: 'clear-recover',
              sourceSessionId: ctx.parent.id,
              targetSessionId: 'recovered-child',
              state: 'prepared',
              source: {
                mode: ctx.parent.mode,
                project_id: ctx.parent.project_id,
                project_path: ctx.parent.project_path,
                project_name: ctx.parent.project_name,
                lineage_root_id: ctx.parent.lineage_root_id,
              },
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          ],
        },
        null,
        2,
      )}\n`,
      'utf8',
    )

    const recovered = await ctx.service.recover()

    expect(recovered).toHaveLength(1)
    expect(recovered[0]).toMatchObject({
      id: 'recovered-child',
      parent_session_id: ctx.parent.id,
      lineage_root_id: ctx.parent.id,
      transition_reason: 'clear',
      project_id: 'project-1',
    })
    expect(ctx.runSessionEnd).toHaveBeenCalledTimes(1)
    expect(ctx.activate).toHaveBeenCalledWith('recovered-child')
    expect(ctx.sessions.get(ctx.parent.id)).toMatchObject({
      transitioned_to_session_id: 'recovered-child',
    })

    await expect(ctx.service.recover()).resolves.toEqual([])
  })
})
