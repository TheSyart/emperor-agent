import { describe, expect, it, vi } from 'vitest'
import { TransitionReason } from './query-state'
import { ModelIterationCoordinator } from './model-iteration-coordinator'

describe('ModelIterationCoordinator', () => {
  it('owns QueryState and preserves continuation transition traces', async () => {
    const sample = vi.fn(async (request: { value: string }) =>
      request.value.toUpperCase(),
    )
    const coordinator = new ModelIterationCoordinator({
      turnId: 'turn_iteration',
      maxTurns: 12,
      maxEmptyRetries: 2,
      maxLengthRecoveries: 2,
      samplingPort: { sample },
    })

    expect(await coordinator.sample({ value: 'model' })).toBe('MODEL')
    expect(coordinator.beginIteration().reason).toBe(TransitionReason.ITERATION)
    expect(coordinator.toolFollowup().reason).toBe(
      TransitionReason.TOOL_FOLLOWUP,
    )
    expect(coordinator.emptyResponseRetry()?.nextState.emptyRetries).toBe(1)
    expect(coordinator.lengthRecovery('partial')?.messages).toEqual([
      {
        role: 'assistant',
        content: 'partial',
        turn_id: 'turn_iteration',
      },
      {
        role: 'user',
        content:
          '（上一轮被 max_tokens 截断，请从中断处续写，不要重复已输出内容）',
      },
    ])
    expect(
      coordinator.todoFollowup({
        unfinishedText: '- verify',
        unfinishedCount: 1,
        maxContinuations: 2,
      })?.reason,
    ).toBe(TransitionReason.TODO_CONTINUATION)
    expect(coordinator.pause(TransitionReason.ASK_PAUSE).nextState.paused).toBe(
      true,
    )
    expect(coordinator.complete().nextState.completed).toBe(true)
    expect(coordinator.state).toMatchObject({
      turnId: 'turn_iteration',
      turnCount: 1,
      emptyRetries: 1,
      lengthRetries: 1,
      todoContinuations: 1,
      paused: true,
      completed: true,
    })
    expect(Object.isFrozen(coordinator.state)).toBe(true)
  })

  it('emits one correction per progress segment and then pauses at the deterministic threshold', () => {
    const coordinator = new ModelIterationCoordinator({
      turnId: 'turn_watchdog',
      maxTurns: null,
      maxEmptyRetries: 2,
      maxLengthRecoveries: 2,
      samplingPort: { sample: async () => null },
    })
    const snapshot = {
      meaningfulProgress: 4,
      successfulChanges: [],
      successfulEvidence: [],
      recentErrors: [],
      repeatedReadCount: 8,
      noProgressIterations: 6,
      lastIterationHadError: false,
    }

    expect(coordinator.evaluateProgress(snapshot, ['next'])).toEqual({
      kind: 'correction',
      message:
        '[CONTROL:NO_PROGRESS_CORRECTION]\n连续 6 次模型迭代没有形成新的有效进展。停止重复读取、重复命令和重复错误；选择新的验证路径并执行一个可验证的新动作。若连续 12 次仍无进展，Core 将暂停本回合。',
    })
    expect(coordinator.evaluateProgress(snapshot, ['next'])).toEqual({
      kind: 'continue',
    })
    expect(
      coordinator.evaluateProgress({ ...snapshot, noProgressIterations: 12 }, [
        'next',
      ]),
    ).toEqual({
      kind: 'pause',
      decision: {
        reasonCode: 'no_progress',
        nextActions: ['next'],
        summary:
          '连续 12 次模型迭代没有形成新的有效进展，Core 已暂停当前执行以阻止重复循环。',
      },
    })
  })

  it('corrects the third consecutive failure of one strategy before the global threshold', () => {
    const coordinator = new ModelIterationCoordinator({
      turnId: 'turn_strategy_watchdog',
      maxTurns: null,
      maxEmptyRetries: 2,
      maxLengthRecoveries: 2,
      samplingPort: { sample: async () => null },
    })
    const snapshot = {
      meaningfulProgress: 0,
      successfulChanges: [],
      successfulEvidence: [],
      recentErrors: ['web_fetch:http_status'],
      repeatedReadCount: 0,
      noProgressIterations: 3,
      lastIterationHadError: true,
      repeatedFailureStrategyKey: 'web_fetch:https://example.com:status',
      repeatedFailureStrategyCount: 3,
    }

    expect(coordinator.evaluateProgress(snapshot, [])).toMatchObject({
      kind: 'correction',
      message: expect.stringContaining('同一策略连续失败 3 次'),
    })
    expect(coordinator.evaluateProgress(snapshot, [])).toEqual({
      kind: 'continue',
    })
  })

  it('preserves near/max-turn boundaries while applying each transition once', () => {
    const coordinator = new ModelIterationCoordinator({
      turnId: 'turn_limit',
      maxTurns: 7,
      maxEmptyRetries: 2,
      maxLengthRecoveries: 2,
      samplingPort: { sample: async () => null },
    })

    expect(coordinator.maxTurnsReached()).toBeNull()
    coordinator.beginIteration()
    coordinator.beginIteration()
    expect(coordinator.nearMaxTurns()?.reason).toBe(
      TransitionReason.NEAR_MAX_TURNS,
    )
    expect(coordinator.nearMaxTurns()).toBeNull()
    for (let index = 0; index < 5; index += 1) coordinator.beginIteration()
    expect(coordinator.maxTurnsReached()?.reason).toBe(
      TransitionReason.MAX_TURNS,
    )
    expect(coordinator.state.completed).toBe(true)
  })
})
