/**
 * KRN-04: an MCP stdio server is a long-lived stream, not a command with an
 * output quota. stderr goes to a bounded ring (never blocks the server),
 * stdout is not captured and has no cumulative limit, and one oversized
 * message is refused without killing the process.
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { OwnedProcessRuntime } from '../processes/runtime'
import { OwnedStdioClientTransport } from './owned-stdio-transport'

/** Answers `ping` (after 1 KB of stderr) and `big` (a payload of `size` bytes). */
const SERVER = `
let pending = ''
process.stdin.on('data', (chunk) => {
  pending += chunk
  let index
  while ((index = pending.indexOf('\\n')) >= 0) {
    const line = pending.slice(0, index)
    pending = pending.slice(index + 1)
    if (!line) continue
    const message = JSON.parse(line)
    if (message.method === 'ping') {
      process.stderr.write('d'.repeat(1024) + '\\n')
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }) + '\\n')
    } else if (message.method === 'big') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { data: 'x'.repeat(message.params.size) } }) + '\\n')
    }
  }
})
`

const transports: OwnedStdioClientTransport[] = []
afterEach(async () => {
  for (const transport of transports.splice(0)) await transport.close()
})

async function start() {
  const root = mkdtempSync(join(tmpdir(), 'emperor-mcp-stream-'))
  const script = join(root, 'server.cjs')
  writeFileSync(script, SERVER)
  const runtime = new OwnedProcessRuntime(root)
  const transport = new OwnedStdioClientTransport({
    runtime,
    serverName: 'stream',
    workspaceRoot: root,
    stateRoot: root,
    command: process.execPath,
    args: [script],
    env: {},
    source: 'user',
  })
  transports.push(transport)
  const replies = new Map<number, (message: JSONRPCMessage) => void>()
  const errors: Error[] = []
  transport.onmessage = (message) => {
    const id = (message as { id?: number }).id
    if (typeof id === 'number') replies.get(id)?.(message)
  }
  transport.onerror = (error) => errors.push(error)
  await transport.start()
  let next = 1
  const call = (
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 5000,
  ): Promise<JSONRPCMessage> => {
    const id = next++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`${method} #${id} timed out`)),
        timeoutMs,
      )
      replies.set(id, (message) => {
        clearTimeout(timer)
        resolve(message)
      })
      void transport.send({ jsonrpc: '2.0', id, method, params })
    })
  }
  return { transport, runtime, call, errors }
}

describe('MCP stdio as a long-lived stream (KRN-04)', () => {
  it('1 · a server writing 1 KB of stderr per request answers 500 calls in a row', async () => {
    const { call, transport } = await start()
    for (let index = 0; index < 500; index++) await call('ping')
    // The last lines stay readable for the diagnostics page.
    expect(transport.stderrTail(3).split('\n')).toHaveLength(3)
  }, 60_000)

  it('2 · 50 MiB of output in total does not stop the server', async () => {
    const { call, runtime } = await start()
    for (let index = 0; index < 50; index++)
      await call('big', { size: 1024 * 1024 }, 10_000)
    await call('ping')
    expect(runtime.list({ activeOnly: true })).toHaveLength(1)
  }, 120_000)

  it('3 · a single 20 MiB message is refused and the server lives on', async () => {
    const { call, errors, runtime } = await start()
    await expect(call('big', { size: 20 * 1024 * 1024 }, 4000)).rejects.toThrow(
      /timed out/,
    )
    expect(
      errors.some((error) => /too large|16 MiB/i.test(error.message)),
    ).toBe(true)
    await call('ping')
    expect(runtime.list({ activeOnly: true })).toHaveLength(1)
  }, 60_000)
})
