import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  PROTOCOL_VERSION,
  client,
  methods,
  type ClientContext,
  type SessionNotification,
} from '@agentclientprotocol/sdk'
import { describe, expect, it, vi } from 'vitest'
import { CoreApi } from '../api/core-api'
import { LlmClient } from '../llm/client'
import type { SandboxBackend } from '../harness/sandbox/backend'
import {
  replyChunks,
  ScriptedAdapter,
  testRoute,
  type ScriptedReply,
} from '../harness/testing'
import { EmperorAcpAdapter } from './adapter'

/** Waits on work that runs processes, Git or the file system: room for a
 * loaded CI runner instead of the 1 s default (FIX-17). */
const LOADED = { timeout: 10_000 }

const TEMPLATES_DIR = join(__dirname, '..', '..', '..', '..', 'templates')

describe('Emperor ACP real Core E2E', () => {
  it('runs an ACP Build turn through the real CoreApi and persists replayable facts', async () => {
    const runtimeRoot = temp('emperor-acp-core-runtime-')
    const workspace = temp('emperor-acp-core-workspace-')
    const stateRoot = temp('emperor-acp-core-state-')
    const adapterLlm = new ScriptedAdapter([{ text: 'pong' }])
    const api = await createApi(runtimeRoot, stateRoot, adapterLlm)
    const adapter = new EmperorAcpAdapter(api, { version: 'test' })
    const updates: SessionNotification[] = []
    const connection = client({ name: 'core-e2e' })
      .onNotification(methods.client.session.update, ({ params }) => {
        updates.push(params)
      })
      .connect(adapter.agentApp)
    try {
      await initialize(connection.agent)
      const created = await connection.agent.request(
        methods.agent.session.new,
        { cwd: workspace, mcpServers: [] },
      )
      const response = await connection.agent.request(
        methods.agent.session.prompt,
        {
          sessionId: created.sessionId,
          prompt: [{ type: 'text', text: 'ping' }],
        },
      )

      expect(response.stopReason).toBe('end_turn')
      expect(adapterLlm.requests).toHaveLength(1)
      expect(
        updates
          .filter((item) => item.update.sessionUpdate === 'agent_message_chunk')
          .map((item) =>
            item.update.sessionUpdate === 'agent_message_chunk' &&
            item.update.content.type === 'text'
              ? item.update.content.text
              : '',
          )
          .join(''),
      ).toBe('pong')

      updates.length = 0
      await connection.agent.request(methods.agent.session.load, {
        sessionId: created.sessionId,
        cwd: workspace,
        mcpServers: [],
      })
      expect(updates.map((item) => item.update.sessionUpdate)).toContain(
        'user_message_chunk',
      )
      expect(updates.map((item) => item.update.sessionUpdate)).toContain(
        'agent_message_chunk',
      )
      const replay = api.runtime.replay({ sessionId: created.sessionId })
      expect(replay.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ event: 'user_message', source: 'acp' }),
          expect.objectContaining({ event: 'assistant_done', content: 'pong' }),
        ]),
      )
    } finally {
      connection.close()
      await adapter.settle()
      await api.close()
    }
  })

  it('propagates ACP session cancellation through real Sampling/Core signals', async () => {
    const runtimeRoot = temp('emperor-acp-cancel-runtime-')
    const workspace = temp('emperor-acp-cancel-workspace-')
    const stateRoot = temp('emperor-acp-cancel-state-')
    let enter!: () => void
    const entered = new Promise<void>((resolve) => {
      enter = resolve
    })
    let aborted = false
    const hang: ScriptedReply = (request) => {
      enter()
      return new Promise((_resolve, reject) => {
        const signal = request.signal
        const stop = () => {
          aborted = true
          reject(signal?.reason)
        }
        if (signal?.aborted) stop()
        else signal?.addEventListener('abort', stop, { once: true })
      })
    }
    const api = await createApi(
      runtimeRoot,
      stateRoot,
      new ScriptedAdapter([hang]),
    )
    const adapter = new EmperorAcpAdapter(api, { version: 'test' })
    const connection = client({ name: 'cancel-e2e' }).connect(adapter.agentApp)
    try {
      await initialize(connection.agent)
      const created = await connection.agent.request(
        methods.agent.session.new,
        { cwd: workspace, mcpServers: [] },
      )
      const prompt = connection.agent.request(methods.agent.session.prompt, {
        sessionId: created.sessionId,
        prompt: [{ type: 'text', text: 'wait' }],
      })
      await entered
      await connection.agent.notify(methods.agent.session.cancel, {
        sessionId: created.sessionId,
      })

      await expect(prompt).resolves.toMatchObject({ stopReason: 'cancelled' })
      expect(aborted).toBe(true)
      await adapter.settle()
      await api.host.agentFor(created.sessionId).whenIdle()
      expect(api.host.isBusy(created.sessionId)).toBe(false)
    } finally {
      connection.close()
      await adapter.settle()
      await api.close()
    }
  })

  // KRN-02 #5 (CORE-23): the ACP cancel reaches only the ACP prompt.
  it('cancels a still-queued ACP prompt without touching the running turn', async () => {
    const runtimeRoot = temp('emperor-acp-queued-runtime-')
    const workspace = temp('emperor-acp-queued-workspace-')
    const stateRoot = temp('emperor-acp-queued-state-')
    let enter!: () => void
    const entered = new Promise<void>((resolve) => {
      enter = resolve
    })
    let runningAborted = false
    const hang: ScriptedReply = (request) => {
      enter()
      return new Promise((_resolve, reject) => {
        const signal = request.signal
        const stop = () => {
          runningAborted = true
          reject(signal?.reason)
        }
        if (signal?.aborted) stop()
        else signal?.addEventListener('abort', stop, { once: true })
      })
    }
    const scripted = new ScriptedAdapter([hang])
    const api = await createApi(runtimeRoot, stateRoot, scripted)
    const adapter = new EmperorAcpAdapter(api, { version: 'test' })
    const connection = client({ name: 'queued-cancel' }).connect(
      adapter.agentApp,
    )
    try {
      await initialize(connection.agent)
      const created = await connection.agent.request(
        methods.agent.session.new,
        { cwd: workspace, mcpServers: [] },
      )
      // The desktop runs a turn in the same session.
      const desktop = api.chat.submit({
        content: 'desktop turn',
        sessionId: created.sessionId,
      })
      await entered
      const prompt = connection.agent.request(methods.agent.session.prompt, {
        sessionId: created.sessionId,
        prompt: [{ type: 'text', text: 'acp prompt' }],
      })
      await vi.waitFor(() => {
        expect(api.host.queuedPrompts(created.sessionId)).toHaveLength(1)
      }, LOADED)
      await connection.agent.notify(methods.agent.session.cancel, {
        sessionId: created.sessionId,
      })

      await expect(prompt).resolves.toMatchObject({ stopReason: 'cancelled' })
      expect(api.host.queuedPrompts(created.sessionId)).toEqual([])
      const agent = api.host.agentFor(created.sessionId)
      expect(agent.session.lastOf('agent/inbox/discarded')?.data).toMatchObject(
        { reason: 'cancelled' },
      )
      // The running desktop turn never saw the cancel.
      expect(runningAborted).toBe(false)
      expect(api.host.isBusy(created.sessionId)).toBe(true)
      expect(scripted.requests).toHaveLength(1)

      api.host.stop(created.sessionId)
      await desktop
      expect(runningAborted).toBe(true)
    } finally {
      connection.close()
      await adapter.settle()
      await api.close()
    }
  })

  // KRN-02: an ACP prompt no turn took must not wait in the desktop queue.
  it('refuses an ACP prompt left behind by a failed turn and withdraws it from the queue', async () => {
    const runtimeRoot = temp('emperor-acp-held-runtime-')
    const workspace = temp('emperor-acp-held-workspace-')
    const stateRoot = temp('emperor-acp-held-state-')
    let fail!: () => void
    const failing = new Promise<void>((resolve) => {
      fail = resolve
    })
    const scripted = new ScriptedAdapter([
      async () => {
        await failing
        return replyChunks({ error: 'bad key', code: 'AUTH' })
      },
    ])
    const api = await createApi(runtimeRoot, stateRoot, scripted)
    const adapter = new EmperorAcpAdapter(api, { version: 'test' })
    const connection = client({ name: 'held-refusal' }).connect(
      adapter.agentApp,
    )
    try {
      await initialize(connection.agent)
      const created = await connection.agent.request(
        methods.agent.session.new,
        { cwd: workspace, mcpServers: [] },
      )
      const desktop = api.chat.submit({
        content: 'desktop turn',
        sessionId: created.sessionId,
      })
      await vi.waitFor(() => {
        expect(scripted.requests).toHaveLength(1)
      }, LOADED)
      const prompt = connection.agent.request(methods.agent.session.prompt, {
        sessionId: created.sessionId,
        prompt: [{ type: 'text', text: 'acp prompt' }],
      })
      await vi.waitFor(() => {
        expect(api.host.queuedPrompts(created.sessionId)).toHaveLength(1)
      }, LOADED)
      fail()
      await expect(prompt).resolves.toMatchObject({
        stopReason: 'refusal',
        _meta: { emperor: { notConsumed: 'previous-turn-failed' } },
      })
      await desktop
      expect(api.host.queuedPrompts(created.sessionId)).toEqual([])
      expect(
        api.host
          .agentFor(created.sessionId)
          .session.lastOf('agent/inbox/discarded')?.data,
      ).toMatchObject({ reason: 'cancelled' })
      expect(scripted.requests).toHaveLength(1)
    } finally {
      connection.close()
      await adapter.settle()
      await api.close()
    }
  })
})

const passthroughBackend: SandboxBackend = {
  confine: (argv) => ({
    argv: [...argv],
    enforcement: 'full',
    denialSignatures: [],
    runnerFailureRules: [],
  }),
}

async function createApi(
  root: string,
  stateRoot: string,
  adapter: ScriptedAdapter,
): Promise<CoreApi> {
  const llm = new LlmClient({ adapterFor: () => adapter })
  llm.setRoutes([testRoute()], 'test-route')
  return await CoreApi.create({
    root,
    stateRoot,
    stateRootSource: 'explicit',
    templatesDir: TEMPLATES_DIR,
    llm,
    sandboxBackend: passthroughBackend,
    initializeMcp: false,
  })
}

async function initialize(agentContext: ClientContext) {
  return await agentContext.request(methods.agent.initialize, {
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: {
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
    },
  })
}

function temp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}
