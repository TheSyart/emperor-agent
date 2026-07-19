import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type {
  ProcessContainmentController,
  ProcessContainmentPolicy,
} from '../environment/sandbox'
import { OwnedProcessRuntime } from '../processes/runtime'
import { LspSupervisor } from './lsp-supervisor'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

describe('LspSupervisor OwnedProcess integration', () => {
  it('runs a real framed stdio server through the shared owner and shuts it down', async () => {
    const root = await mkdtemp(join(tmpdir(), 'emperor-real-lsp-'))
    roots.push(root)
    const workspaceRoot = join(root, 'workspace')
    const filePath = join(workspaceRoot, 'src', 'a.ts')
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, 'export const alpha = 1\n')
    const policies: ProcessContainmentPolicy[] = []
    const runtime = new OwnedProcessRuntime(root, {
      sandbox: passThroughSandbox(policies),
    })
    const supervisor = new LspSupervisor({
      processRuntime: runtime,
      stateRoot: root,
      descriptors: [
        {
          id: 'fixture-lsp',
          source: { kind: 'system', identity: 'vitest-node-fixture' },
          executable: process.execPath,
          args: ['-e', serverScript()],
          extensions: ['.ts'],
          languageId: 'typescript',
        },
      ],
    })

    await supervisor.syncDocument({
      workspaceRoot,
      sessionId: 'session-real',
      filePath,
      text: 'export const alpha = 1\n',
      version: 1,
    })
    await expect(
      supervisor.request({
        workspaceRoot,
        sessionId: 'session-real',
        filePath,
        method: 'textDocument/hover',
        params: {},
      }),
    ).resolves.toEqual({ contents: 'fixture-hover' })

    expect(runtime.list({ activeOnly: true })).toEqual([
      expect.objectContaining({
        owner: {
          kind: 'lsp',
          id: expect.stringMatching(/^[a-f0-9]{64}:1$/),
          sessionId: 'session-real',
        },
        outputQuota: {
          maxBytes: 8 * 1024 * 1024,
          strategy: 'truncate_tail',
          scope: 'combined',
          observedBytes: expect.any(Number),
          capturedBytes: expect.any(Number),
          exceeded: false,
        },
      }),
    ])
    expect(policies).toEqual([
      expect.objectContaining({
        mode: 'required',
        network: 'deny',
        readOnlyRoots: [expect.stringContaining('/workspace')],
      }),
    ])

    await supervisor.close()
    expect(runtime.list({ activeOnly: true })).toEqual([])
    expect(runtime.list()[0]).toMatchObject({
      owner: { kind: 'lsp', sessionId: 'session-real' },
      status: 'completed',
      exitCode: 0,
    })
  })
})

function passThroughSandbox(
  policies: ProcessContainmentPolicy[],
): ProcessContainmentController {
  return {
    capability: () => ({
      platform: process.platform,
      backend: 'none',
      status: 'available',
      filesystem: 'workspace-write',
      network: 'policy-controlled',
      processTree: true,
      reason: 'test fixture',
    }),
    prepare: (executable, args, policy) => {
      policies.push(structuredClone(policy))
      return {
        executable,
        args: [...args],
        receipt: {
          decision: 'sandboxed',
          backend: 'none',
          capabilityStatus: 'available',
          filesystem: 'workspace-write',
          network: 'denied',
          processTree: true,
          policyHash: 'fixture-policy',
          reason: '',
        },
      }
    },
  }
}

function serverScript(): string {
  return String.raw`
let buffered = Buffer.alloc(0)
const send = (message) => {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  process.stdout.write(Buffer.concat([
    Buffer.from('Content-Length: ' + body.length + '\r\n\r\n', 'ascii'),
    body,
  ]))
}
const drain = () => {
  while (true) {
    const end = buffered.indexOf('\r\n\r\n')
    if (end < 0) return
    const match = /Content-Length:\s*([0-9]+)/i.exec(buffered.subarray(0, end).toString('ascii'))
    if (!match) process.exit(2)
    const bytes = Number(match[1])
    if (buffered.length < end + 4 + bytes) return
    const body = buffered.subarray(end + 4, end + 4 + bytes)
    buffered = buffered.subarray(end + 4 + bytes)
    const message = JSON.parse(body.toString('utf8'))
    if (message.method === 'initialize') send({ jsonrpc: '2.0', id: message.id, result: { capabilities: {} } })
    else if (message.method === 'textDocument/hover') send({ jsonrpc: '2.0', id: message.id, result: { contents: 'fixture-hover' } })
    else if (message.method === 'shutdown') send({ jsonrpc: '2.0', id: message.id, result: null })
    else if (message.method === 'exit') process.exit(0)
  }
}
process.stdin.on('data', (chunk) => {
  buffered = Buffer.concat([buffered, chunk])
  drain()
})
`
}
