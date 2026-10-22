// FIX-06: a goal lands in the session Core started it in, whatever the
// user switched to while the request was in flight.
import { describe, expect, it, vi } from 'vitest'
import type { GoalOperationResult, SessionInfo } from '../types'
import { createGoalStarter } from './goalStart'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => (resolve = done))
  return { promise, resolve }
}

const goal = { id: 'g1', objective: 'ship' } as GoalOperationResult['goal']

function setup(current: { id: string }, drafts: Record<string, SessionInfo>) {
  const pending = deferred<GoalOperationResult>()
  const start = vi.fn(() => pending.promise)
  const apply = vi.fn()
  const startGoal = createGoalStarter({
    currentSessionId: () => current.id,
    draftFor: (id) => drafts[id] ?? null,
    start,
    apply,
  })
  return { pending, start, apply, startGoal }
}

describe('createGoalStarter', () => {
  it('applies the result to the session Core names, not the one now shown (4)', async () => {
    const current = { id: 's-a' }
    const f = setup(current, {})
    const running = f.startGoal('ship')
    current.id = 's-b'
    f.pending.resolve({ accepted: true, goal, sessionId: 's-a' })
    await running
    expect(f.apply).toHaveBeenCalledWith('s-a', expect.anything())
  })

  it('falls back to the session it asked for when Core names none', async () => {
    const current = { id: 's-a' }
    const f = setup(current, {})
    const running = f.startGoal('ship')
    current.id = 's-b'
    f.pending.resolve({ accepted: true, goal })
    await running
    expect(f.apply).toHaveBeenCalledWith('s-a', expect.anything())
  })

  it('sends a draft with its draft description and applies to the real session', async () => {
    const current = { id: 'draft:1' }
    const f = setup(current, {
      'draft:1': {
        id: 'draft:1',
        mode: 'build',
        project_id: 'p',
        project_path: '/p',
        project_name: 'P',
      } as SessionInfo,
    })
    const running = f.startGoal('ship')
    f.pending.resolve({ accepted: true, goal, sessionId: 's-real' })
    await running
    expect(f.start).toHaveBeenCalledWith({
      objective: 'ship',
      sessionId: 'draft:1',
      clientDraftId: 'draft:1',
      draftSession: {
        mode: 'build',
        project: { project_id: 'p', project_path: '/p', project_name: 'P' },
      },
    })
    expect(f.apply).toHaveBeenCalledWith('s-real', expect.anything())
  })

  it("FIX-13 · 2 · a draft's goal takes its preset, never its plan mode", async () => {
    const current = { id: 'draft:2' }
    const f = setup(current, {
      'draft:2': {
        id: 'draft:2',
        mode: 'chat',
        plan: true,
        preset: 'read-only',
      } as SessionInfo,
    })
    const running = f.startGoal('ship')
    f.pending.resolve({ accepted: true, goal, sessionId: 's-real' })
    await running
    expect(f.start).toHaveBeenCalledWith({
      objective: 'ship',
      sessionId: 'draft:2',
      clientDraftId: 'draft:2',
      draftSession: {
        mode: 'chat',
        project: { project_id: null, project_path: null, project_name: null },
        preset: 'read-only',
      },
    })
  })
})
