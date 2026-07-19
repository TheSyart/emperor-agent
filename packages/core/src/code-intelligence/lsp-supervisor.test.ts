import { PassThrough } from 'node:stream'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type {
  ManagedOwnedProcessRequest,
  OwnedProcessHandle,
  OwnedProcessReceipt,
} from '../processes/runtime'
import type { OwnedProcessResult } from '../environment/process-runner'
import { LspContentLengthDecoder, encodeLspMessage } from './lsp-protocol'
import {
  LspSupervisor,
  type TrustedLspServerDescriptor,
} from './lsp-supervisor'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

async function fixture(): Promise<{
  workspaceRoot: string
  stateRoot: string
  filePath: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'emperor-lsp-'))
  roots.push(root)
  const workspaceRoot = join(root, 'workspace')
  const stateRoot = join(root, 'state')
  const filePath = join(workspaceRoot, 'src', 'a.ts')
  await mkdir(dirname(filePath), { recursive: true })
  await mkdir(stateRoot, { recursive: true })
  await writeFile(filePath, 'export const alpha = 1\n')
  return { workspaceRoot, stateRoot, filePath }
}

function descriptor(
  overrides: Partial<TrustedLspServerDescriptor> = {},
): TrustedLspServerDescriptor {
  return {
    id: 'typescript-language-server',
    source: { kind: 'managed', identity: 'emperor-tool-catalog:lsp-v1' },
    executable: '/trusted/typescript-language-server',
    args: ['--stdio'],
    extensions: ['.ts', '.tsx'],
    languageId: 'typescript',
    maxRestarts: 3,
    ...overrides,
  }
}

