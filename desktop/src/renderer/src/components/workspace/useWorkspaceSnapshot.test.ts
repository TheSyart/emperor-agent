// @vitest-environment jsdom
import { effectScope, nextTick, ref, type EffectScope } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { core } = vi.hoisted(() => ({ core: vi.fn() }))
vi.mock('../../api/http', () => ({ core }))

import {
  bindWorkspaceSnapshotSource,
  resetWorkspaceSnapshotForTest,
  useWorkspaceSnapshot,
  WORKSPACE_POLL_MS,
  WORKSPACE_REFRESH_DEBOUNCE_MS,
} from './useWorkspaceSnapshot'

function snapshotOf(sessionId: string, git: unknown = null) {
  return {
    sessionId,
    capturedAt: 1,
    project: { name: 'demo', path: `/tmp/${sessionId}` },
    git,
    terminals: [],
    worktrees: { owned: [] },
    gitReceipts: [],
  }
}

const sessionId = ref('s1')
const projectPath = ref('/tmp/demo')
const refreshKey = ref(0)
const scopes: EffectScope[] = []

function consumer(active?: () => boolean) {
  const scope = effectScope()
  scopes.push(scope)
  const view = scope.run(() => useWorkspaceSnapshot(active ? { active } : {}))!
  return { view, stop: () => scope.stop() }
}

function snapshotCalls(): number {
  return core.mock.calls.filter(([op]) => op === 'workspace.snapshot').length
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  resetWorkspaceSnapshotForTest()
  sessionId.value = 's1'
  projectPath.value = '/tmp/demo'
  refreshKey.value = 0
  core.mockImplementation((_op: string, payload: { sessionId: string }) =>
    Promise.resolve(snapshotOf(payload.sessionId)),
  )
  bindWorkspaceSnapshotSource({
    sessionId: () => sessionId.value,
    projectPath: () => projectPath.value,
    refreshKey: () => refreshKey.value,
  })
})

afterEach(() => {
  for (const scope of scopes.splice(0)) scope.stop()
  resetWorkspaceSnapshotForTest()
  core.mockReset()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('useWorkspaceSnapshot', () => {
  it('shares one snapshot and polls only while a consumer is active', async () => {
    const first = consumer()
    const second = consumer()
    await settle()
    expect(snapshotCalls()).toBeGreaterThanOrEqual(1)
    expect(first.view.snapshot.value?.sessionId).toBe('s1')
    expect(second.view.snapshot.value).toBe(first.view.snapshot.value)
    expect(first.view.hasProject.value).toBe(true)
    expect(first.view.projectPath.value).toBe('/tmp/s1')

    const before = snapshotCalls()
    await vi.advanceTimersByTimeAsync(WORKSPACE_POLL_MS)
    expect(snapshotCalls()).toBe(before + 1)

    first.stop()
    await vi.advanceTimersByTimeAsync(WORKSPACE_POLL_MS)
    expect(snapshotCalls()).toBe(before + 2)

    second.stop()
    await vi.advanceTimersByTimeAsync(WORKSPACE_POLL_MS * 3)
    expect(snapshotCalls()).toBe(before + 2)
  })

  it('counts a consumer only while its `active` flag is on', async () => {
    const open = ref(false)
    const { view } = consumer(() => open.value)
    await settle()
    expect(snapshotCalls()).toBe(0)
    expect(view.snapshot.value).toBeNull()
    open.value = true
    await settle()
    expect(snapshotCalls()).toBe(1)
    open.value = false
    await settle()
    await vi.advanceTimersByTimeAsync(WORKSPACE_POLL_MS * 2)
    expect(snapshotCalls()).toBe(1)
  })

  it('never polls a session without a project', async () => {
    projectPath.value = ''
    const { view } = consumer()
    await settle()
    await vi.advanceTimersByTimeAsync(WORKSPACE_POLL_MS)
    expect(snapshotCalls()).toBe(0)
    expect(view.hasProject.value).toBe(false)
  })

  it('debounces refresh-key bumps', async () => {
    consumer()
    await settle()
    const before = snapshotCalls()
    refreshKey.value += 1
    await settle()
    refreshKey.value += 1
    await settle()
    await vi.advanceTimersByTimeAsync(WORKSPACE_REFRESH_DEBOUNCE_MS - 1)
    expect(snapshotCalls()).toBe(before)
    await vi.advanceTimersByTimeAsync(1)
    expect(snapshotCalls()).toBe(before + 1)
  })

  it('drops a reply that lands after the session switched', async () => {
    let release: (value: unknown) => void = () => undefined
    core.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve
        }),
    )
    const { view } = consumer()
    await settle()
    sessionId.value = 's2'
    await settle()
    release(snapshotOf('s1'))
    await settle()
    expect(view.snapshot.value?.sessionId).toBe('s2')
    expect(view.loading.value).toBe(false)
  })
})
