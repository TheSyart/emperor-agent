import { afterEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { useRuntime } from './composables/useRuntime'
import { toGoalCardViewModel } from './runtime/goalRender'
import { replayGoalRuntimeEvents } from './runtime/reducer'
import type {
  BootstrapPayload,
  RuntimeEventEnvelope,
  RuntimeGoalSummary,
} from './types'

const g = globalThis as unknown as { window?: any }

afterEach(() => {
  delete g.window
  vi.restoreAllMocks()
})

describe('Goal desktop runtime E2E', () => {
  it('keeps live, replay and reload projections identical and session-scoped', () => {
    let listener: ((event: unknown) => void) | null = null
    g.window = fakeWindow({
      invokeCore: async () => ({ ok: true }),
      onCoreEvent: (callback: (event: unknown) => void) => {
        listener = callback
        return () => {
          listener = null
        }
      },
    })
    const events = lifecycleEvents()
    const live = useRuntime(options(events))
    live.switchSession('session-goal')
    for (const event of events) emit(listener, event)

    const replay = replayGoalRuntimeEvents([...events].reverse())
    expect(plain(live.goalProjection)).toEqual(replay)
    expect(live.goalProjection.byId.goal_desktop).toMatchObject({
      status: 'completed',
      phase: 'terminal',
      acceptance: { passed: 1, failed: 0, missing: 0, total: 1 },
    })

    const reloaded = useRuntime(options(events))
    reloaded.switchSession('session-goal')
    reloaded.restoreFromHistory([])
    expect(plain(reloaded.goalProjection)).toEqual(replay)
    expect(reloaded.messages.value).toEqual([])
  })

  it('projects pause/resume/awaiting/terminal action semantics without stale actions', () => {
    const paused = toGoalCardViewModel({ goal: summary({ phase: 'paused' }) })
    const awaiting = toGoalCardViewModel({
      goal: summary({ phase: 'awaiting_user' }),
    })
    const resumed = toGoalCardViewModel({
      goal: summary({ phase: 'executing' }),
    })
    const terminal = toGoalCardViewModel({
      goal: summary({ status: 'cancelled', phase: 'terminal' }),
    })

    expect(paused.actions).toEqual(['resume', 'cancel'])
    expect(paused.notice).toContain('重启不会自动写入')
    expect(awaiting.actions).toEqual(['cancel'])
    expect(awaiting.notice).toContain('Ask 或 Plan')
    expect(resumed.actions).toEqual(['pause', 'cancel'])
    expect(terminal.actions).toEqual([])
    expect(terminal.terminal).toBe(true)
  })

  it('uses stopRuntime over IPC and settles the visible runtime while Core pauses the Goal', async () => {
    const calls: unknown[][] = []
    g.window = fakeWindow({
      invokeCore: async (...args: unknown[]) => {
        calls.push(args)
        if (args[0] === 'chat.stopRuntime') {
          return {
            cancelled: ['goal:goal_desktop'],
            active: [],
          }
        }
        return { ok: true }
      },
      onCoreEvent: () => () => {},
    })
    const runtime = useRuntime(options([]))
    runtime.switchSession('session-goal')

    await expect(runtime.stopActive()).resolves.toBe(true)
    expect(calls).toContainEqual(['chat.stopRuntime', {}])
    expect(runtime.busy.value).toBe(false)
    expect(runtime.pending).toMatchObject({
      label: '已请求停止',
      tone: 'done',
    })
  })

  it('ignores stale replay after terminal and never renders internal paths or raw output', () => {
    const events = lifecycleEvents()
    const replay = replayGoalRuntimeEvents([
      ...events,
      {
        ...events[0]!,
        seq: 99,
        last_event_seq: 1,
        goal: summary({
          status: 'active',
          phase: 'executing',
          lastEventSeq: 1,
        }),
      },
    ])
    const card = toGoalCardViewModel({
      goal: replay.byId.goal_desktop!,
      evidence: replay.latestEvidenceByGoal.goal_desktop,
      gate: replay.latestGateByGoal.goal_desktop,
    })
    const rendered = JSON.stringify(card)

    expect(card.terminal).toBe(true)
    expect(rendered).not.toContain('/Users/private')
    expect(rendered).not.toContain('raw tool output')
    expect(rendered).not.toContain('lastEventSeq')
  })
})

function lifecycleEvents(): RuntimeEventEnvelope[] {
  return [
    {
      event: 'goal_created',
      seq: 1,
      goal_id: 'goal_desktop',
      session_id: 'session-goal',
      last_event_seq: 1,
      updated_at: '2026-07-16T10:00:00.000Z',
      goal: summary(),
    },
    {
      event: 'goal_paused',
      seq: 2,
      goal_id: 'goal_desktop',
      session_id: 'session-goal',
      last_event_seq: 2,
      updated_at: '2026-07-16T10:01:00.000Z',
      goal: summary({ phase: 'paused', lastEventSeq: 2 }),
      reason: 'user_stop',
    },
    {
      event: 'goal_resumed',
      seq: 3,
      goal_id: 'goal_desktop',
      session_id: 'session-goal',
      last_event_seq: 3,
      updated_at: '2026-07-16T10:02:00.000Z',
      goal: summary({ phase: 'executing', lastEventSeq: 3 }),
    },
    {
      event: 'goal_evidence_recorded',
      seq: 4,
      goal_id: 'goal_desktop',
      session_id: 'session-goal',
      last_event_seq: 4,
      updated_at: '2026-07-16T10:03:00.000Z',
      criterion_id: 'AC-1',
      verdict: 'pass',
      source_count: 1,
      summary: 'focused tests passed',
    },
    {
      event: 'goal_gate_evaluated',
      seq: 5,
      goal_id: 'goal_desktop',
      session_id: 'session-goal',
      last_event_seq: 5,
      updated_at: '2026-07-16T10:04:00.000Z',
      passed: true,
      reason_codes: [],
      reason_count: 0,
    },
    {
      event: 'goal_completed',
      seq: 6,
      goal_id: 'goal_desktop',
      session_id: 'session-goal',
      last_event_seq: 6,
      updated_at: '2026-07-16T10:05:00.000Z',
      goal: summary({
        status: 'completed',
        phase: 'terminal',
        lastEventSeq: 6,
        acceptance: { passed: 1, failed: 0, missing: 0, total: 1 },
      }),
      summary: 'completed',
    },
  ]
}

function summary(
  overrides: Partial<RuntimeGoalSummary> = {},
): RuntimeGoalSummary {
  return {
    id: 'goal_desktop',
    status: 'active',
    phase: 'executing',
    outcome: 'Ship deterministic Goal mode',
    sessionId: 'session-goal',
    currentPlanId: 'plan-goal',
    cyclesUsed: 2,
    acceptance: { passed: 0, failed: 0, missing: 1, total: 1 },
    createdAt: '2026-07-16T09:58:00.000Z',
    updatedAt: '2026-07-16T10:00:00.000Z',
    lastEventSeq: 1,
    ...overrides,
  }
}

function options(events: RuntimeEventEnvelope[]) {
  const boot = ref({
    app: 'Emperor Agent',
    runtime: {
      sessionId: 'session-goal',
      events,
      latestSeq: events.reduce(
        (max, event) => Math.max(max, Number(event.seq || 0)),
        0,
      ),
      active_tasks: [],
      busy: false,
    },
    goals: {
      active: events.length ? summary() : null,
      recent: events.length ? [summary()] : [],
    },
  } as unknown as BootstrapPayload)
  return {
    boot,
    refreshMemory: vi.fn(async () => {}),
    showToast: vi.fn(),
  }
}

function fakeWindow(emperor: Record<string, unknown>) {
  return {
    emperor,
    clearTimeout,
    setTimeout,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }
}

function emit(listener: ((event: unknown) => void) | null, event: unknown) {
  if (!listener) throw new Error('Core event listener is not connected')
  listener(event)
}

function plain(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value))
}
