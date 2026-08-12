import { describe, expect, it, vi } from 'vitest'
import { TurnFinalizer } from './turn-finalizer'

function basePorts(trace: string[]) {
  return {
    planSubmissionDecision: () => ({ kind: 'none' as const }),
    independentVerificationFollowup: () => null,
    honestyFollowup: () => null,
    runStopHook: async () => ({
      decision: 'passthrough' as const,
      reason: '',
    }),
    appendHistory: (message: Record<string, unknown>) => {
      trace.push(`history:${String(message.content)}`)
    },
    persistStopContinuation: (message: string) => {
      trace.push(`persist-stop:${message}`)
    },
    emitPlanFollowup: async (detail: Record<string, unknown>) => {
      trace.push(
        `followup:${String(detail.hook ?? detail.honesty ?? detail.verification)}`,
      )
    },
    appendExecutionDisclosure: (reply: string) => `${reply}|disclosure`,
    finalizeReplyChanges: async (reply: string) => `${reply}|changes`,
    updateAssistantMessage: (reply: string) => {
      trace.push(`assistant:${reply}`)
    },
    persistAssistant: (reply: string) => {
      trace.push(`persist:${reply}`)
    },
    compact: async () => {
      trace.push('compact')
    },
    completeIteration: () => {
      trace.push('iteration-complete')
    },
    emitCompleted: async (reply: string) => {
      trace.push(`completed:${reply.length}`)
    },
    markIndependentVerificationDelivered: () => {
      trace.push('verification-delivered')
    },
  }
}

describe('TurnFinalizer', () => {
  it('returns reviewer and honesty continuations before running Stop or writing a terminal', async () => {
    const trace: string[] = []
    let reviewer = true
    const ports = basePorts(trace)
    const runStopHook = vi.fn(ports.runStopHook)
    const finalizer = new TurnFinalizer({
      sessionId: 'session_final',
      cwd: '/workspace',
      turnId: 'turn_final',
      ports: {
        ...ports,
        runStopHook,
        independentVerificationFollowup: () =>
          reviewer
            ? {
                plan_id: 'plan_1',
                status: 'required',
                message: 'review first',
              }
            : null,
        honestyFollowup: () => ({ role: 'user', content: 'verify evidence' }),
      },
    })

    expect(await finalizer.finalize('draft')).toEqual({ kind: 'continue' })
    expect(trace).toEqual(['history:review first', 'followup:required'])
    expect(runStopHook).not.toHaveBeenCalled()

    reviewer = false
    trace.length = 0
    expect(await finalizer.finalize('draft')).toEqual({ kind: 'continue' })
    expect(trace).toEqual([
      'history:verify evidence',
      'followup:verification_unrecorded',
    ])
    expect(runStopHook).not.toHaveBeenCalled()
  })

  it('nudges a denying Stop hook once, then performs the terminal write in stable order', async () => {
    const trace: string[] = []
    const ports = basePorts(trace)
    const finalizer = new TurnFinalizer({
      sessionId: 'session_final',
      cwd: '/workspace',
      turnId: 'turn_final',
      ports: {
        ...ports,
        runStopHook: async (input) => {
          trace.push(`stop:${String(input.stopHookActive)}`)
          return {
            decision: 'deny',
            reason: 'tests still running',
            stopReason: 'wait for tests',
          }
        },
      },
    })

    expect(await finalizer.finalize('draft')).toEqual({ kind: 'continue' })
    expect(trace).toEqual([
      'stop:false',
      'history:[Stop hook] wait for tests',
      'persist-stop:[Stop hook] wait for tests',
      'followup:Stop',
    ])

    trace.length = 0
    expect(await finalizer.finalize('draft')).toEqual({
      kind: 'completed',
      reply: 'draft|disclosure|changes',
    })
    expect(trace).toEqual([
      'stop:true',
      'assistant:draft|disclosure|changes',
      'persist:draft|disclosure|changes',
      'compact',
      'iteration-complete',
      `completed:${'draft|disclosure|changes'.length}`,
      'verification-delivered',
    ])
  })

  it('does not emit a completed terminal when persistence or compaction fails', async () => {
    const trace: string[] = []
    const ports = basePorts(trace)
    const finalizer = new TurnFinalizer({
      sessionId: 'session_final',
      cwd: '/workspace',
      turnId: 'turn_final',
      ports: {
        ...ports,
        compact: async () => {
          trace.push('compact')
          throw new Error('compaction failed')
        },
      },
    })

    await expect(finalizer.finalize('draft')).rejects.toThrow(
      'compaction failed',
    )
    expect(trace).not.toContainEqual(expect.stringMatching(/^completed:/))
    expect(trace).not.toContain('verification-delivered')
  })
})
