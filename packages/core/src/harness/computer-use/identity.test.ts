import { describe, expect, it } from 'vitest'
import { contextMessage, userText } from '../../llm/message'
import type { SessionEvent } from '../../session-log/types'
import type { Agent } from '../agent/agent'
import { GOAL_ROUND_PRODUCER } from '../goal/round-driver'
import { currentTurnInfo, currentTurnSource } from '../host/turn-source'
import type { SandboxMode } from '../sandbox/policy'
import { UiError } from './errors'
import { resolveIdentity } from './identity'

let seq = 0
function ev<T extends SessionEvent['type']>(
  type: T,
  data: Extract<SessionEvent, { type: T }>['data'],
): SessionEvent {
  seq += 1
  return { seq, time: seq, type, data } as SessionEvent
}

function userTurn(
  turn: number,
  meta?: { source?: string; jobId?: string },
): SessionEvent[] {
  const message = userText(`turn ${turn}`)
  return [
    ...(meta === undefined
      ? []
      : [
          ev('host/user-meta', {
            messageId: message.id,
            ...(meta.source === undefined ? {} : { source: meta.source }),
            ...(meta.jobId === undefined
              ? {}
              : { scheduler: { jobId: meta.jobId } }),
          }),
        ]),
    ev('turn/start', { turn }),
    ev('user/message', message),
  ]
}

interface FakeAgent {
  id: string
  owner?: FakeAgent
  session: { events: SessionEvent[] }
  mode: SandboxMode
}

function agent(
  id: string,
  events: SessionEvent[],
  mode: SandboxMode = 'workspace-write',
  owner?: FakeAgent,
): FakeAgent {
  return { id, session: { events }, mode, ...(owner ? { owner } : {}) }
}

const deps = {
  rootOf(value: Agent): Agent {
    let current = value as unknown as FakeAgent
    while (current.owner !== undefined) current = current.owner
    return current as unknown as Agent
  },
  authorizationMode: () => 'scoped' as const,
}

const identity = (
  value: FakeAgent,
  mode: 'scoped' | 'unrestricted' = 'scoped',
) =>
  resolveIdentity(value as unknown as Agent, {
    ...deps,
    authorizationMode: () => mode,
  })

describe('currentTurnInfo', () => {
  it('reads the source and scheduler job of the latest turn only', () => {
    const events = [
      ...userTurn(1, { source: 'scheduler', jobId: 'job-a' }),
      ev('turn/end', { turn: 1, reason: { kind: 'completed' } }),
      ...userTurn(2),
    ]
    expect(currentTurnInfo(events)).toEqual({ turn: 2, goalRound: false })
    expect(currentTurnSource(events)).toBeUndefined()
    const scheduled = [
      ...events,
      ev('turn/end', { turn: 2, reason: { kind: 'completed' } }),
      ...userTurn(3, { source: 'scheduler', jobId: 'job-b' }),
    ]
    expect(currentTurnInfo(scheduled)).toEqual({
      turn: 3,
      source: 'scheduler',
      schedulerJobId: 'job-b',
      goalRound: false,
    })
  })

  it('recognises a goal round and an empty log', () => {
    expect(currentTurnInfo([])).toEqual({ goalRound: false })
    const events = [
      ev('turn/start', { turn: 4 }),
      ev('user/message', contextMessage(GOAL_ROUND_PRODUCER, '<goal_round/>')),
    ]
    expect(currentTurnInfo(events)).toEqual({ turn: 4, goalRound: true })
  })
})

describe('resolveIdentity', () => {
  it('attributes a root session turn', () => {
    const root = agent('s1', userTurn(2, { source: 'user' }))
    expect(identity(root)).toEqual({
      subject: 'session:s1',
      kind: 'session',
      ownerSessionId: 's1',
      callerSessionId: 's1',
      taskId: 's1:2',
      turn: 2,
      background: false,
      canAsk: true,
      fullAccess: false,
    })
  })

  it('marks subagents as unable to ask and keys them by their own id', () => {
    const root = agent('s1', userTurn(1), 'danger-full-access')
    const child = agent('c1', [], 'danger-full-access', root)
    const id = identity(child, 'unrestricted')
    expect(id).toMatchObject({
      subject: 'subagent:c1',
      kind: 'subagent',
      ownerSessionId: 's1',
      callerSessionId: 'c1',
      taskId: 's1:1',
      canAsk: false,
      background: true,
      fullAccess: true,
    })
  })

  it('keeps GUI access independent of the root and child Shell modes', () => {
    const root = agent('s1', userTurn(1), 'workspace-write')
    const child = agent('c1', [], 'danger-full-access', root)
    expect(identity(child, 'unrestricted').fullAccess).toBe(true)
    const child2 = agent(
      'c2',
      [],
      'read-only',
      agent('s2', userTurn(1), 'danger-full-access'),
    )
    expect(identity(child2, 'unrestricted').fullAccess).toBe(true)
    expect(identity(child2, 'scoped').fullAccess).toBe(false)
  })

  it('attributes scheduler turns to the job and goal rounds as background', () => {
    const scheduled = agent(
      's1',
      userTurn(5, { source: 'scheduler', jobId: 'job-9' }),
    )
    expect(identity(scheduled)).toMatchObject({
      subject: 'scheduler:job-9',
      kind: 'scheduler',
      background: true,
      canAsk: true,
      taskId: 's1:5',
    })
    const goal = agent('s1', [
      ev('turn/start', { turn: 6 }),
      ev('user/message', contextMessage(GOAL_ROUND_PRODUCER, 'next')),
    ])
    expect(identity(goal)).toMatchObject({
      subject: 'session:s1',
      background: true,
    })
  })

  it('refuses host-initiated calls', () => {
    expect(() => resolveIdentity(undefined, deps)).toThrow(UiError)
  })
})
