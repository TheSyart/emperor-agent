import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  PROTOCOL_VERSION,
  client,
  methods,
  type ClientConnection,
  type SessionNotification,
} from '@agentclientprotocol/sdk'
import { describe, expect, it } from 'vitest'
import {
  EmperorAcpAdapter,
  type EmperorAcpCore,
  type EmperorAcpSession,
} from './adapter'

describe('Emperor ACP adapter', () => {
  it('advertises only the implemented stable capabilities', async () => {
    const harness = connect(new FakeCore())
    const initialized = await initialize(harness.connection)

    expect(initialized).toEqual({
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: {
          image: false,
          audio: false,
          embeddedContext: false,
        },
      },
      agentInfo: { name: 'emperor-agent', version: '0.0.0-test' },
      _meta: {
        emperor: {
          transport: 'stdio',
          runtime: 'core-api',
          content: 'text-only',
        },
      },
    })
    harness.connection.close()
  })

  it('creates a canonical Build session and rejects injected roots, MCP and content', async () => {
    const core = new FakeCore()
    const harness = connect(core)
    await initialize(harness.connection)
    const cwd = tempWorkspace()

    const created = await harness.connection.agent.request(
      methods.agent.session.new,
      { cwd, mcpServers: [] },
    )
    expect(core.sessionsCreated).toEqual([
      {
        title: 'ACP session',
        mode: 'build',
        project_path: realpathSync(cwd),
      },
    ])
    expect(created.sessionId).toBe('session-1')

    await expect(
      harness.connection.agent.request(methods.agent.session.new, {
        cwd,
        additionalDirectories: [tempWorkspace()],
        mcpServers: [],
      }),
    ).rejects.toThrow('additionalDirectories')
    await expect(
      harness.connection.agent.request(methods.agent.session.new, {
        cwd,
        mcpServers: [
          { name: 'untrusted', command: '/bin/echo', args: [], env: [] },
        ],
      }),
    ).rejects.toThrow('mcpServers')
    await expect(
      harness.connection.agent.request(methods.agent.session.prompt, {
        sessionId: created.sessionId,
        prompt: [
          {
            type: 'resource',
            resource: { uri: 'file:///etc/passwd', text: 'no' },
          },
        ],
      }),
    ).rejects.toThrow('text content')
    expect(core.submitCalls).toHaveLength(0)
    harness.connection.close()
  })

  it('replays persisted Core events in order before session/load responds', async () => {
    const cwd = tempWorkspace()
    const core = new FakeCore([
      session('persisted', cwd),
    ])
    core.replayEvents = [
      { event: 'user_message', seq: 1, turn_id: 'old', content: 'question' },
      { event: 'message_delta', seq: 2, turn_id: 'old', delta: 'answer' },
      { event: 'assistant_done', seq: 3, turn_id: 'old', content: 'answer' },
      { event: 'model_attempt_started', seq: 4, request_id: 'private' },
    ]
    const harness = connect(core)
    await initialize(harness.connection)
    const ordering: string[] = []
    harness.onUpdate = (update) => {
      ordering.push(update.update.sessionUpdate)
    }

    const loaded = await harness.connection.agent.request(
      methods.agent.session.load,
      { sessionId: 'persisted', cwd, mcpServers: [] },
    )
    ordering.push('response')

    expect(ordering).toEqual([
      'user_message_chunk',
      'agent_message_chunk',
      'response',
    ])
    expect(loaded).toMatchObject({
      _meta: { emperor: { latestSeq: 4, replayedUpdates: 2 } },
    })
    expect(core.replayCalls).toEqual([
      expect.objectContaining({
        sessionId: 'persisted',
        format: 'projection',
        compact: false,
      }),
    ])
    harness.connection.close()
  })

  it('streams ordered updates before the terminal response through the same Core submit', async () => {
    const cwd = tempWorkspace()
    const core = new FakeCore([session('s1', cwd)])
    core.submitBehavior = async (input) => {
      await input.emit?.({
        event: 'message_delta',
        seq: 1,
        event_id: 'evt-1',
        delta: 'pong',
      })
      await input.emit?.({ event: 'assistant_done', content: 'pong' })
      return { turnId: input.turnId!, content: 'pong', activeSessionId: 's1' }
    }
    const harness = connect(core)
    await initialize(harness.connection)
    const ordering: string[] = []
    harness.onUpdate = (update) => {
      ordering.push(
        update.update.sessionUpdate === 'agent_message_chunk'
          ? `chunk:${update.update.content.type === 'text' ? update.update.content.text : ''}`
          : update.update.sessionUpdate,
      )
    }

    const result = await harness.connection.agent.request(
      methods.agent.session.prompt,
      {
        sessionId: 's1',
        prompt: [{ type: 'text', text: 'ping' }],
      },
    )
    ordering.push(`response:${result.stopReason}`)

    expect(ordering).toEqual(['chunk:pong', 'response:end_turn'])
    expect(core.submitCalls).toMatchObject([
      {
        content: 'ping',
        sessionId: 's1',
        source: 'acp',
        signal: expect.any(AbortSignal),
      },
    ])
    harness.connection.close()
  })

  it('maps a Core interaction pause to a refusal even when submit settles normally', async () => {
    const cwd = tempWorkspace()
    const core = new FakeCore([session('paused', cwd)])
    core.submitBehavior = async (input) => {
      await input.emit?.({
        event: 'turn_paused',
        interaction: { id: 'ask-1', kind: 'ask' },
      })
      return {
        turnId: input.turnId!,
        content: '',
        activeSessionId: 'paused',
      }
    }
    const harness = connect(core)
    await initialize(harness.connection)

    await expect(
      harness.connection.agent.request(methods.agent.session.prompt, {
        sessionId: 'paused',
        prompt: [{ type: 'text', text: 'needs approval' }],
      }),
    ).resolves.toMatchObject({
      stopReason: 'refusal',
      _meta: {
        emperor: {
          interactionRequired: true,
          interactionId: 'ask-1',
        },
      },
    })
    harness.connection.close()
  })

  it('rejects same-session overlap, permits cross-session overlap and reconciles session cancel', async () => {
    const cwdA = tempWorkspace()
    const cwdB = tempWorkspace()
    const core = new FakeCore([session('a', cwdA), session('b', cwdB)])
    const entered: string[] = []
    core.submitBehavior = async (input) => {
      entered.push(input.sessionId)
      await new Promise<void>((resolve) => {
        input.signal.addEventListener('abort', () => resolve(), { once: true })
      })
      throw input.signal.reason
    }
    const harness = connect(core)
    await initialize(harness.connection)

    const promptA = harness.connection.agent.request(
      methods.agent.session.prompt,
      { sessionId: 'a', prompt: [{ type: 'text', text: 'one' }] },
    )
    await waitFor(() => entered.includes('a'))
    await expect(
      harness.connection.agent.request(methods.agent.session.prompt, {
        sessionId: 'a',
        prompt: [{ type: 'text', text: 'overlap' }],
      }),
    ).rejects.toThrow('active prompt')

    const promptB = harness.connection.agent.request(
      methods.agent.session.prompt,
      { sessionId: 'b', prompt: [{ type: 'text', text: 'parallel' }] },
    )
    await waitFor(() => entered.includes('b'))
    await harness.connection.agent.notify(methods.agent.session.cancel, {
      sessionId: 'a',
    })
    await expect(promptA).resolves.toMatchObject({ stopReason: 'cancelled' })
    expect(core.submitCalls.find((item) => item.sessionId === 'a')?.signal.aborted).toBe(
      true,
    )

    await harness.connection.agent.notify(methods.agent.session.cancel, {
      sessionId: 'b',
    })
    await expect(promptB).resolves.toMatchObject({ stopReason: 'cancelled' })
    harness.connection.close()
  })

  it('maps protocol request cancellation and connection close to the Core signal', async () => {
    const cwd = tempWorkspace()
    const core = new FakeCore([session('s', cwd)])
    core.submitBehavior = async (input) => {
      await new Promise<void>((resolve) => {
        input.signal.addEventListener('abort', () => resolve(), { once: true })
      })
      throw input.signal.reason
    }
    const harness = connect(core)
    await initialize(harness.connection)
    const cancel = new AbortController()
    const prompt = harness.connection.agent.request(
      methods.agent.session.prompt,
      { sessionId: 's', prompt: [{ type: 'text', text: 'cancel me' }] },
      { cancellationSignal: cancel.signal },
    )
    await waitFor(() => core.submitCalls.length === 1)
    cancel.abort()
    await expect(prompt).resolves.toMatchObject({ stopReason: 'cancelled' })

    const closing = harness.connection.agent.request(
      methods.agent.session.prompt,
      { sessionId: 's', prompt: [{ type: 'text', text: 'close me' }] },
    )
    await waitFor(() => core.submitCalls.length === 2)
    harness.connection.close(new Error('client EOF'))
    await expect(closing).rejects.toThrow('client EOF')
    await harness.adapter.settle()
    expect(core.submitCalls[1]?.signal.aborted).toBe(true)
  })
})

