import { afterEach, describe, expect, it, vi } from 'vitest'
import { nextTick, reactive, ref } from 'vue'
import type { BootstrapPayload } from '../types'
import { useRuntime } from './useRuntime'

const g = globalThis as unknown as { window?: any; fetch?: unknown }

afterEach(() => {
  delete g.window
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('useRuntime IPC runtime path (MIG-IPC-010)', () => {
  it('does not attempt the retired WebSocket fallback when the Core IPC bridge is unavailable', () => {
    const showToast = vi.fn()
    const wsCtor = vi.fn()
    vi.stubGlobal('WebSocket', wsCtor)
    g.window = fakeWindow({})
    const runtime = useRuntime({ ...testOptions(), showToast })

    runtime.connectSocket()

    expect(wsCtor).not.toHaveBeenCalled()
    expect(runtime.status.value).toBe('error')
    expect(runtime.pending).toMatchObject({
      label: '桌面 IPC 不可用',
      detail: '请在 Electron 桌面窗口中使用；普通浏览器没有 CoreApi bridge。',
      tone: 'error',
    })
    expect(showToast).toHaveBeenCalledWith('桌面 IPC 不可用，请在 Electron 桌面窗口中使用')
  })

  it('subscribes to core events and submits chat through Core IPC when the bridge is available', async () => {
    const calls: unknown[][] = []
    let listener: ((event: unknown) => void) | null = null
    g.window = fakeWindow({
      invokeCore: async (...args: unknown[]) => {
        calls.push(args)
        if (args[0] === 'chat.submit') {
          const payload = args[1] as Record<string, unknown>
          listener?.({ event: 'user_message', seq: 1, turn_id: 'turn-ipc-1', client_message_id: payload.clientMessageId, content: payload.displayContent || payload.content })
          listener?.({ event: 'assistant_done', seq: 2, turn_id: 'turn-ipc-1', content: 'pong' })
          return { turnId: 'turn-ipc-1', content: 'pong' }
        }
        return { ok: true }
      },
      onCoreEvent: (cb: (event: unknown) => void) => {
        listener = cb
        return () => { listener = null }
      },
    })
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const runtime = useRuntime(testOptions())

    runtime.connectSocket()
    expect(runtime.status.value).toBe('ready')
    runtime.switchSession('s1')
    expect(runtime.sendMessage('hello')).toBe(true)
    await Promise.resolve()

    expect(calls[0]).toEqual(['chat.submit', expect.objectContaining({ content: 'hello', displayContent: 'hello', sessionId: 's1' })])
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(runtime.messages.value.at(-1)).toMatchObject({ role: 'assistant', content: 'pong', streaming: false })
    expect(runtime.busy.value).toBe(false)
  })

  it('does not append an error message when a chat turn pauses for user input', async () => {
    let listener: ((event: unknown) => void) | null = null
    g.window = fakeWindow({
      invokeCore: async (...args: unknown[]) => {
        if (args[0] === 'chat.submit') {
          listener?.({
            event: 'turn_paused',
            seq: 1,
            turn_id: 'turn-paused',
            interaction: { id: 'ask_1', kind: 'ask', status: 'waiting' },
          })
          return { ok: false, error: { message: 'Turn paused', code: 'turn_paused' } }
        }
        return { ok: true }
      },
      onCoreEvent: (cb: (event: unknown) => void) => {
        listener = cb
        return () => { listener = null }
      },
    })
    const runtime = useRuntime(testOptions())

    runtime.switchSession('s1')
    expect(runtime.sendMessage('需要澄清')).toBe(true)
    await flushPromises()

    expect(runtime.messages.value.map((message) => message.content).join('\n')).not.toContain('出错了')
    expect(runtime.busy.value).toBe(false)
    expect(runtime.pending.label).toBe('等待你定夺')
  })

  it('does not append an error message when a stopped chat turn rejects as cancelled', async () => {
    g.window = fakeWindow({
      invokeCore: async (...args: unknown[]) => {
        if (args[0] === 'chat.submit') return { ok: false, error: { message: 'Task cancelled', code: 'cancelled' } }
        return { ok: true }
      },
      onCoreEvent: () => () => {},
    })
    const runtime = useRuntime(testOptions())

    runtime.switchSession('s1')
    expect(runtime.sendMessage('停止我')).toBe(true)
    await flushPromises()

    expect(runtime.messages.value.map((message) => message.content).join('\n')).not.toContain('出错了')
    expect(runtime.busy.value).toBe(false)
  })

  it('does not append an error message when Core rejects a concurrent chat turn as busy', async () => {
    g.window = fakeWindow({
      invokeCore: async (...args: unknown[]) => {
        if (args[0] === 'chat.submit') return { ok: false, error: { message: 'Another agent turn is already running', code: 'turn_busy' } }
        return { ok: true }
      },
      onCoreEvent: () => () => {},
    })
    const runtime = useRuntime(testOptions())

    runtime.switchSession('s1')
    expect(runtime.sendMessage('第二条')).toBe(true)
    await flushPromises()

    expect(runtime.messages.value.map((message) => message.content).join('\n')).not.toContain('出错了')
    expect(runtime.messages.value.map((message) => message.content).join('\n')).toContain('已有任务正在运行')
    expect(runtime.busy.value).toBe(false)
  })

  it('ignores live runtime events from another session without advancing the active replay cursor', async () => {
    let listener: ((event: unknown) => void) | null = null
    g.window = fakeWindow({
      invokeCore: async () => ({ ok: true }),
      onCoreEvent: (cb: (event: unknown) => void) => {
        listener = cb
        return () => { listener = null }
      },
    })
    const runtime = useRuntime(testOptions())

    runtime.switchSession('session-current')
    listener?.({ event: 'message_delta', seq: 99, session_id: 'session-other', turn_id: 'turn-other', delta: 'foreign text' })
    listener?.({ event: 'user_message', seq: 1, session_id: 'session-current', turn_id: 'turn-current', content: 'local user' })
    listener?.({ event: 'message_delta', seq: 2, session_id: 'session-current', turn_id: 'turn-current', delta: 'local answer' })
    listener?.({ event: 'assistant_done', seq: 3, session_id: 'session-current', turn_id: 'turn-current', content: 'local answer' })

    const text = runtime.messages.value.map((message) => message.content).join('\n')
    expect(text).toContain('local user')
    expect(text).toContain('local answer')
    expect(text).not.toContain('foreign text')
  })

  it('drops foreign-session events while a draft session is active, then accepts events for the promoted id', async () => {
    let listener: ((event: unknown) => void) | null = null
    g.window = fakeWindow({
      invokeCore: async () => ({ ok: true }),
      onCoreEvent: (cb: (event: unknown) => void) => {
        listener = cb
        return () => { listener = null }
      },
    })
    const runtime = useRuntime(testOptions())

    runtime.switchSession('draft:pending-1')
    listener?.({ event: 'user_message', seq: 11, session_id: 'session-other', turn_id: 'turn-other', content: 'foreign user' })
    listener?.({ event: 'message_delta', seq: 12, session_id: 'session-other', turn_id: 'turn-other', delta: 'foreign text' })
    listener?.({ event: 'session_created', session: { id: 'session-real' }, client_draft_id: 'draft:pending-1' })
    listener?.({ event: 'user_message', seq: 1, session_id: 'session-real', turn_id: 'turn-real', content: 'real user' })
    listener?.({ event: 'message_delta', seq: 2, session_id: 'session-real', turn_id: 'turn-real', delta: 'real answer' })
    listener?.({ event: 'assistant_done', seq: 3, session_id: 'session-real', turn_id: 'turn-real', content: 'real answer' })

    expect(runtime.sessionId.value).toBe('session-real')
    const text = runtime.messages.value.map((message) => message.content).join('\n')
    expect(text).not.toContain('foreign user')
    expect(text).not.toContain('foreign text')
    expect(text).toContain('real user')
    expect(text).toContain('real answer')
  })

  it('applies control pending changes to the event owner session instead of the currently open session', async () => {
    let listener: ((event: unknown) => void) | null = null
    const pendingChanges: Array<{ sessionId: string; interaction: unknown }> = []
    g.window = fakeWindow({
      invokeCore: async () => ({ ok: true }),
      onCoreEvent: (cb: (event: unknown) => void) => {
        listener = cb
        return () => { listener = null }
      },
    })
    const boot = ref({ app: 'Emperor Agent', runtime: { events: [], latestSeq: 0 }, control: { mode: 'auto', pending: null } } as unknown as BootstrapPayload)
    const runtime = useRuntime({
      ...testOptions(),
      boot,
      onSessionControlPendingChanged: (sessionId, interaction) => {
        pendingChanges.push({ sessionId, interaction: interaction ?? null })
      },
    })

    runtime.switchSession('session-other')
    listener?.({
      event: 'ask_request',
      seq: 1,
      session_id: 'session-owner',
      turn_id: 'turn-owner',
      interaction: { id: 'ask_owner', kind: 'ask', status: 'waiting' },
    })
    expect(boot.value.control?.pending).toEqual(expect.objectContaining({ id: 'ask_owner' }))

    listener?.({
      event: 'ask_answered',
      seq: 2,
      session_id: 'session-owner',
      interaction: { id: 'ask_owner', kind: 'ask', status: 'answered' },
    })

    expect(pendingChanges).toEqual([
      { sessionId: 'session-owner', interaction: expect.objectContaining({ id: 'ask_owner' }) },
      { sessionId: 'session-owner', interaction: null },
    ])
    expect(boot.value.control?.pending).toBeNull()
  })

  it('projects agent_thought events into completed thought segments', async () => {
    let listener: ((event: unknown) => void) | null = null
    g.window = fakeWindow({
      invokeCore: async (...args: unknown[]) => {
        if (args[0] === 'chat.submit') {
          listener?.({ event: 'user_message', seq: 1, turn_id: 'turn-thought', content: 'show image' })
          listener?.({
            event: 'agent_thought',
            seq: 2,
            turn_id: 'turn-thought',
            stage: 'tool_intent',
            label: '思考参考',
            summary: '准备调用 read_file，先确认图片路径。',
            source: 'audit',
            status: 'done',
            tool_call_ids: ['call_1'],
            tool_names: ['read_file'],
          })
          listener?.({ event: 'tool_call', seq: 3, turn_id: 'turn-thought', id: 'call_1', name: 'read_file', arguments: { path: 'screen.png' } })
          listener?.({ event: 'assistant_done', seq: 4, turn_id: 'turn-thought', content: 'done' })
          return { turnId: 'turn-thought', content: 'done' }
        }
        return { ok: true }
      },
      onCoreEvent: (cb: (event: unknown) => void) => {
        listener = cb
        return () => { listener = null }
      },
    })
    const runtime = useRuntime(testOptions())

    runtime.connectSocket()
    runtime.switchSession('s1')
    expect(runtime.sendMessage('show image')).toBe(true)
    await Promise.resolve()

    const assistant = runtime.messages.value.find((message) => message.role === 'assistant')
    const thought = assistant?.segments.find((segment) => segment.type === 'thought' && segment.stage === 'tool_intent')
    expect(thought).toMatchObject({
      type: 'thought',
      status: 'done',
      label: '思考参考',
      summary: '准备调用 read_file，先确认图片路径。',
      source: 'audit',
      toolIds: ['call_1'],
      toolNames: ['read_file'],
    })
  })

  it('keeps tool cards stable for tool_run-only, result-first, and malformed payload events', async () => {
    let listener: ((event: unknown) => void) | null = null
    g.window = fakeWindow({
      invokeCore: async (...args: unknown[]) => {
        if (args[0] === 'chat.submit') {
          listener?.({ event: 'user_message', seq: 1, turn_id: 'turn-tools', content: 'run tools' })
          listener?.({ event: 'tool_run_queued', seq: 2, turn_id: 'turn-tools', id: 'run_1', name: 'unknown_new_tool', arguments: { value: 1 } })
          listener?.({ event: 'tool_run_completed', seq: 3, turn_id: 'turn-tools', id: 'run_1', name: 'unknown_new_tool', summary: 'ok', artifacts: { bad: true }, metadata: 'bad' })
          listener?.({ event: 'tool_run_failed', seq: 4, turn_id: 'turn-tools', id: 'run_2', name: 'grep', message: 'grep failed' })
          listener?.({ event: 'tool_run_cancelled', seq: 5, turn_id: 'turn-tools', id: 'run_3', name: 'run_command', reason: 'cancelled' })
          listener?.({ event: 'tool_result', seq: 6, turn_id: 'turn-tools', id: 'result_first', name: 'read_file', summary: 'late call result', artifacts: [null, { path: 'ok.png', kind: 'image' }] })
          listener?.({ event: 'assistant_done', seq: 7, turn_id: 'turn-tools', content: 'done' })
          return { turnId: 'turn-tools', content: 'done' }
        }
        return { ok: true }
      },
      onCoreEvent: (cb: (event: unknown) => void) => {
        listener = cb
        return () => { listener = null }
      },
    })
    const runtime = useRuntime(testOptions())

    runtime.switchSession('s1')
    expect(runtime.sendMessage('run tools')).toBe(true)
    await flushPromises()

    const assistant = runtime.messages.value.find((message) => message.role === 'assistant')
    const tools = assistant?.segments.filter((segment) => segment.type === 'tool') || []
    expect(tools.map((tool) => tool.name)).toEqual(['unknown_new_tool', 'grep', 'run_command', 'read_file'])
    expect(tools[0]).toMatchObject({ status: 'done', summary: 'ok' })
    expect(tools[0]!.artifacts).toBeUndefined()
    expect(tools[0]!.metadata).toBeUndefined()
    expect(tools[1]).toMatchObject({ status: 'error', summary: 'grep failed' })
    expect(tools[2]).toMatchObject({ status: 'error_aborted', summary: 'cancelled' })
    expect(tools[3]).toMatchObject({ status: 'done', summary: 'late call result' })
    expect(tools[3]!.artifacts).toEqual([{ path: 'ok.png', kind: 'image' }])
  })

  it('restores agent_thought events from runtime replay', () => {
    g.window = fakeWindow({
      invokeCore: async () => ({ ok: true }),
      onCoreEvent: () => () => {},
    })
    const boot = ref({
      app: 'Emperor Agent',
      runtime: {
        latestSeq: 3,
        events: [
          {
            event: 'user_message',
            seq: 1,
            turn_id: 'turn-replay',
            content: 'show image',
          },
          {
            event: 'agent_thought',
            seq: 2,
            turn_id: 'turn-replay',
            stage: 'tool_result_summary',
            label: '思考参考',
            summary: 'read_file 失败但识别到 1 个图片 artifact。',
            source: 'audit',
            status: 'done',
            tool_call_ids: ['call_1'],
            tool_names: ['read_file'],
          },
          { event: 'assistant_done', seq: 3, turn_id: 'turn-replay', content: 'done' },
        ],
      },
    } as unknown as BootstrapPayload)
    const runtime = useRuntime({ ...testOptions(), boot })

    runtime.restoreFromHistory([])

    const assistant = runtime.messages.value.find((message) => message.role === 'assistant')
    expect(assistant?.segments).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'thought',
        status: 'done',
        stage: 'tool_result_summary',
        summary: 'read_file 失败但识别到 1 个图片 artifact。',
      }),
    ]))
  })

  it('stops active runtime tasks through Core IPC when the bridge is available', async () => {
    const calls: unknown[][] = []
    g.window = fakeWindow({
      invokeCore: async (...args: unknown[]) => {
        calls.push(args)
        return { cancelled: [{ taskId: 'turn-1' }], active: [] }
      },
      onCoreEvent: () => () => {},
    })
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const runtime = useRuntime(testOptions())

    await expect(runtime.stopActive()).resolves.toBe(true)

    expect(calls).toEqual([['chat.stopRuntime', {}]])
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('ignores the cancelled chat.submit rejection after stopActive has interrupted the UI', async () => {
    let rejectSubmit: ((error: Error) => void) | null = null
    g.window = fakeWindow({
      invokeCore: async (...args: unknown[]) => {
        if (args[0] === 'chat.submit') {
          return new Promise((_resolve, reject) => { rejectSubmit = reject })
        }
        if (args[0] === 'chat.stopRuntime') {
          return { cancelled: [{ id: 'turn:1', kind: 'turn' }], active: [] }
        }
        return { ok: true }
      },
      onCoreEvent: () => () => {},
    })
    const runtime = useRuntime(testOptions())
    runtime.switchSession('s1')

    expect(runtime.sendMessage('hello')).toBe(true)
    await Promise.resolve()
    await expect(runtime.stopActive()).resolves.toBe(true)
    rejectSubmit?.(new Error('active task cancelled: turn:1'))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(runtime.status.value).toBe('ready')
    expect(JSON.stringify(runtime.messages.value)).not.toContain('出错了')
    expect(runtime.busy.value).toBe(false)
  })

  it('answers pending interactions through Core IPC when the bridge is available', async () => {
    const calls: unknown[][] = []
    g.window = fakeWindow({
      invokeCore: async (...args: unknown[]) => {
        calls.push(args)
        return { resume: true }
      },
      onCoreEvent: () => () => {},
    })
    const runtime = useRuntime(testOptions())

    expect(runtime.sendInteractionAnswer('ask_1', { scope: { choice: '完整' } })).toBe(true)
    await Promise.resolve()

    expect(calls).toEqual([
      ['control.answerInteraction', 'ask_1', { scope: { choice: '完整' } }, expect.objectContaining({ clientMessageId: expect.any(String), displayContent: '', uiHidden: true })],
    ])
    expect(runtime.messages.value.some((message) => message.role === 'user' && message.content === '已回答澄清问题')).toBe(false)
    expect(runtime.messages.value[0]).toMatchObject({ role: 'assistant', streaming: true })
  })

  it('rolls back optimistic control resume UI and refreshes state when Core IPC rejects', async () => {
    const calls: unknown[][] = []
    const refreshSessions = vi.fn(async () => {})
    const showToast = vi.fn()
    g.window = fakeWindow({
      invokeCore: async (...args: unknown[]) => {
        calls.push(args)
        if (args[0] === 'control.answerInteraction') {
          return { ok: false, error: { message: 'Internal error', errorId: 'ipc_deadbeef' } }
        }
        if (args[0] === 'control.get') {
          return { mode: 'auto', pending: null }
        }
        return { ok: true }
      },
      onCoreEvent: () => () => {},
    })
    const boot = ref({
      app: 'Emperor Agent',
      runtime: { events: [], latestSeq: 0 },
      control: {
        mode: 'plan',
        pending: { id: 'ask_1', kind: 'ask', status: 'waiting' },
      },
    } as unknown as BootstrapPayload)
    const runtime = useRuntime({ ...testOptions(), boot, showToast, refreshSessions })

    expect(runtime.sendInteractionAnswer('ask_1', { scope: { choice: '完整' } })).toBe(true)
    for (let i = 0; i < 5; i += 1) await Promise.resolve()

    expect(calls.map((call) => call[0])).toEqual(['control.answerInteraction', 'control.get'])
    expect(refreshSessions).toHaveBeenCalledTimes(1)
    expect(boot.value.control?.pending).toBeNull()
    expect(runtime.busy.value).toBe(false)
    expect(runtime.messages.value).toEqual([])
    expect(showToast).toHaveBeenCalledWith('Internal error · ipc_deadbeef')
  })

  it('sanitizes reactive interaction answers before crossing the Core IPC boundary', async () => {
    const calls: unknown[][] = []
    let cloneError: unknown = null
    g.window = fakeWindow({
      invokeCore: async (...args: unknown[]) => {
        try {
          structuredClone(args)
        } catch (err) {
          cloneError = err
          throw err
        }
        calls.push(args)
        return { resume: true }
      },
      onCoreEvent: () => () => {},
    })
    const runtime = useRuntime(testOptions())
    const answers = reactive({ scope: { choice: '完整', freeform: '' } })

    expect(runtime.sendInteractionAnswer('ask_1', answers)).toBe(true)
    await Promise.resolve()

    expect(cloneError).toBeNull()
    expect(calls).toEqual([
      ['control.answerInteraction', 'ask_1', { scope: { choice: '完整', freeform: '' } }, expect.objectContaining({ clientMessageId: expect.any(String), displayContent: '', uiHidden: true })],
    ])
    expect(runtime.messages.value.some((message) => message.role === 'user')).toBe(false)
  })

  it('ignores hidden control resume user_message events so ask and plan stay continuous', async () => {
    let listener: ((event: unknown) => void) | null = null
    g.window = fakeWindow({
      invokeCore: async () => ({ ok: true }),
      onCoreEvent: (cb: (event: unknown) => void) => {
        listener = cb
        return () => { listener = null }
      },
    })
    const runtime = useRuntime(testOptions())

    runtime.connectSocket()
    listener?.({
      event: 'user_message',
      seq: 1,
      turn_id: 'turn-control',
      client_message_id: 'control-msg-1',
      source: 'control',
      ui_hidden: true,
      content: '',
    })

    expect(runtime.messages.value).toEqual([])
  })

  it('continues a live ask resume turn in the paused assistant flow', async () => {
    let listener: ((event: unknown) => void) | null = null
    g.window = fakeWindow({
      invokeCore: async () => ({ ok: true }),
      onCoreEvent: (cb: (event: unknown) => void) => {
        listener = cb
        return () => { listener = null }
      },
    })
    const runtime = useRuntime(testOptions())

    runtime.connectSocket()
    listener?.({ event: 'user_message', seq: 1, turn_id: 'turn-ask', content: 'clarify first' })
    listener?.({ event: 'message_delta', seq: 2, turn_id: 'turn-ask', delta: 'before ' })
    listener?.({
      event: 'ask_request',
      seq: 3,
      turn_id: 'turn-ask',
      interaction: { id: 'ask_1', kind: 'ask', status: 'waiting', context: 'scope?' },
    })
    listener?.({
      event: 'turn_paused',
      seq: 4,
      turn_id: 'turn-ask',
      interaction: { id: 'ask_1', kind: 'ask', status: 'waiting' },
    })
    listener?.({
      event: 'ask_answered',
      seq: 5,
      interaction: { id: 'ask_1', kind: 'ask', status: 'answered' },
    })
    listener?.({
      event: 'user_message',
      seq: 6,
      turn_id: 'turn-ask-resume',
      source: 'control',
      ui_hidden: true,
      content: '',
    })
    listener?.({ event: 'message_delta', seq: 7, turn_id: 'turn-ask-resume', delta: 'after' })
    listener?.({ event: 'assistant_done', seq: 8, turn_id: 'turn-ask-resume', content: 'before after' })

    const assistants = runtime.messages.value.filter((message) => message.role === 'assistant')
    expect(assistants).toHaveLength(1)
    expect(assistants[0]).toMatchObject({ content: 'before after', streaming: false })
    expect(assistants[0]?.segments).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'text', content: 'before ' }),
      expect.objectContaining({ type: 'ask', interaction: expect.objectContaining({ id: 'ask_1', status: 'answered' }) }),
      expect.objectContaining({ type: 'text', content: 'after' }),
    ]))
  })

  it('merges streaming plan_draft_delta events into the final plan card', async () => {
    let listener: ((event: unknown) => void) | null = null
    g.window = fakeWindow({
      invokeCore: async () => ({ ok: true }),
      onCoreEvent: (cb: (event: unknown) => void) => {
        listener = cb
        return () => { listener = null }
      },
    })
    const runtime = useRuntime(testOptions())

    runtime.connectSocket()
    listener?.({ event: 'user_message', seq: 1, turn_id: 'turn-plan', content: '制定计划' })
    listener?.({
      event: 'plan_draft_delta',
      seq: 2,
      turn_id: 'turn-plan',
      tool_call_id: 'call_plan',
      interaction: {
        id: 'provisional-plan-call_plan',
        kind: 'plan',
        status: 'waiting',
        title: '迁移计划',
        plan_markdown: '# 计划',
        meta: { plan_stream_id: 'call_plan', provisional: true },
      },
    })
    listener?.({
      event: 'plan_draft_delta',
      seq: 3,
      turn_id: 'turn-plan',
      tool_call_id: 'call_plan',
      interaction: {
        id: 'provisional-plan-call_plan',
        kind: 'plan',
        status: 'waiting',
        title: '迁移计划',
        plan_markdown: '# 计划\n- 改 UI',
        meta: { plan_stream_id: 'call_plan', provisional: true },
      },
    })
    listener?.({
      event: 'plan_draft',
      seq: 4,
      turn_id: 'turn-plan',
      interaction: {
        id: 'plan-real',
        kind: 'plan',
        status: 'waiting',
        parent_call_id: 'call_plan',
        title: '迁移计划',
        plan_markdown: '# 计划\n- 改 UI',
      },
    })

    const assistant = runtime.messages.value.find((message) => message.role === 'assistant')
    const planSegments = assistant?.segments.filter((segment) => segment.type === 'plan') || []
    expect(planSegments).toHaveLength(1)
    expect(planSegments[0]).toMatchObject({
      type: 'plan',
      interaction: {
        id: 'plan-real',
        parent_call_id: 'call_plan',
        plan_markdown: '# 计划\n- 改 UI',
      },
    })
  })

  it('debounces runtime snapshot persistence instead of writing to localStorage on every mutation (audit P1-3)', async () => {
    vi.useFakeTimers()
    try {
      const setItem = vi.fn()
      let listener: ((event: unknown) => void) | null = null
      g.window = fakeWindow({
        invokeCore: async (...args: unknown[]) => {
          if (args[0] === 'chat.submit') {
            listener?.({ event: 'user_message', seq: 1, turn_id: 'turn-debounce', content: 'hi' })
            return { turnId: 'turn-debounce', content: 'abc' }
          }
          return { ok: true }
        },
        onCoreEvent: (cb: (event: unknown) => void) => {
          listener = cb
          return () => { listener = null }
        },
      }, setItem)
      const runtime = useRuntime(testOptions())

      runtime.connectSocket()
      runtime.switchSession('s1')
      runtime.sendMessage('hi')
      await nextTick()

      // 流式过程中每个 delta 都是独立的一次响应式 flush（对应真实场景里一帧一帧到达的 WS/IPC 事件），
      // 每次都同步写一遍 localStorage 是审计指出的问题——debounce 后中途不应该有任何写入。
      listener?.({ event: 'message_delta', seq: 2, turn_id: 'turn-debounce', delta: 'a' })
      await nextTick()
      listener?.({ event: 'message_delta', seq: 3, turn_id: 'turn-debounce', delta: 'b' })
      await nextTick()
      listener?.({ event: 'message_delta', seq: 4, turn_id: 'turn-debounce', delta: 'c' })
      await nextTick()
      expect(setItem).not.toHaveBeenCalled()

      // turn 结束（busy: true -> false，对应 assistant_done/turn_paused）应该立即 flush 一次，
      // 不必等 debounce 窗口，避免用户在这之后立刻退出丢失最终状态。
      listener?.({ event: 'assistant_done', seq: 5, turn_id: 'turn-debounce', content: 'abc' })
      await nextTick()
      expect(setItem).toHaveBeenCalledTimes(1)

      // debounce 定时器不应该在 flush 之后再补一次多余的写入。
      await vi.advanceTimersByTimeAsync(1000)
      expect(setItem).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('blocks chat submit before local enqueue when the active session id is missing or draft', async () => {
    const calls: unknown[][] = []
    const showToast = vi.fn()
    g.window = fakeWindow({
      invokeCore: async (...args: unknown[]) => {
        calls.push(args)
        return { ok: true }
      },
      onCoreEvent: () => () => {},
    })
    const runtime = useRuntime({ ...testOptions(), showToast })

    runtime.connectSocket()
    expect(runtime.sendMessage('hello without session')).toBe(false)
    runtime.switchSession('draft:local')
    expect(runtime.sendMessage('hello draft')).toBe(false)

    expect(calls).toEqual([])
    expect(runtime.messages.value).toEqual([])
    expect(runtime.busy.value).toBe(false)
    expect(showToast).toHaveBeenCalledWith('正在创建会话，请稍后再试')
  })
})

async function flushPromises(count = 5): Promise<void> {
  for (let i = 0; i < count; i += 1) await Promise.resolve()
}

function testOptions() {
  return {
    boot: ref({ app: 'Emperor Agent', runtime: { events: [], latestSeq: 0 } } as unknown as BootstrapPayload),
    refreshMemory: vi.fn(async () => {}),
    showToast: vi.fn(),
  }
}

function fakeWindow(bridge: Record<string, unknown>, setItem: (...args: unknown[]) => void = () => undefined) {
  return {
    emperor: bridge,
    localStorage: {
      getItem: () => null,
      setItem,
      removeItem: () => undefined,
    },
    location: { protocol: 'http:', host: 'localhost:5173' },
    setTimeout: setTimeout.bind(globalThis),
    clearTimeout: clearTimeout.bind(globalThis),
  }
}
