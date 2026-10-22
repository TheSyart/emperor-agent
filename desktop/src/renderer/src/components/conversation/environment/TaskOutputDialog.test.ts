// @vitest-environment jsdom
import { createApp, h, nextTick } from 'vue'
import { afterEach, expect, it, vi } from 'vitest'
import TaskOutputDialog from './TaskOutputDialog.vue'
const mock = vi.hoisted(() => ({
  core: vi.fn(),
  listener: undefined as ((event: unknown) => void) | undefined,
  unsubscribe: vi.fn(),
}))
vi.mock('../../../api/http', () => ({ core: mock.core }))
vi.mock('../../../api/backend', () => ({
  onCoreEvent: (listener: (event: unknown) => void) => {
    mock.listener = listener
    return mock.unsubscribe
  },
}))
let app: ReturnType<typeof createApp> | undefined
afterEach(() => {
  app?.unmount()
  document.body.innerHTML = ''
  vi.useRealTimers()
  vi.clearAllMocks()
})
it('follows durable external output automatically and never reads foreign session events', async () => {
  vi.useFakeTimers()
  mock.core
    .mockResolvedValueOnce({
      entries: [{ role: 'assistant', content: 'Hello ' }],
      eof: true,
    })
    .mockResolvedValueOnce({
      entries: [{ role: 'assistant', content: 'world' }],
      eof: true,
    })
  const root = document.createElement('div')
  document.body.append(root)
  app = createApp({
    render: () =>
      h(TaskOutputDialog, {
        taskId: 'dgr-live',
        label: 'Codex',
        kind: 'external-agent',
        sessionId: 'root',
        live: true,
      }),
  })
  app.mount(root)
  for (let i = 0; i < 8; i++) await nextTick()
  mock.listener?.({
    event: 'delegation_output',
    run_id: 'dgr-live',
    session_id: 'foreign',
  })
  await vi.runAllTimersAsync()
  expect(mock.core).toHaveBeenCalledTimes(1)
  mock.listener?.({
    event: 'delegation_output',
    run_id: 'dgr-live',
    session_id: 'root',
  })
  await vi.runAllTimersAsync()
  await nextTick()
  expect(mock.core).toHaveBeenLastCalledWith(
    'tasks.transcript',
    'dgr-live',
    expect.objectContaining({ offset: 1, sessionId: 'root' }),
  )
  expect(document.querySelector('[data-task-output]')?.textContent).toContain(
    'Hello world',
  )
})

// UI-S05: 「停止」 lives in the dialog, not on the card's task lines.
function mountDialog(props: Record<string, unknown>) {
  const root = document.createElement('div')
  document.body.append(root)
  app = createApp({
    render: () =>
      h(TaskOutputDialog, {
        taskId: 'job-dev',
        label: 'npm run dev',
        kind: 'job',
        live: true,
        ...props,
      }),
  })
  app.mount(root)
}
function stopButton(): HTMLButtonElement | undefined {
  return [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent?.trim() === '停止',
  )
}
it('stops a running job from the dialog and reports it', async () => {
  mock.core.mockResolvedValue({ entries: [], eof: true })
  const onStopped = vi.fn()
  mountDialog({ stoppable: true, onStopped })
  for (let i = 0; i < 4; i++) await nextTick()
  stopButton()!.click()
  for (let i = 0; i < 8; i++) await Promise.resolve()
  expect(mock.core).toHaveBeenCalledWith('tasks.cancel', 'job-dev', {
    reason: 'user_stopped_from_environment_card',
  })
  expect(onStopped).toHaveBeenCalledOnce()
})
it('asks before stopping a workflow run, and 取消 keeps it running', async () => {
  mock.core.mockResolvedValue({ entries: [], eof: true })
  const { answerConfirmsForTest } = await import('../../ui/confirm')
  const asked: string[] = []
  answerConfirmsForTest((options) => {
    asked.push(options.title)
    return false
  })
  try {
    mountDialog({
      taskId: 'wf-run',
      label: '修复视觉回归',
      kind: 'workflow',
      stoppable: true,
      confirmStop: true,
    })
    for (let i = 0; i < 4; i++) await nextTick()
    stopButton()!.click()
    for (let i = 0; i < 8; i++) await Promise.resolve()
    expect(asked).toEqual(['停止工作流「修复视觉回归」？'])
    expect(mock.core).not.toHaveBeenCalledWith(
      'tasks.cancel',
      expect.anything(),
      expect.anything(),
    )
  } finally {
    answerConfirmsForTest(null)
  }
})
it('has no 停止 for a finished task', async () => {
  mock.core.mockResolvedValue({ entries: [], eof: true })
  mountDialog({ live: false, stoppable: false })
  for (let i = 0; i < 4; i++) await nextTick()
  expect(stopButton()).toBeUndefined()
})
