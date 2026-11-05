import { describe, expect, it } from 'vitest'
import {
  CoordinatorError,
  parseCoordinatorResult,
  validateCoordinatorResult,
} from './coordinator'
import type { GroupMember, GroupTask } from './types'

const ROSTER: GroupMember[] = [
  { id: 'ct-arch', name: '架构师', intro: '系统设计' },
  { id: 'ct-rev', name: '审稿人', intro: '评审' },
  { id: 'ct-codex', name: 'Codex', intro: '外部', external: true },
]

function task(to = 'ct-arch'): GroupTask {
  return {
    taskId: 'gt-1',
    to,
    title: '核对契约',
    deliverable: '契约清单',
    access: 'readonly',
    state: 'queued',
    confirmed: false,
  }
}

describe('the built-in coordinator contract', () => {
  it('parses member names into a relay plan', () => {
    expect(
      parseCoordinatorResult(
        '{"kind":"relay","speakers":["架构师","ct-rev"],"note":"先设计，再评审"}',
        ROSTER,
      ),
    ).toEqual({
      kind: 'relay',
      speakers: ['ct-arch', 'ct-rev'],
      note: '先设计，再评审',
    })
  })

  it('parses independent answers without confusing them with engineering parallelism', () => {
    expect(
      parseCoordinatorResult(
        '{"kind":"independent","speakers":["架构师","审稿人"]}',
        ROSTER,
      ),
    ).toEqual({ kind: 'independent', speakers: ['ct-arch', 'ct-rev'] })
  })

  it('normalizes simple sequential tasks and never trusts model task state or confirmation', () => {
    const result = parseCoordinatorResult(
      JSON.stringify({
        kind: 'tasks',
        tasks: [
          {
            to: '架构师',
            title: '核对契约',
            deliverable: '契约清单',
            access: 'readonly',
            state: 'done',
            confirmed: true,
            dependsOn: ['not-supported-in-CG-00'],
          },
          {
            to: 'ct-codex',
            title: '提出修改',
            deliverable: '候选差异',
            access: 'isolated_worktree',
          },
        ],
      }),
      ROSTER,
    )
    expect(result.kind).toBe('tasks')
    if (result.kind !== 'tasks') return
    expect(result.tasks).toHaveLength(2)
    expect(result.tasks[0]).toMatchObject({
      to: 'ct-arch',
      state: 'queued',
      confirmed: false,
      access: 'readonly',
    })
    expect(result.tasks[0]).not.toHaveProperty('dependsOn')
    expect(result.tasks[0]!.taskId).not.toBe(result.tasks[1]!.taskId)
    expect(result.tasks[1]).toMatchObject({
      to: 'ct-codex',
      state: 'queued',
      confirmed: false,
      access: 'isolated_worktree',
    })
  })

  it.each(['answer', 'clarify', 'close'] as const)('parses %s text', (kind) => {
    expect(
      parseCoordinatorResult(
        JSON.stringify({ kind, text: '需要你先确认目标。' }),
        ROSTER,
      ),
    ).toEqual({ kind, text: '需要你先确认目标。' })
  })

  it('rejects malformed JSON, unknown speakers and an empty plan', () => {
    for (const text of [
      'not json',
      '{"kind":"relay","speakers":["陌生人"]}',
      '{"kind":"relay","speakers":[]}',
      '{"kind":"independent","speakers":["架构师","架构师"]}',
    ])
      expect(() => parseCoordinatorResult(text, ROSTER)).toThrow(
        CoordinatorError,
      )
  })

  it('rejects invalid tasks rather than executing the valid subset', () => {
    expect(() =>
      validateCoordinatorResult(
        { kind: 'tasks', tasks: [task(), task('ct-ghost')] },
        ROSTER,
      ),
    ).toThrow(/不在群里/)
    expect(() =>
      validateCoordinatorResult(
        {
          kind: 'tasks',
          tasks: [{ ...task(), access: 'group_files' as never, title: '' }],
        },
        ROSTER,
      ),
    ).toThrow(CoordinatorError)
  })

  it('rejects injected members and invalid task access at the Core boundary', () => {
    expect(() =>
      validateCoordinatorResult(
        { kind: 'relay', speakers: ['ct-arch', 'ct-ghost'] },
        ROSTER,
      ),
    ).toThrow(/不在群里/)
    expect(() =>
      validateCoordinatorResult(
        { kind: 'tasks', tasks: [{ ...task(), access: 'root' as never }] },
        ROSTER,
      ),
    ).toThrow(/权限/)
  })
})
