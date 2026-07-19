import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { OwnedProcessRuntime } from '../processes/runtime'
import { OwnedStdioClientTransport } from './owned-stdio-transport'

describe('OwnedStdioClientTransport', () => {
  it('routes the real MCP stdio child through the owned process runtime', async () => {
    const root = mkdtempSync(join(tmpdir(), 'emperor-owned-mcp-'))
    const runtime = new OwnedProcessRuntime(root)
    const transport = new OwnedStdioClientTransport({
      runtime,
      serverName: 'echo',
      ownerSessionId: 'session-a',
      workspaceRoot: root,
      stateRoot: root,
      command: process.execPath,
      args: [
        '-e',
        'let s="";process.stdin.on("data",c=>{s+=c;let i;while((i=s.indexOf("\\n"))>=0){const line=s.slice(0,i);s=s.slice(i+1);if(line)process.stdout.write(line+"\\n")}})',
      ],
      env: {},
    })
    const message = new Promise<Record<string, unknown>>((resolve) => {
      transport.onmessage = (value) => resolve(value as Record<string, unknown>)
    })

    await transport.start()
    await transport.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'ping',
    })

    await expect(message).resolves.toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      method: 'ping',
    })
    expect(runtime.list({ activeOnly: true })).toEqual([
      expect.objectContaining({
        owner: {
          kind: 'mcp',
          id: 'echo',
          sessionId: 'session-a',
        },
        status: 'running',
      }),
    ])

    await transport.close()
    expect(runtime.list({ activeOnly: true })).toEqual([])
    expect(runtime.list()[0]).toMatchObject({
      status: 'cancelled',
      terminalReason: 'mcp transport closed',
    })
  })
})
