import { afterEach, describe, expect, it, vi } from 'vitest'
import { reactive, ref } from 'vue'
import type { BootstrapPayload } from '../types'
import { useRuntime } from './useRuntime'

const g = globalThis as unknown as { window?: any; fetch?: unknown }

afterEach(() => {
  delete g.window
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('useRuntime IPC runtime path (MIG-IPC-010)', () => {
  it('applies live profile onboarding state changes to bootstrap', () => {
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
    const options = testOptions()
    const runtime = useRuntime(options)
    runtime.connectSocket()

    emitCoreEvent(listener, {
      event: 'profile_onboarding_status_changed',
      profile_onboarding: {
        status: 'skipped',
        sessionId: null,
        interactionId: null,
        attemptCount: 1,
        lastError: null,
        canStart: true,
        canSkip: false,
      },
    })

    expect(options.boot.value?.profileOnboarding).toMatchObject({
      status: 'skipped',
      canStart: true,
      canSkip: false,
    })
  })

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
    expect(showToast).toHaveBeenCalledWith(
      '桌面 IPC 不可用，请在 Electron 桌面窗口中使用',
    )
  })

  it('subscribes to core events and submits chat through Core IPC when the bridge is available', async () => {
    const calls: unknown[][] = []
    let listener: ((event: unknown) => void) | null = null
    g.window = fakeWindow({
      invokeCore: async (...args: unknown[]) => {
        calls.push(args)
        if (args[0] === 'chat.submit') {
          const payload = args[1] as Record<string, unknown>
          emitCoreEvent(listener, {
            event: 'user_message',
            seq: 1,
            turn_id: 'turn-ipc-1',
            client_message_id: payload.clientMessageId,
            content: payload.displayContent || payload.content,
          })
          emitCoreEvent(listener, {
            event: 'assistant_done',
            seq: 2,
            turn_id: 'turn-ipc-1',
            content: 'pong',
          })
          return { turnId: 'turn-ipc-1', content: 'pong' }
        }
        return { ok: true }
      },
      onCoreEvent: (cb: (event: unknown) => void) => {
        listener = cb
        return () => {
          listener = null
        }
      },
    })
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const runtime = useRuntime(testOptions())

    runtime.connectSocket()
    expect(runtime.status.value).toBe('ready')
    runtime.switchSession('s1')
    expect(runtime.sendMessage('hello')).toBe(true)
    await Promise.resolve()

    expect(calls[0]).toEqual([
      'chat.submit',
      expect.objectContaining({
        content: 'hello',
        displayContent: 'hello',
        sessionId: 's1',
      }),
    ])
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(runtime.messages.value.at(-1)).toMatchObject({
      role: 'assistant',
      content: 'pong',
      streaming: false,
    })
    expect(runtime.busy.value).toBe(false)
  })

  it('disposes the session subscription and all domain effect runners', () => {
    const unsubscribe = vi.fn()
    let listener: ((event: unknown) => void) | null = null
    g.window = fakeWindow({
      invokeCore: async () => ({ ok: true }),
      onCoreEvent: (callback: (event: unknown) => void) => {
        listener = callback
        return () => {
          unsubscribe()
          listener = null
        }
      },
    })
    const runtime = useRuntime(testOptions())
    runtime.connectSocket()
    expect(listener).not.toBeNull()

    runtime.dispose()

    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(listener).toBeNull()
  })

  it('submits a busy prompt as an interjection without creating a second optimistic assistant', async () => {
    const calls: unknown[][] = []
    let listener: ((event: unknown) => void) | null = null
    g.window = fakeWindow({
      invokeCore: (...args: unknown[]) => {
        calls.push(args)
        if (args[0] === 'chat.submit') {
          const payload = args[1] as Record<string, unknown>
          if (payload.delivery === 'interject')
            return Promise.resolve({
              turnId: 'prompt-turn',
              delivery: 'interjected',
              targetTurnId: 'owner-turn',
            })
          return new Promise(() => undefined)
        }
        return Promise.resolve({ ok: true })
      },
      onCoreEvent: (cb: (event: unknown) => void) => {
        listener = cb
        return () => {
          listener = null
        }
      },
    })
    const runtime = useRuntime(testOptions())

    runtime.switchSession('s1')
    expect(runtime.sendMessage('original')).toBe(true)
    expect(
      runtime.sendMessage({ content: 'interrupt now', delivery: 'interject' }),
    ).toBe(true)
    await flushPromises()

    const submits = calls.filter((call) => call[0] === 'chat.submit')
    expect(submits).toHaveLength(2)
    expect(submits[1]?.[1]).toMatchObject({
      content: 'interrupt now',
      delivery: 'interject',
      sessionId: 's1',
    })
    const users = runtime.messages.value.filter(
      (message) => message.role === 'user',
    )
    expect(users.at(-1)).toMatchObject({
      content: 'interrupt now',
      deliveryState: 'queued',
    })
    expect(
      runtime.messages.value.filter((message) => message.role === 'assistant'),
    ).toHaveLength(1)
    expect(runtime.busy.value).toBe(true)

    emitCoreEvent(listener, {
      event: 'prompt_interjected',
      seq: 1,
      session_id: 's1',
      turn_id: 'prompt-turn',
      prompt_id: users.at(-1)?.id,
      client_message_id: users.at(-1)?.id,
      target_turn_id: 'owner-turn',
    })
    expect(users.at(-1)).toMatchObject({ deliveryState: 'interjected' })
  })

  it('does not append an error message when a chat turn pauses for user input', async () => {
    let listener: ((event: unknown) => void) | null = null
    g.window = fakeWindow({
      invokeCore: async (...args: unknown[]) => {
        if (args[0] === 'chat.submit') {
          emitCoreEvent(listener, {
            event: 'turn_paused',
            seq: 1,
            turn_id: 'turn-paused',
            interaction: { id: 'ask_1', kind: 'ask', status: 'waiting' },
          })
          return {
            ok: false,
            error: { message: 'Turn paused', code: 'turn_paused' },
          }
        }
        return { ok: true }
      },
      onCoreEvent: (cb: (event: unknown) => void) => {
        listener = cb
        return () => {
          listener = null
        }
      },
    })
    const runtime = useRuntime(testOptions())

    runtime.switchSession('s1')
    expect(runtime.sendMessage('需要澄清')).toBe(true)
    await flushPromises()

    expect(
      runtime.messages.value.map((message) => message.content).join('\n'),
    ).not.toContain('出错了')
    expect(runtime.busy.value).toBe(false)
    expect(runtime.pending.label).toBe('等待你定夺')
  })

  it('does not append an error message when a stopped chat turn rejects as cancelled', async () => {
    g.window = fakeWindow({
      invokeCore: async (...args: unknown[]) => {
        if (args[0] === 'chat.submit')
          return {
            ok: false,
            error: { message: 'Task cancelled', code: 'cancelled' },
          }
        return { ok: true }
      },
      onCoreEvent: () => () => {},
    })
    const runtime = useRuntime(testOptions())

    runtime.switchSession('s1')
    expect(runtime.sendMessage('停止我')).toBe(true)
    await flushPromises()

    expect(
      runtime.messages.value.map((message) => message.content).join('\n'),
    ).not.toContain('出错了')
    expect(runtime.busy.value).toBe(false)
  })

  it('does not append an error message when Core rejects a concurrent chat turn as busy', async () => {
    g.window = fakeWindow({
      invokeCore: async (...args: unknown[]) => {
        if (args[0] === 'chat.submit')
          return {
            ok: false,
            error: {
              message: 'Another agent turn is already running',
              code: 'turn_busy',
            },
          }
        return { ok: true }
      },
      onCoreEvent: () => () => {},
    })
    const runtime = useRuntime(testOptions())

    runtime.switchSession('s1')
    expect(runtime.sendMessage('第二条')).toBe(true)
    await flushPromises()

    expect(
      runtime.messages.value.map((message) => message.content).join('\n'),
    ).not.toContain('出错了')
    expect(
      runtime.messages.value.map((message) => message.content).join('\n'),
    ).toContain('已有任务正在运行')
    expect(runtime.busy.value).toBe(false)
  })

  it('settles the active session spinner and keeps transport ready when model configuration submit fails', async () => {
    let listener: ((event: unknown) => void) | null = null
    g.window = fakeWindow({
      invokeCore: async (...args: unknown[]) => {
        if (args[0] === 'chat.submit') {
          const payload = args[1] as Record<string, unknown>
          emitCoreEvent(listener, {
            event: 'user_message',
            seq: 1,
            session_id: 's1',
            turn_id: 'turn-no-model',
            client_message_id: payload.clientMessageId,
            content: payload.displayContent || payload.content,
          })
          return {
            ok: false,
            error: {
              message: '还没有可用模型，请先配置模型。',
              code: 'model_configuration_required',
              action: 'open_model_settings',
            },
          }
        }
        return { ok: true }
      },
      onCoreEvent: (cb: (event: unknown) => void) => {
        listener = cb
        return () => {
          listener = null
        }
      },
    })
    const runtime = useRuntime(testOptions())

    runtime.switchSession('s1')
    expect(runtime.sendMessage('hi')).toBe(true)
    await flushPromises()

    expect(runtime.busy.value).toBe(false)
    expect(runtime.status.value).toBe('ready')
    expect(runtime.sessionRuntimeStates['s1']).toMatchObject({
      running: false,
      attention: false,
    })
    expect(
      runtime.messages.value.map((message) => message.content).join('\n'),
    ).toContain('还没有可用模型，请先配置模型。')
  })

  it('deduplicates a runtime error event followed by the matching submit rejection', async () => {
    let listener: ((event: unknown) => void) | null = null
    g.window = fakeWindow({
      invokeCore: async (...args: unknown[]) => {
        if (args[0] === 'chat.submit') {
          const payload = args[1] as Record<string, unknown>
          emitCoreEvent(listener, {
            event: 'user_message',
            seq: 1,
            session_id: 's1',
            turn_id: 'turn-error',
            client_message_id: payload.clientMessageId,
            content: payload.displayContent || payload.content,
          })
          emitCoreEvent(listener, {
            event: 'error',
            seq: 2,
            session_id: 's1',
            turn_id: 'turn-error',
            message: '还没有可用模型，请先配置模型。',
            code: 'model_configuration_required',
            action: 'open_model_settings',
          })
          return {
            ok: false,
            error: {
              message: '还没有可用模型，请先配置模型。',
              code: 'model_configuration_required',
              action: 'open_model_settings',
            },
          }
        }
        return { ok: true }
      },
      onCoreEvent: (cb: (event: unknown) => void) => {
        listener = cb
        return () => {
          listener = null
        }
      },
    })
    const runtime = useRuntime(testOptions())

    runtime.switchSession('s1')
    expect(runtime.sendMessage('hi')).toBe(true)
    await flushPromises()

    const rendered = runtime.messages.value
      .map((message) => message.content)
      .join('\n')
    expect(
      rendered.match(/出错了：还没有可用模型，请先配置模型。/g),
    ).toHaveLength(1)
    expect(runtime.sessionRuntimeStates['s1']).toMatchObject({
      running: false,
      attention: false,
    })
  })

  it('ignores live runtime events from another session without advancing the active replay cursor', async () => {
    let listener: ((event: unknown) => void) | null = null
    g.window = fakeWindow({
      invokeCore: async () => ({ ok: true }),
      onCoreEvent: (cb: (event: unknown) => void) => {
        listener = cb
        return () => {
          listener = null
        }
      },
    })
    const runtime = useRuntime(testOptions())

    runtime.switchSession('session-current')
    emitCoreEvent(listener, {
      event: 'message_delta',
      seq: 99,
      session_id: 'session-other',
      turn_id: 'turn-other',
      delta: 'foreign text',
    })
    emitCoreEvent(listener, {
      event: 'user_message',
      seq: 1,
      session_id: 'session-current',
      turn_id: 'turn-current',
      content: 'local user',
    })
    emitCoreEvent(listener, {
      event: 'message_delta',
      seq: 2,
      session_id: 'session-current',
      turn_id: 'turn-current',
      delta: 'local answer',
    })
    emitCoreEvent(listener, {
      event: 'assistant_done',
      seq: 3,
      session_id: 'session-current',
      turn_id: 'turn-current',
      content: 'local answer',
    })

    const text = runtime.messages.value
      .map((message) => message.content)
      .join('\n')
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
        return () => {
          listener = null
        }
      },
    })
    const runtime = useRuntime(testOptions())

    runtime.switchSession('draft:pending-1')
    emitCoreEvent(listener, {
      event: 'user_message',
      seq: 11,
      session_id: 'session-other',
      turn_id: 'turn-other',
      content: 'foreign user',
    })
    emitCoreEvent(listener, {
      event: 'message_delta',
      seq: 12,
      session_id: 'session-other',
      turn_id: 'turn-other',
      delta: 'foreign text',
    })
    emitCoreEvent(listener, {
      event: 'session_created',
      seq: 1,
      session_id: 'session-real',
      session: { id: 'session-real' },
      client_draft_id: 'draft:pending-1',
    })
    emitCoreEvent(listener, {
      event: 'user_message',
      seq: 2,
      session_id: 'session-real',
      turn_id: 'turn-real',
      content: 'real user',
    })
    emitCoreEvent(listener, {
      event: 'message_delta',
      seq: 3,
      session_id: 'session-real',
      turn_id: 'turn-real',
      delta: 'real answer',
    })
    emitCoreEvent(listener, {
      event: 'assistant_done',
      seq: 4,
      session_id: 'session-real',
      turn_id: 'turn-real',
      content: 'real answer',
    })

    expect(runtime.sessionId.value).toBe('session-real')
    const text = runtime.messages.value
      .map((message) => message.content)
      .join('\n')
    expect(text).not.toContain('foreign user')
    expect(text).not.toContain('foreign text')
    expect(text).toContain('real user')
    expect(text).toContain('real answer')
  })

  it('applies control pending changes to the event owner session instead of the currently open session', async () => {
    let listener: ((event: unknown) => void) | null = null
    const pendingChanges: Array<{ sessionId: string; interaction: unknown }> =
      []
    g.window = fakeWindow({
      invokeCore: async () => ({ ok: true }),
      onCoreEvent: (cb: (event: unknown) => void) => {
        listener = cb
        return () => {
          listener = null
        }
      },
    })
    const boot = ref({
      app: 'Emperor Agent',
      runtime: { events: [], latestSeq: 0 },
      control: { mode: 'auto', pending: null },
    } as unknown as BootstrapPayload)
    const runtime = useRuntime({
      ...testOptions(),
      boot,
      onSessionControlPendingChanged: (sessionId, interaction) => {
        pendingChanges.push({ sessionId, interaction: interaction ?? null })
      },
    })

    runtime.switchSession('session-other')
    emitCoreEvent(listener, {
      event: 'ask_request',
      seq: 1,
      session_id: 'session-owner',
      turn_id: 'turn-owner',
      interaction: { id: 'ask_owner', kind: 'ask', status: 'waiting' },
    })
    expect(boot.value.control?.pending).toEqual(
      expect.objectContaining({ id: 'ask_owner' }),
    )

    emitCoreEvent(listener, {
      event: 'ask_answered',
      seq: 2,
      session_id: 'session-owner',
      interaction: { id: 'ask_owner', kind: 'ask', status: 'answered' },
    })

    expect(pendingChanges).toEqual([
      {
        sessionId: 'session-owner',
        interaction: expect.objectContaining({ id: 'ask_owner' }),
      },
      { sessionId: 'session-owner', interaction: null },
    ])
    expect(boot.value.control?.pending).toBeNull()
  })

  it('projects agent_thought events into completed thought segments', async () => {
    let listener: ((event: unknown) => void) | null = null
    g.window = fakeWindow({
      invokeCore: async (...args: unknown[]) => {
        if (args[0] === 'chat.submit') {
          emitCoreEvent(listener, {
            event: 'user_message',
            seq: 1,
            turn_id: 'turn-thought',
            content: 'show image',
          })
          emitCoreEvent(listener, {
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
          emitCoreEvent(listener, {
            event: 'tool_call',
            seq: 3,
            turn_id: 'turn-thought',
            id: 'call_1',
            name: 'read_file',
            arguments: { path: 'screen.png' },
          })
          emitCoreEvent(listener, {
            event: 'assistant_done',
            seq: 4,
            turn_id: 'turn-thought',
            content: 'done',
          })
          return { turnId: 'turn-thought', content: 'done' }
        }
        return { ok: true }
      },
      onCoreEvent: (cb: (event: unknown) => void) => {
        listener = cb
        return () => {
          listener = null
        }
      },
    })
    const runtime = useRuntime(testOptions())

    runtime.connectSocket()
    runtime.switchSession('s1')
    expect(runtime.sendMessage('show image')).toBe(true)
    await Promise.resolve()

    const assistant = runtime.messages.value.find(
      (message) => message.role === 'assistant',
    )
    const thought = assistant?.segments.find(
      (segment) =>
        segment.type === 'thought' && segment.stage === 'tool_intent',
    )
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
          emitCoreEvent(listener, {
            event: 'user_message',
            seq: 1,
            turn_id: 'turn-tools',
            content: 'run tools',
          })
          emitCoreEvent(listener, {
            event: 'tool_run_queued',
            seq: 2,
            turn_id: 'turn-tools',
            id: 'run_1',
            name: 'unknown_new_tool',
            arguments: { value: 1 },
          })
          emitCoreEvent(listener, {
            event: 'tool_run_completed',
            seq: 3,
            turn_id: 'turn-tools',
            id: 'run_1',
            name: 'unknown_new_tool',
            summary: 'ok',
            artifacts: { bad: true },
            metadata: 'bad',
          })
          emitCoreEvent(listener, {
            event: 'tool_run_failed',
            seq: 4,
            turn_id: 'turn-tools',
            id: 'run_2',
            name: 'grep',
            message: 'grep failed',
          })
          emitCoreEvent(listener, {
            event: 'tool_run_cancelled',
            seq: 5,
            turn_id: 'turn-tools',
            id: 'run_3',
            name: 'run_command',
            reason: 'cancelled',
          })
          emitCoreEvent(listener, {
            event: 'tool_result',
            seq: 6,
            turn_id: 'turn-tools',
            id: 'result_first',
            name: 'read_file',
            summary: 'late call result',
            artifacts: [null, { path: 'ok.png', kind: 'image' }],
          })
          emitCoreEvent(listener, {
            event: 'assistant_done',
            seq: 7,
            turn_id: 'turn-tools',
            content: 'done',
          })
          return { turnId: 'turn-tools', content: 'done' }
        }
        return { ok: true }
      },
      onCoreEvent: (cb: (event: unknown) => void) => {
        listener = cb
        return () => {
          listener = null
        }
      },
    })
    const runtime = useRuntime(testOptions())

    runtime.switchSession('s1')
    expect(runtime.sendMessage('run tools')).toBe(true)
    await flushPromises()

    const assistant = runtime.messages.value.find(
      (message) => message.role === 'assistant',
    )
    const tools =
      assistant?.segments.filter((segment) => segment.type === 'tool') || []
    expect(tools.map((tool) => tool.name)).toEqual([
      'unknown_new_tool',
      'grep',
      'run_command',
      'read_file',
    ])
    expect(tools[0]).toMatchObject({ status: 'done', summary: 'ok' })
    expect(tools[0]!.artifacts).toBeUndefined()
    expect(tools[0]!.metadata).toBeUndefined()
    expect(tools[1]).toMatchObject({ status: 'error', summary: 'grep failed' })
    expect(tools[2]).toMatchObject({
      status: 'error_aborted',
      summary: 'cancelled',
    })
    expect(tools[3]).toMatchObject({
      status: 'done',
      summary: 'late call result',
    })
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
          {
            event: 'assistant_done',
            seq: 3,
            turn_id: 'turn-replay',
            content: 'done',
          },
        ],
      },
    } as unknown as BootstrapPayload)
    const runtime = useRuntime({ ...testOptions(), boot })

    runtime.restoreFromHistory([])

    const assistant = runtime.messages.value.find(
      (message) => message.role === 'assistant',
    )
    expect(assistant?.segments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'thought',
          status: 'done',
          stage: 'tool_result_summary',
          summary: 'read_file 失败但识别到 1 个图片 artifact。',
        }),
      ]),
    )
  })

  it('settles stale runtime replay when bootstrap says no task is busy', () => {
    g.window = fakeWindow({
      invokeCore: async () => ({ ok: true }),
      onCoreEvent: () => () => {},
    })
    const boot = ref({
      app: 'Emperor Agent',
      runtime: {
        latestSeq: 3,
        busy: false,
        events: [
          {
            event: 'user_message',
            seq: 1,
            turn_id: 'turn-stale',
            content: 'build it',
          },
          {
            event: 'message_delta',
            seq: 2,
            turn_id: 'turn-stale',
            delta: 'working',
          },
          {
            event: 'tool_run_completed',
            seq: 3,
            turn_id: 'turn-stale',
            id: 'call_1',
            name: 'run_command',
            summary: 'done',
          },
        ],
      },
    } as unknown as BootstrapPayload)
    const runtime = useRuntime({ ...testOptions(), boot })

    runtime.restoreFromHistory([])

    const assistant = runtime.messages.value.find(
      (message) => message.role === 'assistant',
    )
    expect(runtime.busy.value).toBe(false)
    expect(assistant).toMatchObject({ streaming: false })
    expect(JSON.stringify(assistant)).toContain('后端没有正在运行的任务')
  })

  it('clears stale local streaming state when stop finds no backend task', async () => {
    g.window = fakeWindow({
      invokeCore: async (...args: unknown[]) => {
        if (args[0] === 'chat.stopRuntime') return { cancelled: [], active: [] }
        return { ok: true }
      },
      onCoreEvent: () => () => {},
    })
    const boot = ref({
      app: 'Emperor Agent',
      runtime: {
        latestSeq: 2,
        busy: false,
        events: [
          {
            event: 'user_message',
            seq: 1,
            turn_id: 'turn-stale-stop',
            content: 'build it',
          },
          {
            event: 'message_delta',
            seq: 2,
            turn_id: 'turn-stale-stop',
            delta: 'working',
          },
        ],
      },
    } as unknown as BootstrapPayload)
    const runtime = useRuntime({ ...testOptions(), boot })
    runtime.restoreFromHistory([])
    expect(runtime.busy.value).toBe(false)

    await expect(runtime.stopActive()).resolves.toBe(false)

    expect(runtime.busy.value).toBe(false)
    expect(
      runtime.messages.value.find((message) => message.role === 'assistant'),
    ).toMatchObject({ streaming: false })
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
          return new Promise((_resolve, reject) => {
            rejectSubmit = reject
          })
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
    invokeCallback(rejectSubmit, new Error('active task cancelled: turn:1'))
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

    expect(
      runtime.sendInteractionAnswer('ask_1', { scope: { choice: '完整' } }),
    ).toBe(true)
    await Promise.resolve()

    expect(calls).toEqual([
      [
        'control.answerInteraction',
        'ask_1',
        { scope: { choice: '完整' } },
        expect.objectContaining({
          clientMessageId: expect.any(String),
          displayContent: '',
          uiHidden: true,
        }),
      ],
    ])
    expect(
      runtime.messages.value.some(
        (message) =>
          message.role === 'user' && message.content === '已回答澄清问题',
      ),
    ).toBe(false)
    expect(runtime.messages.value[0]).toMatchObject({
      role: 'assistant',
      streaming: true,
    })
  })

  it('rolls back optimistic control resume UI and refreshes state when Core IPC rejects', async () => {
    const calls: unknown[][] = []
    const refreshSessions = vi.fn(async () => {})
    const showToast = vi.fn()
    g.window = fakeWindow({
      invokeCore: async (...args: unknown[]) => {
        calls.push(args)
        if (args[0] === 'control.answerInteraction') {
          return {
            ok: false,
            error: { message: 'Internal error', errorId: 'ipc_deadbeef' },
          }
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
    const runtime = useRuntime({
      ...testOptions(),
      boot,
      showToast,
      refreshSessions,
    })

    expect(
      runtime.sendInteractionAnswer('ask_1', { scope: { choice: '完整' } }),
    ).toBe(true)
    for (let i = 0; i < 5; i += 1) await Promise.resolve()

    expect(calls.map((call) => call[0])).toEqual([
      'control.answerInteraction',
      'control.get',
    ])
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
      [
        'control.answerInteraction',
        'ask_1',
        { scope: { choice: '完整', freeform: '' } },
        expect.objectContaining({
          clientMessageId: expect.any(String),
          displayContent: '',
          uiHidden: true,
        }),
      ],
    ])
    expect(
      runtime.messages.value.some((message) => message.role === 'user'),
    ).toBe(false)
  })

  it('ignores hidden control resume user_message events so ask and plan stay continuous', async () => {
    let listener: ((event: unknown) => void) | null = null
    g.window = fakeWindow({
      invokeCore: async () => ({ ok: true }),
      onCoreEvent: (cb: (event: unknown) => void) => {
        listener = cb
        return () => {
          listener = null
        }
      },
    })
    const runtime = useRuntime(testOptions())

    runtime.connectSocket()
    emitCoreEvent(listener, {
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
        return () => {
          listener = null
        }
      },
    })
    const runtime = useRuntime(testOptions())

    runtime.connectSocket()
    emitCoreEvent(listener, {
      event: 'user_message',
      seq: 1,
      turn_id: 'turn-ask',
      content: 'clarify first',
    })
    emitCoreEvent(listener, {
      event: 'message_delta',
      seq: 2,
      turn_id: 'turn-ask',
      delta: 'before ',
    })
    emitCoreEvent(listener, {
      event: 'ask_request',
      seq: 3,
      turn_id: 'turn-ask',
      interaction: {
        id: 'ask_1',
        kind: 'ask',
        status: 'waiting',
        context: 'scope?',
      },
    })
    emitCoreEvent(listener, {
      event: 'turn_paused',
      seq: 4,
      turn_id: 'turn-ask',
      interaction: { id: 'ask_1', kind: 'ask', status: 'waiting' },
    })
    emitCoreEvent(listener, {
      event: 'ask_answered',
      seq: 5,
      interaction: { id: 'ask_1', kind: 'ask', status: 'answered' },
    })
    emitCoreEvent(listener, {
      event: 'user_message',
      seq: 6,
      turn_id: 'turn-ask-resume',
      source: 'control',
      ui_hidden: true,
      content: '',
    })
    emitCoreEvent(listener, {
      event: 'message_delta',
      seq: 7,
      turn_id: 'turn-ask-resume',
      delta: 'after',
    })
    emitCoreEvent(listener, {
      event: 'assistant_done',
      seq: 8,
      turn_id: 'turn-ask-resume',
      content: 'before after',
    })

    const assistants = runtime.messages.value.filter(
      (message) => message.role === 'assistant',
    )
    expect(assistants).toHaveLength(1)
    expect(assistants[0]).toMatchObject({
      content: 'before after',
      streaming: false,
    })
    expect(assistants[0]?.segments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'text', content: 'before ' }),
        expect.objectContaining({
          type: 'ask',
          interaction: expect.objectContaining({
            id: 'ask_1',
            status: 'answered',
          }),
        }),
        expect.objectContaining({ type: 'text', content: 'after' }),
      ]),
    )
  })

  it('keeps the live plan approve/resume sequence in one continuous assistant flow (P1-3 fixture)', async () => {
    let listener: ((event: unknown) => void) | null = null
    g.window = fakeWindow({
      invokeCore: async () => ({ ok: true }),
      onCoreEvent: (cb: (event: unknown) => void) => {
        listener = cb
        return () => {
          listener = null
        }
      },
    })
    const runtime = useRuntime(testOptions())

    runtime.connectSocket()
    emitCoreEvent(listener, {
      event: 'user_message',
      seq: 1,
      turn_id: 'turn-plan',
      content: '随便做点东西',
    })
    emitCoreEvent(listener, {
      event: 'message_delta',
      seq: 2,
      turn_id: 'turn-plan',
      delta: '先出个计划。',
    })
    emitCoreEvent(listener, {
      event: 'tool_run_started',
      seq: 3,
      turn_id: 'turn-plan',
      id: 'call_pp',
      name: 'propose_plan',
    })
    emitCoreEvent(listener, {
      event: 'tool_call',
      seq: 4,
      turn_id: 'turn-plan',
      id: 'call_pp',
      name: 'propose_plan',
      arguments: {},
    })
    emitCoreEvent(listener, {
      event: 'plan_draft_delta',
      seq: 5,
      turn_id: 'turn-plan',
      tool_call_id: 'call_pp',
      interaction: {
        id: 'provisional-plan-call_pp',
        kind: 'plan',
        status: 'waiting',
        title: 'Term',
        meta: { plan_stream_id: 'call_pp', provisional: true },
      },
    })
    emitCoreEvent(listener, {
      event: 'tool_run_cancelled',
      seq: 6,
      turn_id: 'turn-plan',
      id: 'call_pp',
      name: 'propose_plan',
      reason: 'turn_paused',
    })
    emitCoreEvent(listener, {
      event: 'tool_result',
      seq: 7,
      turn_id: 'turn-plan',
      id: 'call_pp',
      name: 'propose_plan',
      summary: 'waiting for user (plan:plan_live)',
    })
    emitCoreEvent(listener, {
      event: 'plan_draft',
      seq: 8,
      turn_id: 'turn-plan',
      interaction: {
        id: 'plan_live',
        kind: 'plan',
        status: 'waiting',
        parent_call_id: 'call_pp',
        title: 'Terminal Dreamscape',
        plan_markdown: '# Plan',
      },
    })
    emitCoreEvent(listener, {
      event: 'turn_paused',
      seq: 9,
      turn_id: 'turn-plan',
      interaction: { id: 'plan_live', kind: 'plan', status: 'waiting' },
    })
    emitCoreEvent(listener, {
      event: 'plan_approved',
      seq: 10,
      interaction: { id: 'plan_live', kind: 'plan', status: 'approved' },
    })
    emitCoreEvent(listener, {
      event: 'user_message',
      seq: 11,
      turn_id: 'turn-plan-resume',
      source: 'control',
      ui_hidden: true,
      content: '',
    })
    emitCoreEvent(listener, {
      event: 'message_delta',
      seq: 12,
      turn_id: 'turn-plan-resume',
      delta: '计划批准，开始执行。',
    })
    emitCoreEvent(listener, {
      event: 'tool_call',
      seq: 13,
      turn_id: 'turn-plan-resume',
      id: 'call_wf',
      name: 'write_file',
      arguments: { path: 'main.py' },
    })
    emitCoreEvent(listener, {
      event: 'tool_result',
      seq: 14,
      turn_id: 'turn-plan-resume',
      id: 'call_wf',
      name: 'write_file',
      summary: 'written',
    })
    emitCoreEvent(listener, {
      event: 'assistant_done',
      seq: 15,
      turn_id: 'turn-plan-resume',
      content: '先出个计划。计划批准，开始执行。',
    })

    const assistants = runtime.messages.value.filter(
      (message) => message.role === 'assistant',
    )
    expect(assistants).toHaveLength(1)
    expect(
      runtime.messages.value.filter((message) => message.role === 'user'),
    ).toHaveLength(1)
    expect(assistants[0]).toMatchObject({
      content: '先出个计划。计划批准，开始执行。',
      streaming: false,
    })
    const planSegments = assistants[0]!.segments.filter(
      (segment) => segment.type === 'plan',
    )
    expect(planSegments).toHaveLength(1)
    expect(planSegments[0]!.interaction).toMatchObject({
      id: 'plan_live',
      status: 'approved',
    })
    const proposeTool = assistants[0]!.segments.find(
      (segment) => segment.type === 'tool' && segment.toolId === 'call_pp',
    )
    expect(proposeTool).toMatchObject({
      status: 'done',
      summary: 'waiting for user (plan:plan_live)',
    })
    const resumeTool = assistants[0]!.segments.find(
      (segment) => segment.type === 'tool' && segment.toolId === 'call_wf',
    )
    expect(resumeTool).toMatchObject({ status: 'done' })
  })

  it('tracks per-session running state and flags background completion for attention (P1-7)', async () => {
    let listener: ((event: unknown) => void) | null = null
    g.window = fakeWindow({
      invokeCore: async () => ({ ok: true }),
      onCoreEvent: (cb: (event: unknown) => void) => {
        listener = cb
        return () => {
          listener = null
        }
      },
    })
    const runtime = useRuntime(testOptions())
    runtime.connectSocket()
    runtime.switchSession('s1')

    emitCoreEvent(listener, {
      event: 'message_delta',
      seq: 1,
      session_id: 's1',
      turn_id: 't1',
      delta: 'hi',
    })
    expect(runtime.sessionRuntimeStates['s1']).toMatchObject({ running: true })

    const before = runtime.messages.value.length
    emitCoreEvent(listener, {
      event: 'message_delta',
      seq: 2,
      session_id: 's2',
      turn_id: 't2',
      delta: 'bg',
    })
    expect(runtime.sessionRuntimeStates['s2']).toMatchObject({ running: true })
    expect(runtime.messages.value).toHaveLength(before)

    emitCoreEvent(listener, {
      event: 'assistant_done',
      seq: 3,
      session_id: 's2',
      turn_id: 't2',
      content: 'done',
    })
    expect(runtime.sessionRuntimeStates['s2']).toMatchObject({
      running: false,
      attention: true,
    })

    emitCoreEvent(listener, {
      event: 'assistant_done',
      seq: 4,
      session_id: 's1',
      turn_id: 't1',
      content: 'done',
    })
    expect(runtime.sessionRuntimeStates['s1']).toMatchObject({
      running: false,
      attention: false,
    })

    runtime.switchSession('s2')
    expect(runtime.sessionRuntimeStates['s2']).toMatchObject({
      attention: false,
    })
  })

  it('does not resurrect a terminal session spinner from duplicate or out-of-order events', () => {
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
    const runtime = useRuntime(testOptions())
    runtime.connectSocket()
    runtime.switchSession('s1')

    emitCoreEvent(listener, {
      event: 'assistant_done',
      seq: 2,
      session_id: 's1',
      turn_id: 't1',
      content: 'done',
    })
    emitCoreEvent(listener, {
      event: 'message_delta',
      seq: 1,
      session_id: 's1',
      turn_id: 't1',
      delta: 'stale',
    })

    expect(runtime.sessionRuntimeStates.s1).toMatchObject({
      running: false,
      attention: false,
    })
    expect(runtime.messages.value).toEqual([])
  })

  it('rehydrates runtime state without scheduling live timers or refresh effects', () => {
    const setTimeoutSpy = vi.fn(setTimeout.bind(globalThis))
    const options = testOptions()
    ;(options.boot.value as any).runtime = {
      latestSeq: 4,
      busy: false,
      events: [
        {
          event: 'user_message',
          seq: 1,
          session_id: 's1',
          turn_id: 't1',
          content: 'hello',
        },
        {
          event: 'message_delta',
          seq: 2,
          session_id: 's1',
          turn_id: 't1',
          delta: 'done',
        },
        {
          event: 'assistant_done',
          seq: 3,
          session_id: 's1',
          turn_id: 't1',
          content: 'done',
        },
        {
          event: 'scheduler_run_done',
          seq: 4,
          session_id: 's1',
          job: { id: 'job-1', name: 'nightly' },
        },
      ],
    }
    g.window = fakeWindow(
      {
        invokeCore: async () => ({ ok: true }),
        onCoreEvent: () => () => {},
      },
      () => undefined,
      setTimeoutSpy,
    )
    const runtime = useRuntime(options)
    runtime.switchSession('s1')

    runtime.restoreFromHistory([])

    expect(setTimeoutSpy).not.toHaveBeenCalled()
    expect(options.refreshMemory).not.toHaveBeenCalled()
    expect(runtime.messages.value.at(-1)).toMatchObject({
      role: 'assistant',
      content: 'done',
      streaming: false,
    })
  })

  it('uses the task reducer for sorted replay and fences stale live progress', () => {
    let listener: ((event: unknown) => void) | null = null
    const options = testOptions()
    ;(options.boot.value as any).runtime = {
      latestSeq: 3,
      events: [
        {
          event: 'task_done',
          seq: 3,
          session_id: 's1',
          task: {
            id: 'task-1',
            kind: 'subagent',
            status: 'completed',
            title: 'inspect',
            source: 'dispatch_subagent',
            endedAt: 3,
          },
        },
        {
          event: 'task_started',
          seq: 1,
          session_id: 's1',
          task: {
            id: 'task-1',
            kind: 'subagent',
            status: 'running',
            title: 'inspect',
            source: 'dispatch_subagent',
            startedAt: 1,
          },
        },
      ],
    }
    g.window = fakeWindow({
      invokeCore: async () => ({ ok: true }),
      onCoreEvent: (callback: (event: unknown) => void) => {
        listener = callback
        return () => {
          listener = null
        }
      },
    })
    const runtime = useRuntime(options)
    runtime.switchSession('s1')
    runtime.restoreFromHistory([])

    expect(runtime.taskProjection.tasks).toEqual([
      expect.objectContaining({
        id: 'task-1',
        status: 'completed',
        startedAt: 1,
        endedAt: 3,
      }),
    ])

    emitCoreEvent(listener, {
      event: 'task_progress',
      seq: 2,
      session_id: 's1',
      task: {
        id: 'task-1',
        kind: 'subagent',
        status: 'running',
        title: 'inspect',
        source: 'dispatch_subagent',
      },
      progress: { label: 'stale' },
    })
    expect(runtime.taskProjection.tasks[0]).toMatchObject({
      status: 'completed',
      endedAt: 3,
    })
  })

  it('marks sessions running from bootstrap active tasks (P1-7)', async () => {
    g.window = fakeWindow({
      invokeCore: async () => ({ ok: true }),
      onCoreEvent: () => () => {},
    })
    const options = testOptions()
    ;(options.boot.value as any).runtime.active_tasks = [
      {
        id: 'turn:t9',
        kind: 'turn',
        label: 'Agent turn',
        turn_id: 't9',
        session_id: 's9',
        cancelled: false,
      },
    ]
    const runtime = useRuntime(options)
    runtime.connectSocket()

    runtime.restoreFromHistory([])

    expect(runtime.sessionRuntimeStates['s9']).toMatchObject({ running: true })
  })

  it('does not restore hidden onboarding trigger messages from history fallback', () => {
    const options = testOptions()
    ;(options.boot.value as any).runtime.events = []
    const runtime = useRuntime(options)

    runtime.restoreFromHistory([
      {
        role: 'user',
        content: '[PROFILE_ONBOARDING]',
        source: 'onboarding',
        ui_hidden: true,
      },
      {
        role: 'assistant',
        content: '初次见面，我先了解一下你的偏好。',
        source: 'onboarding',
      },
    ])

    expect(runtime.messages.value).toMatchObject([
      {
        role: 'assistant',
        content: '初次见面，我先了解一下你的偏好。',
      },
    ])
  })

  it('merges streaming plan_draft_delta events into the final plan card', async () => {
    let listener: ((event: unknown) => void) | null = null
    g.window = fakeWindow({
      invokeCore: async () => ({ ok: true }),
      onCoreEvent: (cb: (event: unknown) => void) => {
        listener = cb
        return () => {
          listener = null
        }
      },
    })
    const runtime = useRuntime(testOptions())

    runtime.connectSocket()
    emitCoreEvent(listener, {
      event: 'user_message',
      seq: 1,
      turn_id: 'turn-plan',
      content: '制定计划',
    })
    emitCoreEvent(listener, {
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
    emitCoreEvent(listener, {
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
    emitCoreEvent(listener, {
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

    const assistant = runtime.messages.value.find(
      (message) => message.role === 'assistant',
    )
    const planSegments =
      assistant?.segments.filter((segment) => segment.type === 'plan') || []
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

  it('surfaces model fallback events as a transient pending notice (Wave4.3)', async () => {
    let listener: ((event: unknown) => void) | null = null
    g.window = fakeWindow({
      invokeCore: async () => ({ ok: true }),
      onCoreEvent: (cb: (event: unknown) => void) => {
        listener = cb
        return () => {
          listener = null
        }
      },
    })
    const runtime = useRuntime(testOptions())
    runtime.switchSession('s1')

    emitCoreEvent(listener, {
      event: 'model_route_fallback',
      seq: 1,
      from_model: 'claude-opus',
      to_model: 'gpt-4o',
      reason: 'provider timeout',
      usage_type: 'main_agent',
    })
    expect(runtime.pending.label).toContain('备用模型')
    expect(runtime.pending.detail).toContain('gpt-4o')

    emitCoreEvent(listener, {
      event: 'context_usage',
      seq: 2,
      usage_type: 'main_agent',
      used: 100,
      max: 1000,
      used_fallback: true,
      fallback_reason: 'rate_limited',
    })
    expect(runtime.pending.label).toContain('备用模型')
    expect(runtime.pending.detail).toContain('rate_limited')
  })

  it('distinguishes queued tools from running tools and settles both on turn end (Wave4.2)', async () => {
    let listener: ((event: unknown) => void) | null = null
    g.window = fakeWindow({
      invokeCore: async () => ({ ok: true }),
      onCoreEvent: (cb: (event: unknown) => void) => {
        listener = cb
        return () => {
          listener = null
        }
      },
    })
    const runtime = useRuntime(testOptions())
    runtime.switchSession('s1')

    emitCoreEvent(listener, {
      event: 'user_message',
      seq: 1,
      turn_id: 'turn-q',
      content: 'go',
    })
    emitCoreEvent(listener, {
      event: 'message_delta',
      seq: 2,
      turn_id: 'turn-q',
      delta: 'working',
    })
    emitCoreEvent(listener, {
      event: 'tool_run_queued',
      seq: 3,
      turn_id: 'turn-q',
      id: 'call_a',
      name: 'read_file',
      arguments: {},
    })
    emitCoreEvent(listener, {
      event: 'tool_run_queued',
      seq: 4,
      turn_id: 'turn-q',
      id: 'call_b',
      name: 'grep',
      arguments: {},
    })
    emitCoreEvent(listener, {
      event: 'tool_run_started',
      seq: 5,
      turn_id: 'turn-q',
      id: 'call_a',
      name: 'read_file',
    })

    const assistant = runtime.messages.value.find(
      (m) => m.role === 'assistant',
    ) as { segments: Array<{ type: string; toolId?: string; status?: string }> }
    const toolA = assistant.segments.find(
      (s) => s.type === 'tool' && s.toolId === 'call_a',
    )
    const toolB = assistant.segments.find(
      (s) => s.type === 'tool' && s.toolId === 'call_b',
    )
    expect(toolA?.status).toBe('running')
    expect(toolB?.status).toBe('queued')

    // 回合结束时 queued 段也要被 settle，不能永远停在排队态
    emitCoreEvent(listener, {
      event: 'assistant_done',
      seq: 6,
      turn_id: 'turn-q',
      content: 'done',
    })
    expect(toolB?.status).toBe('error_aborted')
  })

  it('blocks chat submit before local enqueue when the active session id is missing', async () => {
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

    expect(calls).toEqual([])
    expect(runtime.messages.value).toEqual([])
    expect(runtime.busy.value).toBe(false)
  })

  it('submits a draft first message with client draft id and project metadata (P1-6)', async () => {
    const calls: unknown[][] = []
    g.window = fakeWindow({
      invokeCore: async (...args: unknown[]) => {
        calls.push(args)
        return { ok: true }
      },
      onCoreEvent: () => () => {},
    })
    const runtime = useRuntime({
      ...testOptions(),
      resolveDraftSession: (id: string) =>
        id === 'draft:local-1'
          ? {
              id: 'draft:local-1',
              title: '新会话',
              created_at: '',
              updated_at: '',
              preview: '',
              mode: 'build' as const,
              project_id: 'p1',
              project_path: '/tmp/p',
              project_name: 'P',
              message_count: 0,
              title_status: 'draft',
              control_pending: null,
              version: 1,
              draft: true,
            }
          : undefined,
    })

    runtime.connectSocket()
    runtime.switchSession('draft:local-1')
    expect(runtime.sendMessage('第一条消息')).toBe(true)
    await flushPromises()

    const submit = calls.find((call) => call[0] === 'chat.submit')
    expect(submit).toBeTruthy()
    expect(submit![1]).toMatchObject({
      sessionId: 'draft:local-1',
      clientDraftId: 'draft:local-1',
      draftSession: {
        mode: 'build',
        project: {
          project_id: 'p1',
          project_path: '/tmp/p',
          project_name: 'P',
        },
      },
    })
    expect(
      runtime.messages.value.some((message) => message.role === 'user'),
    ).toBe(true)
  })
})

async function flushPromises(count = 5): Promise<void> {
  for (let i = 0; i < count; i += 1) await Promise.resolve()
}

function testOptions() {
  return {
    boot: ref({
      app: 'Emperor Agent',
      runtime: { events: [], latestSeq: 0 },
    } as unknown as BootstrapPayload),
    refreshMemory: vi.fn(async () => {}),
    showToast: vi.fn(),
  }
}

function fakeWindow(
  bridge: Record<string, unknown>,
  setItem: (...args: unknown[]) => void = () => undefined,
  setTimeoutImpl: (...args: any[]) => any = setTimeout.bind(globalThis),
) {
  return {
    emperor: bridge,
    localStorage: {
      getItem: () => null,
      setItem,
      removeItem: () => undefined,
    },
    location: { protocol: 'http:', host: 'localhost:5173' },
    setTimeout: setTimeoutImpl,
    clearTimeout: clearTimeout.bind(globalThis),
  }
}

function emitCoreEvent(
  listener: ((event: unknown) => void) | null,
  event: unknown,
) {
  if (!listener) throw new Error('listener not registered')
  listener(event)
}

function invokeCallback<T extends unknown[]>(
  callback: ((...args: T) => void) | null,
  ...args: T
) {
  if (!callback) throw new Error('callback not registered')
  callback(...args)
}