interface SubmitInput {
  content: string
  sessionId: string
  turnId?: string
  source: string
  signal: AbortSignal
  emit?: (event: Record<string, unknown>) => void | Promise<void>
}

class FakeCore implements EmperorAcpCore {
  readonly root = '/runtime'
  readonly sessionRows: EmperorAcpSession[]
  readonly sessionsCreated: Array<Record<string, unknown>> = []
  readonly submitCalls: SubmitInput[] = []
  readonly replayCalls: Array<Record<string, unknown>> = []
  replayEvents: Array<Record<string, unknown>> = []
  submitBehavior: (input: SubmitInput) => Promise<{
    turnId: string
    content: string
    activeSessionId: string | null
  }> = async (input) => ({
    turnId: input.turnId!,
    content: '',
    activeSessionId: input.sessionId,
  })

  constructor(rows: EmperorAcpSession[] = []) {
    this.sessionRows = [...rows]
  }

  readonly sessions = {
    list: (_opts: { includeArchived?: boolean } = {}) => [
      ...this.sessionRows,
    ],
    create: (input: {
      title?: string
      mode?: string
      project_path?: string | null
    }) => {
      this.sessionsCreated.push({ ...input })
      const row = session(
        `session-${this.sessionRows.length + 1}`,
        input.project_path!,
      )
      this.sessionRows.push(row)
      return row
    },
  }

