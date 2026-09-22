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
  it('refreshes memory and slash Skills after a live assistant completes', async () => {
    let listener: ((event: unknown) => void) | null = null
    g.window = fakeWindow({
      invokeCore: async () => ({ ok: true }),
      onCoreEvent: (callback: (event: unknown) => void) => {
        listener = callback
        return () => undefined
      },
    })
    const options = testOptions()
    const runtime = useRuntime(options)
    runtime.connectSocket()
    runtime.switchSession('s1')

    emitCoreEvent(listener, {
      event: 'assistant_done',
      seq: 1,
      session_id: 's1',
      turn_id: 'turn-1',
      content: 'done',
    })
    await flushPromises()

    expect(options.refreshMemory).toHaveBeenCalledOnce()
    expect(options.refreshCommands).toHaveBeenCalledOnce()
  })

  it('refreshes the queue tray on live prompt_queued / prompt_dequeued events', async () => {
    let listener: ((event: unknown) => void) | null = null
    let queue: Array<Record<string, unknown>> = []
    const calls: unknown[][] = []
    g.window = fakeWindow({
      invokeCore: async (...args: unknown[]) => {
        calls.push(args)
        if (args[0] === 'chat.listQueuedPrompts') return queue
        return { ok: true }
      },
      onCoreEvent: (callback: (event: unknown) => void) => {
        listener = callback
        return () => undefined
      },
    })
    const runtime = useRuntime(testOptions())
    runtime.connectSocket()
    runtime.switchSession('s1')
    await flushPromises()
    const listCalls = () =>
      calls.filter((call) => call[0] === 'chat.listQueuedPrompts').length
    const before = listCalls()

    queue = [
      {
        id: 'p1',
        turnId: null,
        clientMessageId: 'p1',
        content: 'later',
        displayContent: 'later',
        delivery: 'queue',
        supportsInterjection: true,
        createdOrder: 1,
        attachmentIds: [],
        requestedSkills: [],
      },
    ]
    emitCoreEvent(listener, {
      event: 'prompt_queued',
      seq: 0,
      session_id: 's1',
      prompt_id: 'p1',
    })
    await flushPromises()
    expect(listCalls()).toBe(before + 1)
    expect(runtime.queuedPrompts.value).toEqual([
      expect.objectContaining({ id: 'p1', content: 'later' }),
    ])

    queue = []
    emitCoreEvent(listener, {
      event: 'prompt_dequeued',
      seq: 0,
      session_id: 's1',
      prompt_id: 'p1',
    })
    await flushPromises()
    expect(listCalls()).toBe(before + 2)
    expect(runtime.queuedPrompts.value).toEqual([])
  })

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
    // No optimistic chat bubble: the transcript renders from the raw log.
    expect(runtime).not.toHaveProperty('messages')
    await Promise.resolve()

    expect(calls.find((call) => call[0] === 'chat.submit')).toEqual([
      'chat.submit',
      expect.objectContaining({
        content: 'hello',
        displayContent: 'hello',
        sessionId: 's1',
      }),
    ])
    expect(fetchSpy).not.toHaveBeenCalled()
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

  it('submits a busy prompt as an interjection and keeps the turn busy', async () => {
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
    expect(runtime.queuedPrompts.value.at(-1)).toMatchObject({
      content: 'interrupt now',
      delivery: 'interject',
    })
    expect(runtime.busy.value).toBe(true)

    emitCoreEvent(listener, {
      event: 'prompt_interjected',
      seq: 1,
      session_id: 's1',
      turn_id: 'prompt-turn',
      prompt_id: runtime.queuedPrompts.value.at(-1)?.id,
      client_message_id: runtime.queuedPrompts.value.at(-1)?.id,
      target_turn_id: 'owner-turn',
    })
    expect(runtime.queuedPrompts.value).toEqual([])
  })

  it('does not surface the expected submit rejection after cancelling a queued prompt', async () => {
    let rejectSubmit!: (error: unknown) => void
    const showToast = vi.fn()
    g.window = fakeWindow({
      invokeCore: (...args: unknown[]) => {
        if (args[0] === 'chat.submit')
          return new Promise((_resolve, reject) => {
            rejectSubmit = reject
          })
        if (args[0] === 'chat.listQueuedPrompts') return Promise.resolve([])
        if (args[0] === 'chat.manageQueuedPrompt')
          return Promise.resolve({ ok: true })
        return Promise.resolve({ ok: true })
      },
    })
    const runtime = useRuntime({ ...testOptions(), showToast })
    runtime.switchSession('s1')
    await flushPromises()
    runtime.busy.value = true
    runtime.sendMessage({ content: 'later', delivery: 'queue' })
    const queued = runtime.queuedPrompts.value[0]!

    await expect(runtime.manageQueuedPrompt(queued.id, 'cancel')).resolves.toBe(
      true,
    )
    rejectSubmit({ code: 'session_runtime_command_cancelled' })
    await flushPromises()

    expect(runtime.queuedPrompts.value).toEqual([])
    expect(showToast).not.toHaveBeenCalled()
  })

  it('publishes the rejected payload for Composer recovery when the Core queue slot is full', async () => {
    const showToast = vi.fn()
    g.window = fakeWindow({
      invokeCore: (...args: unknown[]) => {
        if (args[0] === 'chat.submit')
          return Promise.reject({ code: 'prompt_queue_full', capacity: 1 })
        if (args[0] === 'chat.listQueuedPrompts') return Promise.resolve([])
        return Promise.resolve({ ok: true })
      },
      onCoreEvent: () => () => {},
    })
    const runtime = useRuntime({ ...testOptions(), showToast })
    runtime.switchSession('s1')
    await flushPromises()
    runtime.busy.value = true
    const attachment = {
      id: 'att_recover',
      name: 'recover.txt',
      mime: 'text/plain',
      size: 7,
      kind: 'text' as const,
      hasText: true,
      hasImage: false,
      path: '/tmp/recover.txt',
    }

    expect(
      runtime.sendMessage({
        content: 'recover this submission',
        displayContent: '@skill(review) recover this submission',
        delivery: 'queue',
        requestedSkills: [{ name: 'review', source: 'slash' }],
        attachments: [attachment],
      }),
    ).toBe(true)
    await flushPromises(10)

    expect(runtime.queueDraftRecovery.value).toEqual({
      sessionId: 's1',
      payload: {
        content: 'recover this submission',
        displayContent: '@skill(review) recover this submission',
        delivery: 'queue',
        requestedSkills: [{ name: 'review', source: 'slash' }],
        attachments: [attachment],
      },
    })
    expect(showToast).toHaveBeenCalledWith(
      '已有一条消息排队，请先编辑、插入或删除后再发送。',
    )
  })

  it('queues attachments and requested Skills while a turn is busy', async () => {
    const calls: unknown[][] = []
    g.window = fakeWindow({
      invokeCore: async (...args: unknown[]) => {
        calls.push(args)
        if (args[0] === 'chat.listQueuedPrompts') return []
        return { ok: true }
      },
      onCoreEvent: () => () => {},
    })
    const runtime = useRuntime(testOptions())
    runtime.switchSession('s1')
    await flushPromises()
    runtime.busy.value = true

    expect(
      runtime.sendMessage({
        content: 'analyse this',
        displayContent: '@skill(review) analyse this',
        delivery: 'queue',
        requestedSkills: [{ name: 'review', source: 'slash' }],
        attachments: [
          {
            id: 'att_1',
            name: 'report.txt',
            mime: 'text/plain',
            size: 12,
            kind: 'text',
            hasText: true,
            hasImage: false,
            path: '/tmp/report.txt',
          },
        ],
      }),
    ).toBe(true)
    await flushPromises()

    expect(calls.find((call) => call[0] === 'chat.submit')?.[1]).toMatchObject({
      sessionId: 's1',
      delivery: 'queue',
      attachments: ['att_1'],
      requestedSkills: [{ name: 'review', source: 'slash' }],
    })
    expect(runtime.queuedPrompts.value).toEqual([
      expect.objectContaining({
        content: '@skill(review) analyse this',
        attachmentCount: 1,
        requestedSkillNames: ['review'],
        supportsInterjection: false,
      }),
    ])
  })

  it('keeps the turn busy while an ask waits inside the running turn', async () => {
    let listener: ((event: unknown) => void) | null = null
    g.window = fakeWindow({
      invokeCore: async (...args: unknown[]) => {
        if (args[0] === 'chat.submit') {
          emitCoreEvent(listener, {
            event: 'turn_phase',
            seq: 17,
            session_id: 's1',
            turn_id: 's1:1',
            phase: 'started',
          })
          emitCoreEvent(listener, {
            event: 'ask_request',
            seq: 33,
            session_id: 's1',
            turn_id: 's1:1',
            interaction: {
              id: 'ask_q1',
              kind: 'ask',
              status: 'waiting',
              questions: [
                { id: 'q', header: '', question: '选哪个？', options: [] },
              ],
            },
          })
          return new Promise(() => {})
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
    const options = testOptions()
    const runtime = useRuntime(options)

    runtime.switchSession('s1')
    expect(runtime.sendMessage('需要澄清')).toBe(true)
    await flushPromises()

    expect(options.showToast).not.toHaveBeenCalledWith(
      expect.stringContaining('出错了'),
    )
    expect(runtime.busy.value).toBe(true)
    expect(runtime.pending.label).toBe('等待你回答')
    expect(runtime.pendingInteractionsBySession.s1?.id).toBe('ask_q1')
  })

  it('does not surface an error when a stopped chat turn rejects as cancelled', async () => {
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
    const options = testOptions()
    const runtime = useRuntime(options)

    runtime.switchSession('s1')
    expect(runtime.sendMessage('停止我')).toBe(true)
    await flushPromises()

    expect(options.showToast).not.toHaveBeenCalledWith(
      expect.stringContaining('出错了'),
    )
    expect(runtime.pending.label).toBe('任务已停止')
    expect(runtime.busy.value).toBe(false)
  })

  it('does not surface an error when Core rejects a concurrent chat turn as busy', async () => {
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
    const options = testOptions()
    const runtime = useRuntime(options)

    runtime.switchSession('s1')
    expect(runtime.sendMessage('第二条')).toBe(true)
    await flushPromises()

    expect(options.showToast).not.toHaveBeenCalledWith(
      expect.stringContaining('出错了'),
    )
    expect(runtime.pending.label).toBe('已有任务正在运行')
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
    const options = testOptions()
    const runtime = useRuntime(options)

    runtime.switchSession('s1')
    expect(runtime.sendMessage('hi')).toBe(true)
    await flushPromises()

    expect(runtime.busy.value).toBe(false)
    expect(runtime.status.value).toBe('ready')
    expect(runtime.sessionRuntimeStates['s1']).toMatchObject({
      running: false,
      attention: false,
    })
    // A rejected submit has no log row: it surfaces as a toast.
    expect(options.showToast).toHaveBeenCalledWith(
      '出错了：还没有可用模型，请先配置模型。',
    )
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
    const options = testOptions()
    const runtime = useRuntime(options)

    runtime.switchSession('s1')
    expect(runtime.sendMessage('hi')).toBe(true)
    await flushPromises()

    // The turn error renders as a log row; the matching rejection stays quiet.
    expect(options.showToast).not.toHaveBeenCalledWith(
      expect.stringContaining('出错了'),
    )
    expect(runtime.busy.value).toBe(false)
    expect(runtime.sessionRuntimeStates['s1']).toMatchObject({
      running: false,
      attention: false,
    })
  })

  it('ignores live runtime events from another session for the active busy state', async () => {
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
      event: 'turn_phase',
      seq: 99,
      session_id: 'session-other',
      turn_id: 'turn-other',
      phase: 'started',
    })
    expect(runtime.busy.value).toBe(false)
    expect(runtime.sessionRuntimeStates['session-other']).toMatchObject({
      running: true,
    })
    emitCoreEvent(listener, {
      event: 'turn_phase',
      seq: 1,
      session_id: 'session-current',
      turn_id: 'turn-current',
      phase: 'started',
    })
    expect(runtime.busy.value).toBe(true)
    emitCoreEvent(listener, {
      event: 'assistant_done',
      seq: 100,
      session_id: 'session-other',
      turn_id: 'turn-other',
      content: 'foreign done',
    })
    expect(runtime.busy.value).toBe(true)
    emitCoreEvent(listener, {
      event: 'assistant_done',
      seq: 3,
      session_id: 'session-current',
      turn_id: 'turn-current',
      content: 'local answer',
    })
    expect(runtime.busy.value).toBe(false)
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
    expect(runtime.busy.value).toBe(false)
    expect(runtime.sessionRuntimeStates['session-other']).toMatchObject({
      running: true,
    })
    expect(runtime.sessionRuntimeStates['session-real']).toMatchObject({
      running: false,
    })
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
    expect(runtime.pendingInteractionsBySession).toMatchObject({
      'session-owner': expect.objectContaining({ id: 'ask_owner' }),
    })
    expect(
      runtime.pendingInteractionsBySession['session-other'],
    ).toBeUndefined()

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
    expect(
      runtime.pendingInteractionsBySession['session-owner'],
    ).toBeUndefined()
  })

  it('indexes and clears pending interactions for the currently open session', () => {
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
    runtime.switchSession('session-owner')
    emitCoreEvent(listener, {
      event: 'ask_request',
      seq: 1,
      session_id: 'session-owner',
      interaction: { id: 'ask_owner', kind: 'ask', status: 'waiting' },
    })

    expect(runtime.pendingInteractionsBySession['session-owner']).toEqual(
      expect.objectContaining({ id: 'ask_owner' }),
    )

    emitCoreEvent(listener, {
      event: 'interaction_cancelled',
      seq: 2,
      session_id: 'session-owner',
      interaction: { id: 'ask_owner', kind: 'ask', status: 'cancelled' },
    })

    expect(
      runtime.pendingInteractionsBySession['session-owner'],
    ).toBeUndefined()
  })

  it('ignores a stale terminal interaction event after a newer Ask is waiting', () => {
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
    runtime.switchSession('session-owner')
    emitCoreEvent(listener, {
      event: 'ask_request',
      seq: 1,
      session_id: 'session-owner',
      interaction: { id: 'ask-1', kind: 'ask', status: 'waiting' },
    })
    emitCoreEvent(listener, {
      event: 'ask_answered',
      seq: 2,
      session_id: 'session-owner',
      interaction: { id: 'ask-1', kind: 'ask', status: 'answered' },
    })
    emitCoreEvent(listener, {
      event: 'ask_request',
      seq: 3,
      session_id: 'session-owner',
      interaction: { id: 'ask-2', kind: 'ask', status: 'waiting' },
    })
    emitCoreEvent(listener, {
      event: 'ask_answered',
      seq: 2,
      session_id: 'session-owner',
      interaction: { id: 'ask-1', kind: 'ask', status: 'answered' },
    })

    expect(runtime.pendingInteractionsBySession['session-owner']).toEqual(
      expect.objectContaining({ id: 'ask-2' }),
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

    runtime.restoreRuntimeState()

    expect(runtime.busy.value).toBe(false)
    expect(
      runtime.sessionRuntimeStates['s1'] ?? { running: false },
    ).toMatchObject({ running: false })
  })

  it('restores a busy session from a replay whose turn is still open', () => {
    g.window = fakeWindow({
      invokeCore: async () => ({ ok: true }),
      onCoreEvent: () => () => {},
    })
    const boot = ref({
      app: 'Emperor Agent',
      runtime: {
        latestSeq: 2,
        busy: true,
        events: [
          {
            event: 'user_message',
            seq: 1,
            session_id: 's1',
            turn_id: 'turn-open',
            content: 'build it',
          },
          {
            event: 'turn_phase',
            seq: 2,
            session_id: 's1',
            turn_id: 'turn-open',
            phase: 'started',
          },
        ],
      },
    } as unknown as BootstrapPayload)
    const runtime = useRuntime({ ...testOptions(), boot })
    runtime.switchSession('s1')

    runtime.restoreRuntimeState()

    expect(runtime.busy.value).toBe(true)
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
    runtime.restoreRuntimeState()
    expect(runtime.busy.value).toBe(false)

    await expect(runtime.stopActive()).resolves.toBe(false)

    expect(runtime.busy.value).toBe(false)
    expect(runtime.pending.label).toBe('没有正在运行的任务')
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
    const options = testOptions()
    const runtime = useRuntime(options)
    runtime.switchSession('s1')

    expect(runtime.sendMessage('hello')).toBe(true)
    await Promise.resolve()
    await expect(runtime.stopActive()).resolves.toBe(true)
    invokeCallback(rejectSubmit, new Error('active task cancelled: turn:1'))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(runtime.status.value).toBe('ready')
    expect(options.showToast).not.toHaveBeenCalledWith(
      expect.stringContaining('出错了'),
    )
    expect(runtime.busy.value).toBe(false)
  })

  it('answers pending interactions through Core IPC without a resume turn', async () => {
    const calls: unknown[][] = []
    g.window = fakeWindow({
      invokeCore: async (...args: unknown[]) => {
        calls.push(args)
        return { interactionId: 'ask_1', sessionId: 's1', control: null }
      },
      onCoreEvent: () => () => {},
    })
    const runtime = useRuntime(testOptions())

    expect(
      runtime.sendInteractionAnswer('ask_1', { scope: { choice: '完整' } }),
    ).toBe(true)
    await Promise.resolve()

    expect(calls).toEqual([
      ['control.answerInteraction', 'ask_1', { scope: { choice: '完整' } }, {}],
    ])
    expect(runtime.busy.value).toBe(false)
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
        {},
      ],
    ])
  })

  it('does not end the busy turn on hidden control resume user_message events', async () => {
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
    runtime.busy.value = true
    emitCoreEvent(listener, {
      event: 'user_message',
      seq: 1,
      session_id: 's1',
      turn_id: 'turn-control',
      client_message_id: 'control-msg-1',
      source: 'control',
      ui_hidden: true,
      content: '',
    })

    expect(runtime.busy.value).toBe(true)
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

    emitCoreEvent(listener, {
      event: 'message_delta',
      seq: 2,
      session_id: 's2',
      turn_id: 't2',
      delta: 'bg',
    })
    expect(runtime.sessionRuntimeStates['s2']).toMatchObject({ running: true })

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

  it('keeps background pending state session-scoped and restores it on switch', () => {
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
      event: 'ask_request',
      seq: 1,
      session_id: 's2',
      turn_id: 't2',
      interaction: {
        id: 'ask-s2',
        kind: 'ask',
        status: 'waiting',
        title: '后台问题',
      },
    })

    expect(runtime.pending.label).toBe('')
    expect(runtime.sessionRuntimeStates.s2?.pending).toMatchObject({
      label: '等待你回答',
      detail: '后台问题',
      tone: 'done',
    })

    runtime.switchSession('s2')
    expect(runtime.pending).toMatchObject({
      label: '等待你回答',
      detail: '后台问题',
      tone: 'done',
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
    expect(runtime.busy.value).toBe(false)
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

    runtime.restoreRuntimeState()

    expect(setTimeoutSpy).not.toHaveBeenCalled()
    expect(options.refreshMemory).not.toHaveBeenCalled()
    expect(options.refreshCommands).not.toHaveBeenCalled()
    expect(runtime.busy.value).toBe(false)
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
    runtime.restoreRuntimeState()

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

    runtime.restoreRuntimeState()

    expect(runtime.sessionRuntimeStates['s9']).toMatchObject({ running: true })
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
    expect(runtime.busy.value).toBe(true)
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
    refreshCommands: vi.fn(async () => {}),
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
