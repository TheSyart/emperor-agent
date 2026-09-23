import { describe, expect, it } from 'vitest'
import { EMPTY_CHAT_SNAPSHOT } from './chatSnapshot'
import {
  planArgument,
  planHeading,
  planSummary,
  type PlanSummary,
} from './planSummary'
import { LogBuilder, replay } from './testing/fixtures'

const PLAN = '# 重做环境信息卡\n\n## 步骤\n- 抽出快照\n- 画卡片'

function presented(log: LogBuilder, callId: string, plan = PLAN): void {
  log.call(1, 1, callId, 'exit_plan_mode', { plan })
}

function summaryOf(log: LogBuilder): PlanSummary | null {
  return planSummary(replay(log.events).snapshot)
}

function start(): LogBuilder {
  const log = new LogBuilder()
  log.user('u1', '先出计划')
  log.add('turn/start', { turn: 1 })
  log.add('step/start', { turn: 1, step: 1 })
  return log
}

describe('planSummary', () => {
  it('reports nothing without an exit_plan_mode call', () => {
    expect(planSummary(null)).toBeNull()
    expect(planSummary(EMPTY_CHAT_SNAPSHOT)).toBeNull()
    const log = start()
    log.call(1, 1, 'call_read', 'read', { file_path: 'a.ts' })
    expect(summaryOf(log)).toBeNull()
  })

  it('is reviewing while the plan waits for approval, titled by its heading', () => {
    const log = start()
    presented(log, 'call_plan')
    const summary = summaryOf(log)
    expect(summary).toMatchObject({
      callId: 'call_plan',
      title: '重做环境信息卡',
      status: 'reviewing',
      steps: { done: 0, total: 0 },
    })
    expect(summary?.key).toBeTruthy()
  })

  it('prefers the approved meta title and tracks todo progress', () => {
    const log = start()
    presented(log, 'call_plan')
    log.result(1, 1, 'call_plan', 'Plan approved', {
      meta: { approved: true, title: '批准后的标题' },
    })
    log.add('step/end', { turn: 1, step: 1 })
    expect(summaryOf(log)).toMatchObject({
      title: '批准后的标题',
      status: 'approved',
    })
    log.add('todo/write', {
      todos: [
        { content: '抽出快照', status: 'completed' },
        { content: '画卡片', status: 'in_progress' },
      ],
    })
    expect(summaryOf(log)).toMatchObject({
      status: 'executing',
      steps: { done: 1, total: 2 },
    })
    log.add('todo/write', {
      todos: [
        { content: '抽出快照', status: 'completed' },
        { content: '画卡片', status: 'completed' },
      ],
    })
    expect(summaryOf(log)).toMatchObject({
      status: 'done',
      steps: { done: 2, total: 2 },
    })
  })

  it('marks a rejected review as revising and follows the latest plan', () => {
    const log = start()
    presented(log, 'call_first', '# 第一版')
    log.add(
      'tool/result',
      {
        turn: 1,
        step: 1,
        message: {
          id: 'result-call_first',
          role: 'user',
          source: { kind: 'tool', callId: 'call_first' },
          content: [
            {
              type: 'tool-result',
              toolCallId: 'call_first',
              content: [{ type: 'text', text: 'keep planning' }],
              isError: true,
            },
          ],
        },
        error: { name: 'ToolError', code: 'PLAN_REJECTED' },
      },
      { surfaceOp: 'append' },
    )
    expect(summaryOf(log)).toMatchObject({
      title: '第一版',
      status: 'revising',
    })
    presented(log, 'call_second', '# 第二版')
    expect(summaryOf(log)).toMatchObject({
      callId: 'call_second',
      title: '第二版',
      status: 'reviewing',
    })
  })

  it('falls back to an untitled plan', () => {
    const log = start()
    presented(log, 'call_plan', 'no heading here')
    expect(summaryOf(log)?.title).toBe('未命名计划')
  })
})

describe('plan argument helpers', () => {
  it('reads the plan from complete or truncated arguments', () => {
    expect(planArgument(JSON.stringify({ plan: PLAN }))).toBe(PLAN)
    // `{"plan":"# 重做环境` — cut inside the heading.
    const truncated = JSON.stringify({ plan: PLAN }).slice(0, 15)
    expect(planHeading(planArgument(truncated))).toBe('重做环境')
    expect(planArgument('{"other":1}')).toBe('')
    expect(planArgument('not json')).toBe('')
  })

  it('finds the first markdown heading', () => {
    expect(planHeading('intro\n## 标题 ##\n# 次要')).toBe('标题')
    expect(planHeading('plain text')).toBeUndefined()
  })
})
