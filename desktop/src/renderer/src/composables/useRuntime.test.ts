import { afterEach, describe, expect, it, vi } from 'vitest'
import { nextTick, ref } from 'vue'
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
    expect(runtime.sendMessage('hello')).toBe(true)
    await Promise.resolve()

    expect(calls[0]).toEqual(['chat.submit', expect.objectContaining({ content: 'hello', displayContent: 'hello' })])
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(runtime.messages.value.at(-1)).toMatchObject({ role: 'assistant', content: 'pong', streaming: false })
    expect(runtime.busy.value).toBe(false)
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
      ['control.answerInteraction', 'ask_1', { scope: { choice: '完整' } }, expect.objectContaining({ clientMessageId: expect.any(String) })],
    ])
    expect(runtime.messages.value[0]).toMatchObject({ role: 'user', content: '已回答澄清问题' })
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
})

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
