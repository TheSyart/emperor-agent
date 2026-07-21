import { describe, expect, it, vi } from 'vitest'
import { EnvironmentError, PromptQueueFullError } from '@emperor/core'
import { channelForCoreOperation } from '../shared/ipc-contract'
import { registerCoreIpc, type CoreApiLike } from './ipc'

describe('core IPC bridge (MIG-IPC-002)', () => {
  it('derives stable namespaced channels from CoreApi operation keys', () => {
    expect(channelForCoreOperation('bootstrap')).toBe('emperor:core:bootstrap')
    expect(channelForCoreOperation('sessions.create')).toBe(
      'emperor:core:sessions:create',
    )
    expect(channelForCoreOperation('chat.submit')).toBe(
      'emperor:core:chat:submit',
    )
  })

  it('registers handlers that invoke the matching CoreApi method', async () => {
    const ipc = new FakeIpcMain()
    const api = {
      sessions: {
        create: (opts: Record<string, unknown>) => ({ id: 's1', ...opts }),
      },
      bootstrap: () => ({ app: 'Emperor Agent' }),
    }

    registerCoreIpc(ipc, asCoreApi(api), ['sessions.create', 'bootstrap'])

    expect(ipc.channels()).toEqual([
      'emperor:core:bootstrap',
      'emperor:core:sessions:create',
    ])
    await expect(
      ipc.invoke('emperor:core:sessions:create', { title: '新会话' }),
    ).resolves.toEqual({ id: 's1', title: '新会话' })
    await expect(ipc.invoke('emperor:core:bootstrap')).resolves.toEqual({
      app: 'Emperor Agent',
    })
  })

  it('rejects malformed arguments before the CoreApi adapter runs', async () => {
    const ipc = new FakeIpcMain()
    const create = vi.fn(() => ({ id: 's1' }))
    registerCoreIpc(ipc, asCoreApi({ sessions: { create } }), [
      'sessions.create',
    ])

    await expect(
      ipc.invoke('emperor:core:sessions:create', { title: 42 }),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: 'invalid_core_arguments',
        message: 'Invalid arguments for sessions.create',
      },
    })
    expect(create).not.toHaveBeenCalled()
  })

  it('authorizes the IPC caller before invoking the CoreApi adapter', async () => {
    const ipc = new FakeIpcMain()
    const create = vi.fn(() => ({ id: 's1' }))
    const authorize = vi.fn(() => {
      throw Object.assign(new Error('untrusted renderer'), {
        toSafe: () => ({
          code: 'forbidden_ipc_caller',
          message: 'IPC caller is not trusted',
        }),
      })
    })
    registerCoreIpc(
      ipc,
      asCoreApi({ sessions: { create } }),
      ['sessions.create'],
      { authorize },
    )

    await expect(
      ipc.invoke('emperor:core:sessions:create', { title: '新会话' }),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: 'forbidden_ipc_caller',
        message: 'IPC caller is not trusted',
      },
    })
    expect(authorize).toHaveBeenCalledOnce()
    expect(create).not.toHaveBeenCalled()
  })

  it('invokes prototype operations with their owning receiver', async () => {
    const ipc = new FakeIpcMain()
    class Api {
      readonly app = 'Emperor Agent'

      bootstrap() {
        return { app: this.app }
      }
    }
    registerCoreIpc(ipc, asCoreApi(new Api()), ['bootstrap'])

    await expect(ipc.invoke('emperor:core:bootstrap')).resolves.toEqual({
      app: 'Emperor Agent',
    })
  })

  it('maps thrown implementation errors to safe renderer payloads', async () => {
    const ipc = new FakeIpcMain()
    const errorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined)
    registerCoreIpc(
      ipc,
      asCoreApi({
        model: {
          test: () => {
            throw new Error('secret stack details')
          },
        },
      }),
      ['model.test'],
    )

    const payload = await ipc.invoke('emperor:core:model:test', {
      entryId: 'main',
    })

    expect(payload).toMatchObject({
      ok: false,
      error: { message: 'Internal error' },
    })
    expect(String(payload.error.errorId)).toMatch(/^ipc_/)
    expect(JSON.stringify(payload)).not.toContain('secret stack details')
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringMatching(
        /^\[core-ipc\] model\.test failed \(ipc_[a-z0-9]+\)$/,
      ),
      expect.any(Error),
    )
    errorSpy.mockRestore()
  })

  it('preserves stable Environment error codes without leaking internals', async () => {
    const ipc = new FakeIpcMain()
    registerCoreIpc(
      ipc,
      asCoreApi({
        environment: {
          install: () => {
            throw new EnvironmentError('integrity_failed', {
              detail: 'https://private.example/tool?token=secret',
            })
          },
        },
      }),
      ['environment.install'],
    )

    const payload = await ipc.invoke('emperor:core:environment:install', {
      planId: 'plan_1',
      acceptedLicenseIds: [],
      confirmedStepIds: [],
    })

    expect(payload).toEqual({
      ok: false,
      error: {
        code: 'integrity_failed',
        message: '安装资源完整性校验失败，文件不会被执行。',
        action: 'retry_download',
      },
    })
    expect(JSON.stringify(payload)).not.toContain('token=secret')
  })

  it('preserves the single prompt queue capacity error for renderer recovery', async () => {
    const ipc = new FakeIpcMain()
    registerCoreIpc(
      ipc,
      asCoreApi({
        chat: {
          submit: () => {
            throw new PromptQueueFullError('private-session-id')
          },
        },
      }),
      ['chat.submit'],
    )

    const payload = await ipc.invoke('emperor:core:chat:submit', {
      content: 'second queued prompt',
    })

    expect(payload).toEqual({
      ok: false,
      error: {
        code: 'prompt_queue_full',
        message: '已有一条消息排队，请先处理后再发送。',
        action: 'manage_prompt_queue',
      },
    })
    expect(JSON.stringify(payload)).not.toContain('private-session-id')
  })

  it('contains failures thrown by a domain error serializer', async () => {
    const ipc = new FakeIpcMain()
    const errorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined)
    const unsafeError = Object.assign(new Error('secret domain detail'), {
      toSafe: () => {
        throw new Error('serializer secret')
      },
    })
    registerCoreIpc(
      ipc,
      asCoreApi({
        model: {
          test: () => {
            throw unsafeError
          },
        },
      }),
      ['model.test'],
    )

    const payload = await ipc.invoke('emperor:core:model:test', {
      entryId: 'main',
    })

    expect(payload).toMatchObject({
      ok: false,
      error: { message: 'Internal error' },
    })
    expect(String(payload.error.errorId)).toMatch(/^ipc_/)
    expect(JSON.stringify(payload)).not.toContain('secret')
    errorSpy.mockRestore()
  })

  it('contains hostile throwable property traps in the safe error envelope', async () => {
    const ipc = new FakeIpcMain()
    const errorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined)
    const hostileError = Object.defineProperty(
      new Error('secret throwable'),
      'name',
      {
        get() {
          throw new Error('secret name getter')
        },
      },
    )
    Object.defineProperty(hostileError, 'toSafe', {
      get() {
        throw new Error('secret serializer getter')
      },
    })
    registerCoreIpc(
      ipc,
      asCoreApi({
        model: {
          test: () => {
            throw hostileError
          },
        },
      }),
      ['model.test'],
    )

    const payload = await ipc.invoke('emperor:core:model:test', {
      entryId: 'main',
    })

    expect(payload).toMatchObject({
      ok: false,
      error: { message: 'Internal error' },
    })
    expect(JSON.stringify(payload)).not.toContain('secret')
    errorSpy.mockRestore()
  })

  it('contains unknown well-formed keys inside the fixed Core namespace', () => {
    expect(channelForCoreOperation('missing.operation' as never)).toBe(
      'emperor:core:missing:operation',
    )
  })

  it('rejects malformed keys before they can escape the Core namespace', () => {
    for (const key of [
      '',
      '.bootstrap',
      'bootstrap.',
      'chat..submit',
      'chat:submit',
      '../bootstrap',
      'chat/submit',
      'chat submit',
    ]) {
      expect(() => channelForCoreOperation(key as never)).toThrow(
        'invalid core IPC operation',
      )
    }
  })

  it('passes safe domain errors through the IPC boundary', async () => {
    const ipc = new FakeIpcMain()
    const error = Object.assign(new Error('还没有可用模型，请先配置模型。'), {
      code: 'model_configuration_required',
      action: 'open_model_settings',
      toSafe: () => ({
        code: 'model_configuration_required',
        message: '还没有可用模型，请先配置模型。',
        action: 'open_model_settings',
      }),
    })
    registerCoreIpc(
      ipc,
      asCoreApi({
        chat: {
          submit: () => {
            throw error
          },
        },
      }),
      ['chat.submit'],
    )

    await expect(
      ipc.invoke('emperor:core:chat:submit', { content: 'hello' }),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'model_configuration_required',
        message: '还没有可用模型，请先配置模型。',
        action: 'open_model_settings',
      },
    })
  })

  it('preserves benign turn interruption codes for renderer control flow', async () => {
    const ipc = new FakeIpcMain()
    const turnPaused = new Error('turn paused for ask: ask_1')
    turnPaused.name = 'TurnPaused'
    const cancelled = new Error('active task cancelled: turn_1')
    cancelled.name = 'CancelledTaskError'
    const busy = new Error('Another agent turn is already running')
    busy.name = 'TurnBusyError'
    registerCoreIpc(
      ipc,
      asCoreApi({
        chat: {
          submit: () => {
            throw turnPaused
          },
          stopRuntime: (opts: { kind?: string }) => {
            if (opts.kind === 'turn') throw cancelled
            throw busy
          },
        },
      }),
      ['chat.submit', 'chat.stopRuntime'],
    )

    await expect(
      ipc.invoke('emperor:core:chat:submit', { content: 'hello' }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'turn_paused', message: 'Turn paused' },
    })
    await expect(
      ipc.invoke('emperor:core:chat:stopRuntime', { kind: 'turn' }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'cancelled', message: 'Task cancelled' },
    })
    await expect(
      ipc.invoke('emperor:core:chat:stopRuntime', {}),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'turn_busy',
        message: 'Another agent turn is already running',
      },
    })
  })
})

function asCoreApi(value: unknown): CoreApiLike {
  return value as CoreApiLike
}

type Handler = (_event: unknown, ...args: unknown[]) => unknown

class FakeIpcMain {
  private readonly handlers = new Map<string, Handler>()

  handle(channel: string, handler: Handler): void {
    this.handlers.set(channel, handler)
  }

  channels(): string[] {
    return [...this.handlers.keys()].sort()
  }

  async invoke(channel: string, ...args: unknown[]): Promise<any> {
    const handler = this.handlers.get(channel)
    if (!handler) throw new Error(`missing handler: ${channel}`)
    return handler({}, ...args)
  }
}