describe('LspSupervisor trust and lifecycle', () => {
  it('rejects project/raw and unverified plugin descriptors at the composition boundary', () => {
    const runtime = new FakeOwnedProcessRuntime()
    expect(
      () =>
        new LspSupervisor({
          processRuntime: runtime,
          stateRoot: '/state',
          descriptors: [
            {
              ...descriptor(),
              source: { kind: 'project', identity: 'repo config' },
            } as unknown as TrustedLspServerDescriptor,
          ],
        }),
    ).toThrow(/trusted/i)
    expect(
      () =>
        new LspSupervisor({
          processRuntime: runtime,
          stateRoot: '/state',
          descriptors: [
            {
              ...descriptor(),
              source: { kind: 'verified_plugin', identity: 'plugin-a' },
            } as unknown as TrustedLspServerDescriptor,
          ],
        }),
    ).toThrow(/verification/i)
    expect(
      () =>
        new LspSupervisor({
          processRuntime: runtime,
          stateRoot: '/state',
          descriptors: [
            descriptor(),
            descriptor({ id: 'other-server', executable: '/trusted/other' }),
          ],
        }),
    ).toThrow(/extension collision/i)
  })

  it('starts lazily, singleflights initialization and uses owned read-only/network-denied containment', async () => {
    const { workspaceRoot, stateRoot, filePath } = await fixture()
    const runtime = new FakeOwnedProcessRuntime()
    const supervisor = new LspSupervisor({
      processRuntime: runtime,
      stateRoot,
      descriptors: [descriptor()],
    })
    expect(runtime.requests).toHaveLength(0)

    const input = {
      workspaceRoot,
      sessionId: 'session-a',
      filePath,
      method: 'textDocument/hover',
      params: { textDocument: { uri: 'file:///a.ts' } },
    }
    await Promise.all([
      supervisor.request(input),
      supervisor.request({ ...input, method: 'textDocument/documentSymbol' }),
    ])

    expect(runtime.requests).toHaveLength(1)
    expect(runtime.requests[0]).toMatchObject({
      executable: '/trusted/typescript-language-server',
      args: ['--stdio'],
      owner: { kind: 'lsp', sessionId: 'session-a' },
      containment: {
        mode: 'required',
        network: 'deny',
        readOnlyRoots: [await realpath(workspaceRoot)],
      },
    })
    expect(runtime.requests[0]!.containment.workspaceRoot).not.toBe(
      await realpath(workspaceRoot),
    )
    expect(runtime.children[0]!.clientMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ method: 'initialize' }),
        expect.objectContaining({ method: 'initialized' }),
      ]),
    )
    expect(supervisor.diagnostics()).toEqual([
      expect.objectContaining({ state: 'ready', starts: 1, restarts: 0 }),
    ])
  })

  it('opens documents once, publishes full changes and rejects workspace escapes', async () => {
    const { workspaceRoot, stateRoot, filePath } = await fixture()
    const runtime = new FakeOwnedProcessRuntime()
    const supervisor = new LspSupervisor({
      processRuntime: runtime,
      stateRoot,
      descriptors: [descriptor()],
    })

    await supervisor.syncDocument({
      workspaceRoot,
      sessionId: 'session-a',
      filePath,
      text: 'export const alpha = 1\n',
      version: 1,
    })
    await supervisor.syncDocument({
      workspaceRoot,
      sessionId: 'session-a',
      filePath,
      text: 'export const alpha = 2\n',
      version: 2,
    })
    await expect(
      supervisor.syncDocument({
        workspaceRoot,
        sessionId: 'session-a',
        filePath,
        text: 'export const alpha = 3\n',
        version: 2,
      }),
    ).rejects.toThrow(/monotonically/i)
    await supervisor.syncDocument({
      workspaceRoot,
      sessionId: 'session-a',
      filePath,
      text: 'export const alpha = 2\n',
      version: 2,
    })
    await expect(
      supervisor.syncDocument({
        workspaceRoot,
        sessionId: 'session-a',
        filePath: join(workspaceRoot, '..', 'outside.ts'),
        text: '',
        version: 1,
      }),
    ).rejects.toThrow(/outside/i)

    const methods = runtime.children[0]!.clientMessages.map(
      (message) => message.method,
    )
    expect(
      methods.filter((method) => method === 'textDocument/didOpen'),
    ).toHaveLength(1)
    expect(
      methods.filter((method) => method === 'textDocument/didChange'),
    ).toHaveLength(1)
  })

  it('rejects oversized source before parser sync or process start', async () => {
    const { workspaceRoot, stateRoot, filePath } = await fixture()
    await writeFile(filePath, Buffer.alloc(5 * 1024 * 1024 + 1, 'x'))
    const runtime = new FakeOwnedProcessRuntime()
    const supervisor = new LspSupervisor({
      processRuntime: runtime,
      stateRoot,
      descriptors: [descriptor()],
    })

    await expect(
      supervisor.syncDocument({
        workspaceRoot,
        sessionId: 'session-a',
        filePath,
        text: 'small unsaved buffer',
        version: 1,
      }),
    ).rejects.toThrow(/5 MiB/i)
    expect(runtime.requests).toEqual([])
  })

  it('cancels and times out requests exactly once while notifying the server', async () => {
    const { workspaceRoot, stateRoot, filePath } = await fixture()
    const runtime = new FakeOwnedProcessRuntime({ holdMethod: 'held/request' })
    const supervisor = new LspSupervisor({
      processRuntime: runtime,
      stateRoot,
      descriptors: [descriptor()],
    })
    const controller = new AbortController()
    const cancelled = supervisor.request({
      workspaceRoot,
      sessionId: 'session-a',
      filePath,
      method: 'held/request',
      params: {},
      signal: controller.signal,
    })
    await waitFor(() => runtime.children[0]?.heldRequestId != null)
    controller.abort('user cancelled')
    await expect(cancelled).rejects.toThrow(/cancel/i)
    controller.abort('again')

    await expect(
      supervisor.request({
        workspaceRoot,
        sessionId: 'session-a',
        filePath,
        method: 'held/request',
        params: {},
        timeoutMs: 20,
      }),
    ).rejects.toThrow(/timed out/i)
    expect(
      runtime.children[0]!.clientMessages.filter(
        (message) => message.method === '$/cancelRequest',
      ),
    ).toHaveLength(2)
    expect(supervisor.diagnostics()[0]).toMatchObject({ pendingRequests: 0 })
  })

  it('fences stale generations, restarts at most three times and stops the session owner', async () => {
    const { workspaceRoot, stateRoot, filePath } = await fixture()
    const runtime = new FakeOwnedProcessRuntime({ holdMethod: 'held/request' })
    const supervisor = new LspSupervisor({
      processRuntime: runtime,
      stateRoot,
      descriptors: [descriptor({ maxRestarts: 3 })],
    })
    const base = { workspaceRoot, sessionId: 'session-a', filePath, params: {} }

    for (let generation = 0; generation < 4; generation += 1) {
      const pending = supervisor.request({
        ...base,
        method: generation === 0 ? 'held/request' : 'textDocument/hover',
      })
      if (generation === 0) {
        await waitFor(() => runtime.children[0]?.heldRequestId != null)
        const staleId = runtime.children[0]!.heldRequestId!
        runtime.children[0]!.crash()
        await expect(pending).rejects.toThrow(/exited/i)
        runtime.children[0]!.send({
          jsonrpc: '2.0',
          id: staleId,
          result: 'stale',
        })
      } else {
        await expect(pending).resolves.toEqual({ ok: true })
        runtime.children[generation]!.crash()
      }
    }

    await expect(
      supervisor.request({ ...base, method: 'textDocument/hover' }),
    ).rejects.toThrow(/restart limit/i)
    expect(runtime.requests).toHaveLength(4)
    expect(supervisor.diagnostics()[0]).toMatchObject({
      state: 'failed',
      starts: 4,
      restarts: 3,
    })

    await supervisor.stopSession('session-a')
    expect(supervisor.diagnostics()).toEqual([])
  })

  it('terminates the owned process on malformed or oversized server frames', async () => {
    const { workspaceRoot, stateRoot, filePath } = await fixture()
    const runtime = new FakeOwnedProcessRuntime({ holdMethod: 'held/request' })
    const supervisor = new LspSupervisor({
      processRuntime: runtime,
      stateRoot,
      descriptors: [descriptor()],
    })
    const pending = supervisor.request({
      workspaceRoot,
      sessionId: 'session-a',
      filePath,
      method: 'held/request',
      params: {},
    })
    await waitFor(() => runtime.children[0]?.heldRequestId != null)
    runtime.children[0]!.stdout.write(Buffer.from('X'.repeat(8_193)))

    await expect(pending).rejects.toThrow(/protocol/i)
    expect(runtime.children[0]!.cancelReasons).toEqual([
      'LSP protocol violation',
    ])
  })
})

