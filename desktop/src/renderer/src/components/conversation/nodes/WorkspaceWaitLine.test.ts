// @vitest-environment jsdom
/**
 * AGT-06 card test 9 in the conversation: a main-session write that has
 * waited 10 seconds for a subagent's workspace says so under its tool row,
 * and 「停止它」 stops that subagent so the write goes on.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick } from 'vue'

const { listeners, interruptDelegation } = vi.hoisted(() => ({
  listeners: [] as ((event: unknown) => void)[],
  interruptDelegation: vi.fn(async () => ({ requested: true })),
}))
vi.mock('../../../api/backend', () => ({
  onCoreEvent: (listener: (event: unknown) => void) => {
    listeners.push(listener)
    return () => undefined
  },
}))
vi.mock('../../../api/delegations', () => ({ interruptDelegation }))

import { workspaceWaitFor } from './workspaceWaits'
import WorkspaceWaitLine from './WorkspaceWaitLine.vue'

const emit = (event: Record<string, unknown>) => {
  for (const listener of listeners) listener(event)
}
let container: HTMLDivElement | null = null
afterEach(() => {
  container?.remove()
  container = null
})

describe('waiting for a subagent’s workspace', () => {
  it('9 · shows who holds the workspace and stops it on request', async () => {
    const wait = workspaceWaitFor('call-write')
    expect(wait.value).toBeUndefined()
    emit({
      event: 'workspace_wait',
      session_id: 'root',
      call_id: 'call-write',
      delegation_id: 'dlg-x',
      run_id: 'dgr-x',
      backend: 'codex',
      title: '重构登录页',
      waiting: true,
    })
    expect(wait.value).toMatchObject({ delegationId: 'dlg-x', runId: 'dgr-x' })
    container = document.createElement('div')
    document.body.appendChild(container)
    // As under the tool row: the line shows while the call waits.
    createApp({
      render: () =>
        wait.value ? h(WorkspaceWaitLine, { wait: wait.value }) : null,
    }).mount(container)
    await nextTick()
    expect(container.textContent).toContain('正在等待子智能体释放工作区')
    const stop =
      container.querySelector<HTMLButtonElement>('[data-stop-holder]')!
    expect(stop.textContent?.trim()).toBe('停止它')
    stop.click()
    await nextTick()
    expect(interruptDelegation).toHaveBeenCalledWith({
      id: 'dlg-x',
      runId: 'dgr-x',
      sessionId: 'root',
    })
    emit({ event: 'workspace_wait', call_id: 'call-write', waiting: false })
    expect(wait.value).toBeUndefined()
    await nextTick()
    expect(container.querySelector('[data-workspace-wait]')).toBeNull()
  })
})
