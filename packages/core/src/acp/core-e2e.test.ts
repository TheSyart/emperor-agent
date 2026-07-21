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
import { describe, expect, it } from 'vitest'
import type { ModelRoute, ProviderSnapshot } from '../model/router'
import { LLMProvider, type ChatArgs, type LLMResponse } from '../providers/base'
import { CoreApi } from '../api/core-api'
import { EmperorAcpAdapter } from './adapter'

const TEMPLATES_DIR = join(__dirname, '..', '..', '..', '..', 'templates')

describe('Emperor ACP real Core E2E', () => {
  it('runs an ACP Build turn through the real CoreApi and persists replayable facts', async () => {
    const runtimeRoot = temp('emperor-acp-core-runtime-')
    const workspace = temp('emperor-acp-core-workspace-')
    const stateRoot = temp('emperor-acp-core-state-')
    const provider = new FakeProvider()
    const api = await CoreApi.create({
      root: runtimeRoot,
      stateRoot,
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(provider),
      initializeMcp: false,
    })
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
      expect(provider.calls).toHaveLength(1)
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
      const replay = api.runtime.replay({
        sessionId: created.sessionId,
        compact: false,
      })
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
    const provider = new DelayedProvider()
    const api = await CoreApi.create({
      root: runtimeRoot,
      stateRoot,
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(provider),
      initializeMcp: false,
    })
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
      await provider.entered
      await connection.agent.notify(methods.agent.session.cancel, {
        sessionId: created.sessionId,
      })

      await expect(prompt).resolves.toMatchObject({ stopReason: 'cancelled' })
      expect(provider.aborted).toBe(true)
      await adapter.settle()
      expect(api.loop.activeTasks.hasActiveForSession(created.sessionId)).toBe(
        false,
      )
    } finally {
      connection.close()
      await adapter.settle()
      await api.close()
    }
  })
})

class FakeProvider extends LLMProvider {
  readonly calls: ChatArgs[] = []

  constructor() {
    super({ defaultModel: 'fake-main' })
  }

  async chat(args: ChatArgs): Promise<LLMResponse> {
    this.calls.push(args)
    return response('pong')
  }
}

class DelayedProvider extends FakeProvider {
  private enter!: () => void
  readonly entered = new Promise<void>((resolve) => {
    this.enter = resolve
  })
  aborted = false

  override async chat(args: ChatArgs): Promise<LLMResponse> {
    this.calls.push(args)
    this.enter()
    await new Promise<void>((resolve, reject) => {
      const signal = args.signal
      if (signal?.aborted) {
        this.aborted = true
        reject(signal.reason)
        return
      }
      signal?.addEventListener(
        'abort',
        () => {
          this.aborted = true
          reject(signal.reason)
        },
        { once: true },
      )
    })
    return response('unreachable')
  }
}

function fakeRouter(provider: FakeProvider): {
  route: (
    useCase: string,
    agentType?: string | null,
    task?: string | null,
  ) => ModelRoute
  payload: () => Record<string, unknown>
} {
  return {
    route: (useCase: string) => ({
      snapshot: snapshot(
        provider,
        useCase === 'main_agent' ? 'main' : 'secondary',
      ),
      fallback: null,
      useCase,
      reason: `${useCase}:fake`,
      estimatedTokens: null,
    }),
    payload: () => ({
      mainModel: 'fake-main',
      secondaryModel: 'fake-secondary',
    }),
  }
}

function snapshot(
  provider: FakeProvider,
  role: 'main' | 'secondary',
): ProviderSnapshot {
  return {
    provider,
    providerName: 'fake',
    providerLabel: 'Fake',
    model: role === 'main' ? 'fake-main' : 'fake-secondary',
    apiBase: null,
    generation: { maxTokens: 2_000, temperature: 0.1, reasoningEffort: null },
    contextWindowTokens: 100_000,
    config: {},
    supportsVision: false,
    entryName: 'fake',
    entryLabel: 'Fake',
    modelRole: role,
    routeReason: `${role}_model`,
  }
}

function response(content: string): LLMResponse {
  return {
    content,
    toolCalls: [],
    finishReason: 'stop',
    usage: { input: 1, output: 1 },
    reasoningContent: null,
    thinkingBlocks: null,
  }
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