type RpcMessage = Record<string, unknown> & {
  id?: string | number
  method?: string
  params?: unknown
}

class FakeOwnedProcessRuntime {
  readonly requests: ManagedOwnedProcessRequest[] = []
  readonly children: FakeLspChild[] = []
  constructor(private readonly opts: { holdMethod?: string } = {}) {}

  async spawn(
    request: ManagedOwnedProcessRequest,
  ): Promise<OwnedProcessHandle> {
    this.requests.push(request)
    const child = new FakeLspChild(this.opts)
    this.children.push(child)
    return child
  }
}

class FakeLspChild implements OwnedProcessHandle {
  readonly processId = 'process-lsp'
  readonly leaseId = 'lease-lsp'
  readonly pid = 101
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly clientMessages: RpcMessage[] = []
  readonly cancelReasons: string[] = []
  heldRequestId: string | number | null = null
  private readonly decoder = new LspContentLengthDecoder()
  private resolveSettled!: (result: OwnedProcessResult) => void
  readonly settled = new Promise<OwnedProcessResult>((resolve) => {
    this.resolveSettled = resolve
  })

  constructor(private readonly opts: { holdMethod?: string }) {
    this.stdin.on('data', (chunk: Buffer) => {
      for (const raw of this.decoder.append(chunk)) {
        const message = raw as RpcMessage
        this.clientMessages.push(message)
        if (message.method === 'initialize' && message.id !== undefined) {
          this.send({
            jsonrpc: '2.0',
            id: message.id,
            result: { capabilities: {} },
          })
        } else if (
          message.id !== undefined &&
          message.method !== this.opts.holdMethod &&
          message.method !== 'shutdown'
        ) {
          this.send({ jsonrpc: '2.0', id: message.id, result: { ok: true } })
        } else if (message.method === this.opts.holdMethod) {
          this.heldRequestId = message.id ?? null
        } else if (message.method === 'shutdown' && message.id !== undefined) {
          this.send({ jsonrpc: '2.0', id: message.id, result: null })
        }
      }
    })
  }

  receipt(): OwnedProcessReceipt {
    return {} as OwnedProcessReceipt
  }

  cancel(reason = 'cancelled'): void {
    this.cancelReasons.push(reason)
    this.finish('cancelled')
  }

  crash(): void {
    this.finish('completed')
  }

  send(message: RpcMessage): void {
    this.stdout.write(encodeLspMessage(message))
  }

  private finish(status: OwnedProcessResult['status']): void {
    this.resolveSettled({
      status,
      exitCode: status === 'completed' ? 1 : null,
      stdout: '',
      stderr: '',
      durationMs: 1,
      error: null,
      containment: {} as OwnedProcessResult['containment'],
    })
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not reached')
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}
