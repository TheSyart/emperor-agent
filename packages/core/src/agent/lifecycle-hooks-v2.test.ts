import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { HookEventName } from '../hooks'
import type { ModelRoute, ProviderSnapshot } from '../model/router'
import { LLMProvider, type ChatArgs, type LLMResponse } from '../providers/base'
import { AgentLoop } from './loop'

type Dict = Record<string, unknown>

class LifecycleProvider extends LLMProvider {
  readonly messages: ChatArgs['messages'][] = []
  constructor(private readonly replies: Array<string | Error>) {
    super({ defaultModel: 'fake' })
  }
  async chat(args: ChatArgs): Promise<LLMResponse> {
    this.messages.push(args.messages.map((message) => ({ ...message })))
    const next = this.replies.shift() ?? 'done'
    if (next instanceof Error) throw next
    return {
      content: next,
      toolCalls: [],
      finishReason: 'stop',
      usage: {},
      reasoningContent: null,
      thinkingBlocks: null,
    }
  }
}

function router(provider: LLMProvider) {
  const snapshot: ProviderSnapshot = {
    provider,
    providerName: 'fake',
    providerLabel: 'Fake',
    model: 'fake',
    apiBase: null,
    generation: { maxTokens: 2_000, temperature: 0.1, reasoningEffort: null },
    contextWindowTokens: 100_000,
    config: {},
    supportsVision: false,
    entryName: 'fake',
    entryLabel: 'Fake',
    modelRole: 'main',
    routeReason: 'fake',
  }
  return {
    route: (useCase: string): ModelRoute => ({
      snapshot,
      fallback: null,
      useCase,
      reason: `${useCase}:fake`,
      estimatedTokens: null,
    }),
    routeForRole: (useCase: string): ModelRoute => ({
      snapshot,
      fallback: null,
      useCase,
      reason: `${useCase}:fake`,
      estimatedTokens: null,
    }),
    payload: () => ({ mainModel: 'fake' }),
  }
}

function handler(id: string, output: Dict): Dict {
  return {
    id,
    type: 'command',
    enabled: true,
    command: process.execPath,
    args: [
      '-e',
      `process.stdout.write(${JSON.stringify(JSON.stringify(output))})`,
    ],
    shell: 'none',
    allowedEnv: [],
    async: false,
    asyncRewake: false,
    timeoutMs: 1_000,
    statusMessage: '',
    once: false,
  }
}

function writeHooks(
  stateRoot: string,
  hooks: Partial<Record<HookEventName, Dict[]>>,
): void {
  mkdirSync(stateRoot, { recursive: true })
  const groups: Dict = {}
  for (const [event, handlers] of Object.entries(hooks)) {
    groups[event] = [
      {
        id: `${event}-group`,
        enabled: true,
        matcher: '*',
        if: '',
        failureMode: 'closed',
        handlers,
      },
    ]
  }
  writeFileSync(
    join(stateRoot, 'hooks_config.json'),
    JSON.stringify({ version: 2, hooks: groups }),
    'utf8',
  )
}

function roots(prefix: string): { root: string; stateRoot: string } {
  const root = mkdtempSync(join(tmpdir(), prefix))
  return { root, stateRoot: join(root, '.state') }
}

