import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import {
  EmperorAcpAdapter,
  type EmperorAcpCore,
  type EmperorAcpSession,
  type EmperorAcpSubmitInput,
} from './adapter'
import { createBoundedNodeAcpStream } from './node-transport'

describe('Emperor ACP raw wire semantics', () => {
  it('deduplicates exact request ids and rejects conflicting reuse without a second effect', async () => {
    const core = new WireFakeCore()
    const adapter = new EmperorAcpAdapter(core, { version: 'wire-test' })
    const input = new PassThrough()
    const output = new PassThrough()
    const wire = new WireReader(output)
    const connection = adapter.agentApp.connect(
      createBoundedNodeAcpStream(input, output),
    )
    const workspace = temp('emperor-acp-wire-workspace-')

    try {
      write(input, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: 1, clientCapabilities: {} },
      })
      await wire.waitFor(1, 1)

      const newSession = {
        jsonrpc: '2.0',
        id: 2,
        method: 'session/new',
        params: { cwd: workspace, mcpServers: [] },
      }
      write(input, newSession)
      write(input, newSession)
      const newResponses = await wire.waitFor(2, 2)
      expect(core.createCalls).toBe(1)
      expect(newResponses).toHaveLength(2)
      expect(newResponses[0]?.result).toEqual(newResponses[1]?.result)

      const sessionId = String(
        (newResponses[0]?.result as { sessionId?: unknown }).sessionId,
      )
      const prompt = {
        jsonrpc: '2.0',
        id: 3,
        method: 'session/prompt',
        params: {
          sessionId,
          prompt: [{ type: 'text', text: 'once' }],
        },
      }
      write(input, prompt)
      write(input, prompt)
      const promptResponses = await wire.waitFor(3, 2)
      expect(core.submitCalls).toBe(1)
      expect(promptResponses.filter((message) => message.result)).toHaveLength(
        2,
      )

      write(input, {
        ...prompt,
        id: 4,
        params: { ...prompt.params, prompt: [{ type: 'text', text: 'first' }] },
      })
      write(input, {
        ...prompt,
        id: 4,
        params: {
          ...prompt.params,
          prompt: [{ type: 'text', text: 'conflict' }],
        },
      })
      const conflicting = await wire.waitFor(4, 2)
      expect(core.submitCalls).toBe(2)
      expect(conflicting.filter((message) => message.result)).toHaveLength(1)
      expect(conflicting.filter((message) => message.error)).toHaveLength(1)
    } finally {
      connection.close()
      input.destroy()
      output.destroy()
      await connection.closed
    }
  })
})

type WireMessage = {
  id?: string | number | null
  result?: unknown
  error?: unknown
}

class WireReader {
  private buffer = ''
  private readonly messages: WireMessage[] = []

  constructor(output: PassThrough) {
    output.setEncoding('utf8')
    output.on('data', (chunk: string) => {
      this.buffer += chunk
      for (;;) {
        const newline = this.buffer.indexOf('\n')
        if (newline < 0) return
        const line = this.buffer.slice(0, newline).trim()
        this.buffer = this.buffer.slice(newline + 1)
        if (line) this.messages.push(JSON.parse(line) as WireMessage)
      }
    })
  }

  async waitFor(id: string | number, count: number): Promise<WireMessage[]> {
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      const matching = this.messages.filter((message) => message.id === id)
      if (matching.length >= count) return matching
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    throw new Error(
      `Timed out waiting for ${count} responses to ${String(id)}: ${JSON.stringify(this.messages)}`,
    )
  }
}

class WireFakeCore implements EmperorAcpCore {
  readonly root = process.cwd()
  readonly sessionRows: EmperorAcpSession[] = []
  createCalls = 0
  submitCalls = 0

  readonly sessions = {
    list: (): EmperorAcpSession[] => [...this.sessionRows],
    create: (opts: {
      title?: string
      mode?: string
      project_path?: string | null
    }): EmperorAcpSession => {
      this.createCalls += 1
      const row = {
        id: `wire-${this.createCalls}`,
        mode: opts.mode ?? 'build',
        project_path: opts.project_path ?? null,
      }
      this.sessionRows.push(row)
      return row
    },
  }

  readonly runtime = {
    replay: () => ({ events: [], latestSeq: 0 }),
  }

  readonly chat = {
    submit: async (input: EmperorAcpSubmitInput) => {
      this.submitCalls += 1
      await new Promise((resolve) => setTimeout(resolve, 20))
      await input.emit?.({
        event: 'message_delta',
        session_id: input.sessionId,
        turn_id: input.turnId,
        delta: 'done',
      })
      await input.emit?.({
        event: 'assistant_done',
        session_id: input.sessionId,
        turn_id: input.turnId,
        content: 'done',
      })
      return {
        turnId: input.turnId ?? 'wire-turn',
        content: 'done',
        activeSessionId: input.sessionId,
      }
    },
  }
}

function write(input: PassThrough, message: Record<string, unknown>): void {
  input.write(`${JSON.stringify(message)}\n`)
}

function temp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}
