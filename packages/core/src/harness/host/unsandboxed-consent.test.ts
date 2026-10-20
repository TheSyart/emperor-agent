// SEC-08 test 5 in the host: when the process sandbox is unavailable, a
// user's MCP server is not started unconfined behind the user's back. The
// next step of a conversation asks once on the ordinary approval card; the
// answer is remembered for that server and its tools appear in that step.
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LlmClient } from '../../llm/client'
import { ContainmentBackend } from '../../sandbox/policy'
import type { SandboxBackend } from '../sandbox/backend'
import { ScriptedAdapter, testRoute } from '../testing'
import { HarnessHost } from './host'

const hosts: HarnessHost[] = []
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close()
})

const passthroughBackend: SandboxBackend = {
  confine: (argv) => ({
    argv: [...argv],
    enforcement: 'full',
    denialSignatures: ['operation not permitted'],
    runnerFailureRules: [],
  }),
}

const SERVER = `
const readline = require('node:readline')
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n')
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line)
  if (m.id === undefined) return
  const reply = (result) => send({ jsonrpc: '2.0', id: m.id, result })
  if (m.method === 'initialize') return reply({ protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'notes', version: '1' } })
  if (m.method === 'tools/list') return reply({ tools: [{ name: 'lookup', description: 'Look up a note.', inputSchema: { type: 'object' } }] })
  reply({})
})
`

async function waitFor(check: () => boolean, timeoutMs = 10_000) {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function makeHost(root: string, adapter: ScriptedAdapter) {
  const events: Array<Record<string, unknown>> = []
  const llm = new LlmClient({ adapterFor: () => adapter })
  llm.setRoutes([testRoute()], 'test-route')
  const host = await HarnessHost.create({
    root,
    stateRoot: join(root, 'home'),
    stateRootSource: 'explicit',
    emperorHomePrepared: false,
    llm,
    sandboxBackend: passthroughBackend,
    containmentBackend: new ContainmentBackend({
      platform: 'darwin',
      probe: () => ({ ok: false, detail: 'mock: no sandbox on this host' }),
    }),
    eventSink: (event) => {
      events.push(event as Record<string, unknown>)
    },
    watchSkills: false,
  })
  hosts.push(host)
  return { host, events }
}

describe('a user MCP server outside an unavailable sandbox (SEC-08 test 5)', () => {
  it('asks once on the approval card, records user-allowed-unsandboxed and remembers it', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'sec08-consent-')))
    const home = join(root, 'home')
    const script = join(root, 'server.js')
    writeFileSync(script, SERVER)
    const { mkdirSync } = await import('node:fs')
    mkdirSync(home, { recursive: true })
    writeFileSync(
      join(home, 'mcp_config.json'),
      JSON.stringify({
        servers: {
          notes: {
            enabled: true,
            transport: 'stdio',
            command: process.execPath,
            args: [script],
          },
        },
      }),
    )
    const adapter = new ScriptedAdapter([{ text: 'done' }])
    const { host, events } = await makeHost(root, adapter)
    // Servers connect in the background (KRN-04): let the first load land.
    await host.kept.mcpClient.settled()
    expect(host.kept.mcpClient.getTools()).toEqual([])

    const entry = host.kept.sessionStore.create('t', { mode: 'chat' })
    const submitted = host.submit({ sessionId: entry.id, content: 'hi' })
    await waitFor(() => events.some((event) => event.event === 'ask_request'))
    const ask = events.find((event) => event.event === 'ask_request')!
      .interaction as { id: string; context: string }
    expect(ask.context).toContain('notes')
    expect(ask.context).toContain('mock: no sandbox on this host')
    host.answerInteraction(ask.id, {
      permission: { option_id: 'allow_once', choice: '允许本次', freeform: '' },
    })
    await submitted

    // The step that asked already lists the server's tool.
    const tools = (adapter.requests[0]?.tools ?? []).map((tool) => tool.name)
    expect(tools).toContain('mcp_notes_lookup')
    const receipts = JSON.parse(
      readFileSync(join(home, 'processes', 'receipts.v1.json'), 'utf8'),
    ) as Array<{ owner: { id: string }; containment: { decision: string } }>
    expect(
      receipts.filter((item) => item.owner.id === 'notes').at(-1)?.containment
        .decision,
    ).toBe('user-allowed-unsandboxed')

    // Restarted, the answer is remembered: no card, the server is up.
    await host.close()
    hosts.splice(hosts.indexOf(host), 1)
    const second = await makeHost(root, new ScriptedAdapter([{ text: 'ok' }]))
    await second.host.kept.mcpClient.settled()
    expect(
      second.host.kept.mcpClient.getTools().map((tool) => tool.name),
    ).toEqual(['mcp_notes_lookup'])
    const again = second.host.kept.sessionStore.create('t2', { mode: 'chat' })
    await second.host.submit({ sessionId: again.id, content: 'hi' })
    expect(second.events.some((event) => event.event === 'ask_request')).toBe(
      false,
    )
  })
})
