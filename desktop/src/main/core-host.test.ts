import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  channelForCoreOperation,
  SESSION_EVENT_CHANNEL,
} from '../shared/ipc-contract'
import {
  coreOperationKeys,
  createCoreHost,
  registerCoreHostIpc,
} from './core-host'
import { SessionEventBridge } from './event-bridge'
import type { CoreApiLike } from './ipc'

describe('desktop CoreApi host (MIG-IPC-002)', () => {
  it('registers every CoreApi operation on the Electron IPC boundary', () => {
    const ipc = new FakeIpcMain()
    registerCoreHostIpc(ipc, {
      bootstrap: async () => ({ app: 'Emperor Agent' }),
    } as unknown as CoreApiLike)

    expect(coreOperationKeys()).toContain('bootstrap')
    expect(coreOperationKeys()).toContain('control.answerInteraction')
    expect(coreOperationKeys()).toEqual(
      expect.arrayContaining([
        'goals.start',
        'goals.list',
        'goals.get',
        'goals.pause',
        'goals.resume',
        'goals.cancel',
      ]),
    )
    expect(ipc.channels()).toContain(channelForCoreOperation('bootstrap'))
    expect(ipc.channels()).toContain(
      channelForCoreOperation('control.answerInteraction'),
    )
    expect(ipc.channels()).toHaveLength(coreOperationKeys().length)
    expect(coreOperationKeys()).toEqual(
      expect.arrayContaining([
        'hooks.getConfig',
        'hooks.saveConfig',
        'hooks.getAudit',
        'hooks.testRun',
        'hooks.getMetadata',
        'hooks.validateConfig',
        'hooks.setProjectTrust',
        'hooks.testMatch',
        'hooks.cancelRun',
        'environment.getStatus',
        'environment.createInstallPlan',
        'environment.install',
        'environment.cancelInstall',
        'environment.getInstallLog',
        'mcp.importServers',
        'mcp.setServerEnabled',
        'mcp.removeServer',
        'skills.import',
        'skills.copyToUser',
        'git.remote',
        'pullRequests.status',
        'pullRequests.list',
        'pullRequests.view',
        'pullRequests.diff',
      ]),
    )
    for (const retired of [
      'skills.previewInstall',
      'skills.confirmInstall',
      'skills.package',
      'fileCheckpoints.list',
      'team.get',
      'plans.list',
      'projectProcesses.stop',
      'goals.replace',
    ])
      expect(coreOperationKeys()).not.toContain(retired)
  })

  it('routes the raw session-log operations through IPC', async () => {
    const ipc = new FakeIpcMain()
    const calls: unknown[] = []
    registerCoreHostIpc(ipc, {
      sessions: {
        history: (input: unknown) => {
          calls.push(['history', input])
          return {
            header: { id: 's1' },
            events: [],
            hasMore: false,
            lastSeq: -1,
          }
        },
        lineage: (input: unknown) => {
          calls.push(['lineage', input])
          return { chain: [{ sessionId: 's1' }] }
        },
        children: (input: unknown) => {
          calls.push(['children', input])
          return []
        },
        watch: (input: { sessionIds: string[] }) => {
          calls.push(['watch', input])
          return { watching: input.sessionIds }
        },
      },
    } as unknown as CoreApiLike)

    for (const key of [
      'sessions.history',
      'sessions.event',
      'sessions.lineage',
      'sessions.children',
      'sessions.watch',
    ] as const)
      expect(ipc.channels()).toContain(channelForCoreOperation(key))
    await expect(
      ipc.invoke(channelForCoreOperation('sessions.history'), {
        sessionId: 's1',
        beforeSeq: 4,
      }),
    ).resolves.toMatchObject({ hasMore: false, lastSeq: -1 })
    await expect(
      ipc.invoke(channelForCoreOperation('sessions.watch'), {
        sessionIds: ['s1'],
      }),
    ).resolves.toEqual({ watching: ['s1'] })
    await expect(
      ipc.invoke(channelForCoreOperation('sessions.history'), {
        sessionId: '../x',
      }),
    ).resolves.toMatchObject({ ok: false })
    expect(calls).toEqual([
      ['history', { sessionId: 's1', beforeSeq: 4 }],
      ['watch', { sessionIds: ['s1'] }],
    ])
  })

  it('routes the named MCP server operations through IPC with validation', async () => {
    const ipc = new FakeIpcMain()
    const calls: unknown[] = []
    registerCoreHostIpc(ipc, {
      mcp: {
        importServers: (input: unknown) => {
          calls.push(['import', input])
          return { added: ['aihot'], dryRun: true }
        },
        setServerEnabled: (input: unknown) => {
          calls.push(['enabled', input])
          return { name: 'aihot', enabled: false }
        },
        removeServer: (input: unknown) => {
          calls.push(['remove', input])
          return { removed: 'aihot' }
        },
      },
    } as unknown as CoreApiLike)

    const raw = '{"mcpServers":{"aihot":{"type":"http","url":"https://x"}}}'
    await expect(
      ipc.invoke(channelForCoreOperation('mcp.importServers'), {
        raw,
        dryRun: true,
      }),
    ).resolves.toMatchObject({ added: ['aihot'] })
    await expect(
      ipc.invoke(channelForCoreOperation('mcp.setServerEnabled'), {
        name: 'aihot',
        enabled: false,
      }),
    ).resolves.toMatchObject({ enabled: false })
    await expect(
      ipc.invoke(channelForCoreOperation('mcp.removeServer'), {
        name: 'aihot',
      }),
    ).resolves.toMatchObject({ removed: 'aihot' })
    await expect(
      ipc.invoke(channelForCoreOperation('mcp.importServers'), {
        raw,
        command: 'echo pwned',
      }),
    ).resolves.toMatchObject({ ok: false })
    expect(calls).toEqual([
      ['import', { raw, dryRun: true }],
      ['enabled', { name: 'aihot', enabled: false }],
      ['remove', { name: 'aihot' }],
    ])
  })

  it('routes git.remote and the global pull request operations with validation', async () => {
    const ipc = new FakeIpcMain()
    const calls: unknown[] = []
    registerCoreHostIpc(ipc, {
      git: {
        remote: (input: unknown) => {
          calls.push(['remote', input])
          return {
            name: 'origin',
            webUrl: 'https://github.com/acme/widgets',
            provider: 'github',
          }
        },
      },
      pullRequests: {
        status: () => {
          calls.push(['status'])
          return { available: true, login: 'octo-dev', version: '2.101.0' }
        },
        list: (input: unknown) => {
          calls.push(['list', input])
          return { items: [], total: 0 }
        },
        view: (input: unknown) => {
          calls.push(['view', input])
          return { repo: 'acme/widgets', number: 42 }
        },
        diff: (input: unknown) => {
          calls.push(['diff', input])
          return { diff: '', truncated: false }
        },
      },
    } as unknown as CoreApiLike)

    await expect(
      ipc.invoke(channelForCoreOperation('git.remote'), { sessionId: 's1' }),
    ).resolves.toMatchObject({ webUrl: 'https://github.com/acme/widgets' })
    await expect(
      ipc.invoke(channelForCoreOperation('pullRequests.status')),
    ).resolves.toMatchObject({ available: true })
    await expect(
      ipc.invoke(channelForCoreOperation('pullRequests.list'), {
        filter: 'mine',
        query: 'label:bug',
        limit: 20,
      }),
    ).resolves.toEqual({ items: [], total: 0 })
    await expect(
      ipc.invoke(channelForCoreOperation('pullRequests.view'), {
        repo: 'acme/widgets',
        number: 42,
      }),
    ).resolves.toMatchObject({ number: 42 })
    await expect(
      ipc.invoke(channelForCoreOperation('pullRequests.diff'), {
        repo: 'acme/widgets',
        number: 42,
      }),
    ).resolves.toEqual({ diff: '', truncated: false })
    for (const [key, payload] of [
      ['pullRequests.list', { filter: 'everyone' }],
      ['pullRequests.list', { filter: 'all', limit: 500 }],
      ['pullRequests.view', { repo: '../etc', number: 1 }],
      ['pullRequests.diff', { repo: 'acme/widgets', number: -1 }],
      ['git.remote', { sessionId: 's1', remote: 'upstream' }],
    ] as const)
      await expect(
        ipc.invoke(channelForCoreOperation(key), payload),
      ).resolves.toMatchObject({ ok: false })
    expect(calls).toEqual([
      ['remote', { sessionId: 's1' }],
      ['status'],
      ['list', { filter: 'mine', query: 'label:bug', limit: 20 }],
      ['view', { repo: 'acme/widgets', number: 42 }],
      ['diff', { repo: 'acme/widgets', number: 42 }],
    ])
  })

  it('streams raw events of watched sessions from a real host', async () => {
    const root = mkdtempSync(join(tmpdir(), 'emperor-core-host-'))
    const sessionEventBridge = new SessionEventBridge()
    const renderer = new FakeWebContents()
    sessionEventBridge.attach(renderer)
    const coreApi = await createCoreHost({
      root,
      ipcMain: new FakeIpcMain(),
      sessionEventBridge,
      coreOptions: {
        stateRoot: join(root, 'home'),
        stateRootSource: 'explicit',
        emperorHomePrepared: false,
        initializeMcp: false,
      },
    })
    try {
      const watched = String(coreApi.sessions.create({ title: 'a' }).id)
      const other = String(coreApi.sessions.create({ title: 'b' }).id)
      expect(coreApi.sessions.watch({ sessionIds: [watched] })).toEqual({
        watching: [watched],
      })
      for (const id of [watched, other])
        coreApi.host.agentFor(id).session.append('todo/write', { todos: [] })
      sessionEventBridge.flush()
      const batches = renderer.sent.filter(
        ([channel]) => channel === SESSION_EVENT_CHANNEL,
      )
      expect(batches.length).toBeGreaterThan(0)
      expect(
        batches.every(
          ([, batch]) => (batch as { sessionId: string }).sessionId === watched,
        ),
      ).toBe(true)
      expect(JSON.stringify(batches)).toContain('todo/write')
    } finally {
      sessionEventBridge.dispose()
      await coreApi.close()
    }
  })

  it('returns the standard safe error envelope for Goal operation failures', async () => {
    const ipc = new FakeIpcMain()
    registerCoreHostIpc(ipc, {
      goals: {
        get: async () => {
          throw {
            toSafe: () => ({
              code: 'goal_not_found',
              message: 'Goal does not exist.',
            }),
          }
        },
      },
    } as unknown as CoreApiLike)

    await expect(
      ipc.invoke(channelForCoreOperation('goals.get'), 'goal_missing'),
    ).resolves.toEqual({
      ok: false,
      error: { code: 'goal_not_found', message: 'Goal does not exist.' },
    })
  })
})

type Handler = (_event: unknown, ...args: unknown[]) => unknown

class FakeIpcMain {
  private readonly handlers = new Map<string, Handler>()

  handle(channel: string, handler: Handler): void {
    this.handlers.set(channel, handler)
  }

  channels(): string[] {
    return [...this.handlers.keys()].sort()
  }

  async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    const handler = this.handlers.get(channel)
    if (!handler) throw new Error(`missing handler: ${channel}`)
    return await handler({}, ...args)
  }
}

class FakeWebContents {
  readonly sent: Array<[string, unknown]> = []
  send(channel: string, payload: unknown): void {
    this.sent.push([channel, payload])
  }
}