describe('AgentLoop hooks v2 lifecycle', () => {
  it('runs SessionStart once and injects its context into the first model request', async () => {
    const paths = roots('hook-life-start-')
    writeHooks(paths.stateRoot, {
      SessionStart: [
        handler('start-context', {
          additionalContext: 'session policy context',
        }),
      ],
    })
    const provider = new LifecycleProvider(['first', 'second'])
    const loop = await AgentLoop.create({
      ...paths,
      modelRouter: router(provider),
      initializeMcp: false,
    })
    try {
      await loop.runUserTurn('one')
      await loop.runUserTurn('two')

      expect(JSON.stringify(provider.messages[0])).toContain(
        'session policy context',
      )
      const audit = await loop.hookService.audit.replayRuns({ limit: 20 })
      expect(
        audit.records.filter((record) => record.eventName === 'SessionStart'),
      ).toHaveLength(1)
    } finally {
      await loop.close()
    }
  })

  it('denies a prompt before user history is committed', async () => {
    const paths = roots('hook-life-prompt-deny-')
    writeHooks(paths.stateRoot, {
      UserPromptSubmit: [
        handler('prompt-deny', { decision: 'deny', reason: 'blocked prompt' }),
      ],
    })
    const provider = new LifecycleProvider(['unused'])
    const loop = await AgentLoop.create({
      ...paths,
      modelRouter: router(provider),
      initializeMcp: false,
    })
    try {
      await expect(loop.runUserTurn('secret prompt')).rejects.toThrow(
        /blocked prompt/,
      )
      expect(
        loop.history.some(
          (message) =>
            message.role === 'user' && message.content === 'secret prompt',
        ),
      ).toBe(false)
      expect(
        loop.activeMemoryStore
          .loadUnarchivedHistory()
          .some(
            (message) =>
              message.role === 'user' && message.content === 'secret prompt',
          ),
      ).toBe(false)
      expect(provider.messages).toHaveLength(0)
    } finally {
      await loop.close()
    }
  })

  it('separates transformed model prompt from displayed user content and persists hook context', async () => {
    const paths = roots('hook-life-prompt-update-')
    writeHooks(paths.stateRoot, {
      UserPromptSubmit: [
        handler('prompt-update', {
          decision: 'allow',
          updatedInput: { content: 'model-visible prompt' },
          additionalContext: 'persisted prompt policy',
        }),
      ],
    })
    const provider = new LifecycleProvider(['done'])
    const emitted: Dict[] = []
    const loop = await AgentLoop.create({
      ...paths,
      modelRouter: router(provider),
      initializeMcp: false,
      eventSink: (event) => {
        emitted.push(event)
      },
    })
    try {
      await loop.runUserTurn('user-visible prompt')

      expect(JSON.stringify(provider.messages[0])).toContain(
        'model-visible prompt',
      )
      expect(JSON.stringify(provider.messages[0])).toContain(
        'persisted prompt policy',
      )
      expect(
        emitted.find((event) => event.event === 'user_message'),
      ).toMatchObject({ content: 'user-visible prompt' })
      expect(
        loop.activeMemoryStore
          .loadUnarchivedHistory()
          .some((message) =>
            String(message.content).includes('persisted prompt policy'),
          ),
      ).toBe(true)
    } finally {
      await loop.close()
    }
  })

  it('allows one hidden Stop continuation and emits nonblocking StopFailure on provider errors', async () => {
    const paths = roots('hook-life-stop-')
    writeHooks(paths.stateRoot, {
      Stop: [
        handler('stop-continue', { continue: true, stopReason: 'verify once' }),
      ],
      StopFailure: [handler('stop-failure', {})],
    })
    const provider = new LifecycleProvider(['draft', 'final'])
    const loop = await AgentLoop.create({
      ...paths,
      modelRouter: router(provider),
      initializeMcp: false,
    })
    try {
      expect(await loop.runUserTurn('work')).toBe('draftfinal')
      expect(provider.messages).toHaveLength(2)
      expect(JSON.stringify(provider.messages[1])).toContain('verify once')

      const failing = new LifecycleProvider([new Error('provider exploded')])
      ;(loop as unknown as { modelRouter: unknown }).modelRouter =
        router(failing)
      const bindings = loop.sessionRuntimes.actor(
        loop.activeSessionId!,
      ).bindings
      loop.runner = (
        loop as unknown as {
          buildMainRunner(input: typeof bindings): typeof loop.runner
        }
      ).buildMainRunner(bindings)
      await expect(loop.runUserTurn('fail now')).rejects.toThrow()
      const audit = await loop.hookService.audit.replayRuns({ limit: 50 })
      expect(
        audit.records.some((record) => record.eventName === 'StopFailure'),
      ).toBe(true)
    } finally {
      await loop.close()
    }
  })

  it('defers ordinary compaction but audits an emergency bypass from the same policy', async () => {
    const paths = roots('hook-life-compact-deny-')
    writeHooks(paths.stateRoot, {
      PreCompact: [
        handler('compact-deny', {
          decision: 'deny',
          reason: 'defer compaction',
        }),
      ],
      PostCompact: [handler('compact-observe', {})],
    })
    const loop = await AgentLoop.create({
      ...paths,
      modelRouter: router(new LifecycleProvider(['done'])),
      initializeMcp: false,
    })
    try {
      const manual = await loop.beginCompactionHooks('manual')
      const emergency = await loop.beginCompactionHooks('emergency')
      await loop.finishCompactionHooks(emergency, {
        status: 'completed',
        strategy: 'emergency_context_shrink',
      })

      expect(manual).toMatchObject({
        allowed: false,
        bypassed: false,
        reason: 'defer compaction',
      })
      expect(emergency).toMatchObject({ allowed: true, bypassed: true })
      const audit = await loop.hookService.audit.replayRuns({ limit: 20 })
      expect(audit.records.map((record) => record.eventName)).toContain(
        'PostCompact',
      )
    } finally {
      await loop.close()
    }
  })

  it('carries PreCompact instructions through a shared compaction scope', async () => {
    const paths = roots('hook-life-compact-instructions-')
    writeHooks(paths.stateRoot, {
      PreCompact: [
        handler('compact-instructions', {
          compactInstructions: 'retain deployment decisions',
        }),
      ],
    })
    const loop = await AgentLoop.create({
      ...paths,
      modelRouter: router(new LifecycleProvider(['done'])),
      initializeMcp: false,
    })
    try {
      const scope = await loop.beginCompactionHooks('auto')
      expect(scope).toMatchObject({
        allowed: true,
        instructions: 'retain deployment decisions',
      })
    } finally {
      await loop.close()
    }
  })

  it('runs SessionEnd while the session still exists, before deletion cleanup', async () => {
    const paths = roots('hook-life-session-end-')
    writeHooks(paths.stateRoot, { SessionEnd: [handler('session-end', {})] })
    const loop = await AgentLoop.create({
      ...paths,
      modelRouter: router(new LifecycleProvider(['done'])),
      initializeMcp: false,
    })
    const sessionId = loop.activeSessionId!
    try {
      await loop.endSession(sessionId, 'deleted')
      const audit = await loop.hookService.audit.replayRuns({ limit: 20 })

      expect(
        audit.records.some(
          (record) =>
            record.eventName === 'SessionEnd' && record.sessionId === sessionId,
        ),
      ).toBe(true)
      expect(loop.sessionStore.get(sessionId)).toBeTruthy()
    } finally {
      await loop.close()
    }
  })

  it('maps a team runner stop to TeammateIdle and continues at most once', async () => {
    const paths = roots('hook-life-team-idle-')
    writeHooks(paths.stateRoot, {
      TeammateIdle: [
        handler('team-idle', {
          continue: true,
          stopReason: 'send a stronger report',
        }),
      ],
    })
    const finalTeamReport =
      'final team report\n结论: complete\n证据: hook continuation observed\n风险: none\n建议下一步: none'
    const provider = new LifecycleProvider([
      'draft team report',
      finalTeamReport,
    ])
    const loop = await AgentLoop.create({
      ...paths,
      modelRouter: router(provider),
      initializeMcp: false,
    })
    try {
      const payload = JSON.parse(
        await loop.teamManager.spawnTeammate({
          name: 'alice',
          role: 'reader',
          task: 'inspect docs',
        }),
      )

      expect(payload.result).toBe(`draft team report${finalTeamReport}`)
      expect(provider.messages).toHaveLength(2)
      expect(JSON.stringify(provider.messages[1])).toContain(
        'send a stronger report',
      )
      expect(loop.hookService.agentScopeCount).toBe(0)
      const audit = await loop.hookService.audit.replayRuns({ limit: 20 })
      expect(
        audit.records.filter((record) => record.eventName === 'TeammateIdle'),
      ).toHaveLength(2)
    } finally {
      await loop.close()
    }
  })

  it('maps a dispatched runner stop to SubagentStop and shares the parent scope', async () => {
    const paths = roots('hook-life-subagent-stop-')
    writeHooks(paths.stateRoot, {
      SubagentStart: [
        handler('subagent-start', {
          additionalContext: 'nested start context',
        }),
      ],
      SubagentStop: [
        handler('subagent-stop', {
          continue: true,
          stopReason: 'inspect one more thing',
        }),
      ],
    })
    const finalSubagentReport =
      'final subagent report\n结论: complete\n证据: hook continuation observed\n风险: none\n建议下一步: none'
    const provider = new LifecycleProvider([
      'draft subagent report',
      finalSubagentReport,
    ])
    const loop = await AgentLoop.create({
      ...paths,
      modelRouter: router(provider),
      initializeMcp: false,
    })
    try {
      const result = await loop.registry.executeResult(
        'dispatch_subagent',
        {
          agent_type: 'sili_suitang',
          task: 'inspect docs',
          purpose: 'read',
        },
        {
          root: paths.root,
          workspaceRoot: paths.root,
          sessionId: loop.activeSessionId,
          parentCallId: 'dispatch-1',
        },
      )

      expect(result.modelContent).toBe(
        `draft subagent report${finalSubagentReport}`,
      )
      expect(JSON.stringify(provider.messages[0])).toContain(
        'nested start context',
      )
      expect(JSON.stringify(provider.messages[1])).toContain(
        'inspect one more thing',
      )
      expect(loop.hookService.agentScopeCount).toBe(0)
      const audit = await loop.hookService.audit.replayRuns({ limit: 30 })
      expect(
        audit.records.filter((record) => record.eventName === 'SubagentStop'),
      ).toHaveLength(2)
    } finally {
      await loop.close()
    }
  })
})
