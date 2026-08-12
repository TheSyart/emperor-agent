import { describe, expect, it } from 'vitest'
import { createTurnExecutionContext } from './turn-execution-context'

describe('TurnExecutionContext', () => {
  it('freezes identity, scope and port selection for one queued turn', () => {
    const selected = { sessionId: 'session-a' }
    const context = createTurnExecutionContext({
      identity: {
        sessionId: selected.sessionId,
        turnId: 'turn-a',
        taskId: 'task-a',
        executionId: 'execution-a',
        rootTurnId: 'turn-a',
      },
      scope: {
        mode: 'build',
        workspaceRoot: '/workspace/a',
        projectId: 'project-a',
        projectFingerprint: 'fingerprint-a',
      },
      permissionMode: 'smart_auto',
      executionEnvironment: {} as never,
      hookSnapshot: {} as never,
      promptProjection: {} as never,
      modelRoute: {} as never,
      ports: {
        control: { sessionId: 'session-a' },
        plan: {},
        goal: {},
        todo: {},
        runtime: {},
      },
      eventSink: null,
    })

    selected.sessionId = 'session-b'

    expect(context.identity.sessionId).toBe('session-a')
    expect(context.scope.workspaceRoot).toBe('/workspace/a')
    expect(Object.isFrozen(context)).toBe(true)
    expect(Object.isFrozen(context.identity)).toBe(true)
    expect(Object.isFrozen(context.scope)).toBe(true)
    expect(Object.isFrozen(context.ports)).toBe(true)
    expect(() => {
      ;(context.identity as { sessionId: string }).sessionId = 'forged'
    }).toThrow()
  })
})
