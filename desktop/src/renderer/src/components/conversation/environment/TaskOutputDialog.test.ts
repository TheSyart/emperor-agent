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