  readonly runtime = {
    replay: (input: Record<string, unknown>) => {
      this.replayCalls.push({ ...input })
      return {
        sessionId: String(input.sessionId),
        afterSeq: 0,
        latestSeq: this.replayEvents.length,
        format: 'projection' as const,
        events: [...this.replayEvents],
      }
    },
  }

  readonly chat = {
    submit: async (input: SubmitInput) => {
      this.submitCalls.push(input)
      return await this.submitBehavior(input)
    },
  }
}

function session(id: string, cwd: string): EmperorAcpSession {
  return {
    id,
    mode: 'build',
    project_path: realpathSync(cwd),
    archived_at: null,
  }
}

function connect(core: FakeCore) {
  const adapter = new EmperorAcpAdapter(core, { version: '0.0.0-test' })
  let onUpdate: (update: SessionNotification) => void = () => {}
  const clientApp = client({ name: 'emperor-acp-test-client' }).onNotification(
    methods.client.session.update,
    ({ params }) => onUpdate(params),
  )
  const connection = clientApp.connect(adapter.agentApp)
  return {
    adapter,
    connection,
    set onUpdate(value: (update: SessionNotification) => void) {
      onUpdate = value
    },
  }
}

async function initialize(connection: ClientConnection) {
  return await connection.agent.request(methods.agent.initialize, {
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: {
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
    },
  })
}

function tempWorkspace(): string {
  return mkdtempSync(join(tmpdir(), 'emperor-acp-workspace-'))
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition timed out')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
