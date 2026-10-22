import { describe, expect, it, vi } from 'vitest'
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  CODEX_FEATURES,
  CodexExecutorAdapter,
  codexAppServerArgs,
  normalizeCodexNotification,
} from './codex'
import { recordedProtocol } from './codex-schema-test-fixture'
import { ManagedAgentProcess } from '../process'
import { defaultExecutorConfig } from '../config'
import { delegationTestDirectory } from '../testing'
import { linkCodexAuth } from '../codex-auth'
import { KNOWN_CODEX_PROTOCOLS } from '../compatibility'
import type { ExecutorOpenInput, NormalizedExecutorEvent } from '../types'

/** Every Codex protocol Emperor has recorded and verified, oldest first. */
const VERIFIED = ['0.153.4', '0.163.0'] as const

/**
 * Features Emperor turns off so a delegated Codex stays inside its
 * boundaries: no native delegation, plugins, apps, browser or computer use,
 * hooks or memories (AGT-01), and none of what 0.163 turned on by default
 * that reaches past the run (AGT-13): a daemon that could outlive it,
 * worktrees outside Emperor's workspace lease, voice and realtime, browser
 * annotation, a speed tier, Daybreak, commands on a pseudo-terminal (their
 * own session, outside the process group), a new approval path and the
 * under-development instant interrupt.
 */
const BOUNDARY_OFF = [
  'multi_agent',
  'multi_agent_v2',
  'apps',
  'plugins',
  'remote_plugin',
  'goals',
  'computer_use',
  'browser_use',
  'browser_use_external',
  'browser_use_full_cdp_access',
  'in_app_browser',
  'in_app_chat',
  'in_app_local_automation',
  'hooks',
  'memories',
  'skill_search',
  'skill_mcp_dependency_install',
  'workspace_dependencies',
  'recommended_plugins',
  'tool_suggest',
  'sleep_tool',
  'shell_snapshot',
  'shell_snapshot_v2',
  'daemon_auto_start',
  'worktrees',
  'realtime_conversation',
  'in_app_voice',
  'browser_annotation_api',
  'ultrafast_mode',
  'cli_daybreak',
  'unified_exec_tty',
  'write_stdin_approval',
  'instant_interrupt',
]

/**
 * What stays on under Emperor's overrides, from each protocol's recorded
 * defaults (`features.json`, `codex features list`). A change here is a
 * decision: read what the feature does before pinning it.
 */
const EFFECTIVE_ON: Record<(typeof VERIFIED)[number], string[]> = {
  '0.153.4': [
    'auth_elicitation',
    'code_mode_host',
    'collaboration_modes',
    'compaction_image_budget',
    'content_item_kinds',
    'default_mode_request_user_input',
    'enable_request_compression',
    'fast_mode',
    'guardian_approval',
    'image_generation',
    'in_app_dictation',
    'in_app_updates',
    'item_ids',
    'mentions_v2',
    'personality',
    'plugin_sharing',
    'remote_compaction_v2',
    'resize_all_images',
    'shell_tool',
    'skip_host_skill_discovery',
    'sqlite',
    'standalone_web_search',
    'steer',
    'terminal_resize_reflow',
    'tool_call_mcp_elicitation',
    'tool_search_always_defer_mcp_tools',
    'tui_app_server',
    'unbounded_connection_retries',
    'unified_exec',
    'unified_exec_zsh_fork',
    'view_image',
  ],
  '0.163.0': [
    // New in 0.163 and kept: model metadata for API-key accounts, an
    // interrupt that reaches a running code-mode cell, the guardian reviewer's
    // context (no reviewer runs: approvals are never asked), and the macOS
    // system proxy for Codex's own connection.
    'api_key_cyber_access_programs',
    'api_key_model_discovery',
    'auth_elicitation',
    'code_mode_host',
    'code_mode_interrupt',
    'collaboration_modes',
    'compaction_image_budget',
    'content_item_kinds',
    'default_mode_request_user_input',
    'enable_request_compression',
    'fast_mode',
    'guardian_approval',
    'guardian_reuse_parent_compaction',
    'image_generation',
    'in_app_dictation',
    'in_app_updates',
    'item_ids',
    'mentions_v2',
    'plugin_sharing',
    'resize_all_images',
    'shell_tool',
    'skip_host_skill_discovery',
    'sqlite',
    'standalone_web_search',
    'steer',
    'system_proxy_fallback',
    'terminal_resize_reflow',
    'tool_call_mcp_elicitation',
    'tool_search_always_defer_mcp_tools',
    'tui_app_server',
    'unbounded_connection_retries',
    'unified_exec',
    'view_image',
  ],
}

/** A protocol's recorded feature defaults: name → on by default. */
function featureDefaults(version: string): Record<string, boolean> {
  const recorded = recordedProtocol(version).file('features.json') as {
    features: Record<string, { enabled: boolean }>
  }
  return Object.fromEntries(
    Object.entries(recorded.features).map(([name, f]) => [name, f.enabled]),
  )
}

it('maps only public agent text and tool state; reasoning never crosses the normalized boundary', () => {
  expect(
    normalizeCodexNotification('item/agentMessage/delta', { delta: 'hello' }),
  ).toEqual([{ type: 'text_delta', text: 'hello' }])
  expect(
    normalizeCodexNotification('item/reasoning/textDelta', {
      delta: 'private',
    }),
  ).toEqual([])
  expect(
    normalizeCodexNotification('item/started', {
      item: {
        id: 'cmd',
        type: 'commandExecution',
        command: 'python3 tests.py',
      },
    }),
  ).toEqual([
    {
      type: 'tool_started',
      id: 'cmd',
      name: 'commandExecution',
      detail: 'python3 tests.py',
    },
  ])
  expect(
    normalizeCodexNotification('item/completed', {
      item: {
        id: 'cmd',
        type: 'commandExecution',
        status: 'completed',
        exitCode: 0,
      },
    }),
  ).toEqual([{ type: 'tool_finished', id: 'cmd', status: 'completed' }])
  expect(
    normalizeCodexNotification('turn/completed', {
      turn: { id: 'turn', status: 'interrupted', items: [] },
    }),
  ).toEqual([{ type: 'turn_finished', status: 'interrupted' }])
})
it('without a run meter reads only the last request, and never invents USD cost', () => {
  expect(
    normalizeCodexNotification('thread/tokenUsage/updated', {
      tokenUsage: {
        total: { inputTokens: 1000, outputTokens: 500 },
        last: { inputTokens: 10, outputTokens: 5 },
      },
    }),
  ).toEqual([{ type: 'usage', inputTokens: 10, outputTokens: 5 }])
})
it('an interrupted turn stays interrupted when Codex says why (0.163: Turn.error on interrupted turns)', () => {
  expect(
    normalizeCodexNotification('turn/completed', {
      turn: {
        id: 'turn',
        status: 'interrupted',
        items: [],
        error: { message: 'too many denials' },
      },
    }),
  ).toEqual([
    { type: 'turn_finished', status: 'interrupted', error: 'too many denials' },
  ])
})
it('every recorded protocol is registered, oldest first', () => {
  expect(KNOWN_CODEX_PROTOCOLS.map((p) => p.version)).toEqual([...VERIFIED])
})

/** The user agent a real app-server returns for Emperor's clientInfo. */
function userAgent(version: string) {
  return `emperor-agent/${version} (Mac OS 26.4.1; arm64) unknown (emperor-agent; 0.1.0)`
}

/**
 * The real adapter over a recording transport, signed in with a ChatGPT
 * login so the FIX-16 `model/list` runs too. Every request and every
 * answer to a server request is kept.
 */
function recordingAdapter(version: string) {
  const f = delegationTestDirectory(),
    runtimeRoot = join(f.root, 'runtime')
  mkdirSync(runtimeRoot)
  const home = join(f.root, 'fake-home', '.codex')
  mkdirSync(home, { recursive: true })
  const source = join(home, 'auth.json')
  writeFileSync(
    source,
    JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: { refresh_token: 'refresh-0', account_id: 'acct-1' },
    }),
    { mode: 0o600 },
  )
  const link = { source, isolated: join(runtimeRoot, 'auth.json') }
  linkCodexAuth(link)
  const input: ExecutorOpenInput = {
    delegationId: 'dlg-contract',
    profile: { ...defaultExecutorConfig().profiles[1]!, enabled: true },
    cwd: f.root,
    environment: {
      PATH: process.env.PATH ?? '',
      HOME: runtimeRoot,
      CODEX_HOME: runtimeRoot,
    },
    runtimeRoot,
    policy: {
      mode: 'workspace-write',
      workspaceRoot: f.root,
      runtimeStateRoots: [runtimeRoot],
      privateTempRoot: runtimeRoot,
      writableFiles: [realpathSync(source)],
    },
    boundaryReceiptId: 'boundary',
    generation: 2,
    signal: new AbortController().signal,
    codexAuth: link,
  }
  const processes = new ManagedAgentProcess(),
    spawn = processes.spawn.bind(processes)
  vi.spyOn(processes, 'spawn').mockImplementation((spec) =>
    spawn({
      ...spec,
      executable: process.execPath,
      args: ['-e', 'process.stdin.resume()'],
    }),
  )
  const requests: { method: string; params: unknown }[] = []
  const answers: { id: string | number; result: unknown }[] = []
  let turns = 0
  let notify!: (method: string, params: Record<string, unknown>) => void
  let serverRequest!: (
    id: string,
    method: string,
    params: Record<string, unknown>,
  ) => void | Promise<void>
  const adapter = new CodexExecutorAdapter({
    processes,
    rpc: (options) => {
      notify = options.onNotification!
      serverRequest = options.onRequest!
      return {
        request: async (method: string, params: unknown) => {
          requests.push({ method, params })
          switch (method) {
            case 'initialize':
              return { userAgent: userAgent(version) }
            case 'thread/start':
            case 'thread/resume':
              return {
                thread: { id: 'thread-contract' },
                model: 'gpt-6.1-sol',
                modelProvider: 'openai',
              }
            case 'model/list':
              return {
                data: [
                  {
                    id: 'gpt-5.6-sol',
                    model: 'gpt-5.6-sol',
                    displayName: 'GPT-5.6-Sol',
                    isDefault: true,
                    hidden: false,
                  },
                  {
                    id: 'gpt-5.6-terra',
                    model: 'gpt-5.6-terra',
                    displayName: 'GPT-5.6-Terra',
                    isDefault: false,
                    hidden: true,
                  },
                ],
                nextCursor: null,
              }
            case 'turn/start':
              return { turn: { id: 'turn-' + ++turns, status: 'inProgress' } }
            case 'turn/steer':
              return { turnId: 'turn-' + turns }
            case 'thread/read':
              return {
                thread: { id: 'thread-contract', status: { type: 'idle' } },
              }
            case 'thread/turns/list':
              return { data: [], nextCursor: null }
            default:
              return {}
          }
        },
        notify: async () => {},
        respond: async (id: string | number, result: unknown) => {
          answers.push({ id, result })
        },
        reject: async () => {},
        hold: () => () => {},
        close: () => options.output.end(),
      }
    },
  })
  return {
    ...f,
    input,
    adapter,
    processes,
    requests,
    answers,
    notify: (method: string, params: Record<string, unknown>) =>
      notify(method, params),
    serverRequest: (
      id: string,
      method: string,
      params: Record<string, unknown>,
    ) => serverRequest(id, method, params),
  }
}

async function next(
  events: AsyncIterable<NormalizedExecutorEvent>,
  type: NormalizedExecutorEvent['type'],
) {
  for await (const event of events) if (event.type === type) return event
  throw new Error('no ' + type)
}

/** Everything the adapter sends in a run, a retry, a steer, a question and a resume. */
async function exerciseAdapter(version: string) {
  const f = recordingAdapter(version)
  const session = await f.adapter.open(f.input)
  const turn = { runId: 'dgr-1', messageId: 'dgm-1', text: 'task' }
  const { providerTurnId } = await session.submit(turn)
  await session.steer({
    providerTurnId,
    messageId: 'dgm-2',
    text: 'also this',
  })
  const scope = { threadId: 'thread-contract', turnId: providerTurnId }
  for (const method of [
    'item/commandExecution/requestApproval',
    'item/fileChange/requestApproval',
    'item/permissions/requestApproval',
  ])
    await f.serverRequest(method, method, scope)
  await f.serverRequest('question', 'item/tool/requestUserInput', {
    ...scope,
    itemId: 'item-q',
    questions: [
      {
        id: 'q1',
        header: 'Pick',
        question: 'Which?',
        options: [{ label: 'A' }],
      },
    ],
  })
  const question = await next(session.events, 'question')
  await session.answer({
    requestId: (question as { requestId: string }).requestId,
    generation: 2,
    kind: 'question',
    answers: { q1: 'A' },
  })
  await session.interrupt(providerTurnId)
  // The refused model gives way to another the list offers: turn/start again.
  expect(await session.retryOnSupportedModel!(turn, 'gpt-5.6-sol')).toEqual({
    providerTurnId: 'turn-2',
    model: 'gpt-5.6-terra',
  })
  await session.close()
  const structured = await f.adapter.open(f.input)
  await structured.submit({
    runId: 'dgr-2',
    messageId: 'dgm-3',
    text: 'json please',
    outputSchema: {
      type: 'object',
      properties: { ok: { type: 'boolean' } },
      required: ['ok'],
      additionalProperties: false,
    },
  })
  await structured.close()
  await f.adapter.inspect({ ...f.input, resumeSessionId: 'thread-contract' })
  f.cleanup()
  return f
}

/** Methods whose answers the adapter writes, and the schema file of each. */
const ANSWERS: Record<string, string> = {
  'item/commandExecution/requestApproval':
    'CommandExecutionRequestApprovalResponse.json',
  'item/fileChange/requestApproval': 'FileChangeRequestApprovalResponse.json',
  'item/permissions/requestApproval': 'PermissionsRequestApprovalResponse.json',
  question: 'ToolRequestUserInputResponse.json',
}

describe.each(VERIFIED)('Codex %s protocol', (version) => {
  const protocol = () => recordedProtocol(version)

  it('the features left on under Emperor’s overrides are exactly the pinned ones', () => {
    const effective = featureDefaults(version)
    for (const [name, value] of Object.entries(CODEX_FEATURES))
      if (name in effective) effective[name] = value
    expect(
      Object.keys(effective)
        .filter((name) => effective[name])
        .sort(),
    ).toEqual(EFFECTIVE_ON[version])
    for (const name of BOUNDARY_OFF)
      expect(effective[name] ?? false, name).toBe(false)
  })

  it('every request the adapter sends is a valid request of this protocol', async () => {
    const { requests } = await exerciseAdapter(version)
    expect([...new Set(requests.map((r) => r.method))].sort()).toEqual(
      [
        'initialize',
        'model/list',
        'thread/read',
        'thread/resume',
        'thread/start',
        'thread/turns/list',
        'turn/interrupt',
        'turn/start',
        'turn/steer',
      ].sort(),
    )
    for (const { method, params } of requests)
      expect(protocol().requestViolations(method, params), method).toEqual([])
  })

  it('every server request the adapter answers gets a valid answer', async () => {
    const { answers } = await exerciseAdapter(version)
    expect(answers.map((a) => a.id).sort()).toEqual(Object.keys(ANSWERS).sort())
    for (const { id, result } of answers)
      expect(
        protocol().violations(ANSWERS[String(id)]!, result),
        String(id),
      ).toEqual([])
    expect(protocol().methods('ServerRequest.json')).toEqual(
      expect.arrayContaining(
        Object.keys(ANSWERS)
          .filter((m) => m !== 'question')
          .concat('item/tool/requestUserInput'),
      ),
    )
  })

  it('the fields the adapter reads are where it reads them', () => {
    const p = protocol()
    const has = (file: string, ...path: string[]) =>
      expect(p.at(file, ...path), `${file} ${path.join('.')}`).toBeDefined()
    has('v1/InitializeResponse.json', 'userAgent')
    expect(p.file('v1/InitializeResponse.json').required).toContain('userAgent')
    has('v2/ThreadStartResponse.json', 'thread', 'id')
    has('v2/ThreadStartResponse.json', 'model')
    has('v2/ThreadStartResponse.json', 'modelProvider')
    has('v2/TurnStartResponse.json', 'turn', 'id')
    has('v2/TurnSteerResponse.json', 'turnId')
    has('v2/AgentMessageDeltaNotification.json', 'delta')
    for (const file of [
      'v2/AgentMessageDeltaNotification.json',
      'v2/ThreadTokenUsageUpdatedNotification.json',
    ]) {
      has(file, 'threadId')
      has(file, 'turnId')
    }
    for (const part of ['total', 'last'])
      for (const field of [
        'inputTokens',
        'cachedInputTokens',
        'outputTokens',
        'reasoningOutputTokens',
        'totalTokens',
      ])
        has(
          'v2/ThreadTokenUsageUpdatedNotification.json',
          'tokenUsage',
          part,
          field,
        )
    const completed = 'v2/TurnCompletedNotification.json'
    has(completed, 'threadId')
    has(completed, 'turn', 'id')
    has(completed, 'turn', 'error', 'message')
    expect(p.at(completed, 'turn', 'status')!.enum).toEqual(
      expect.arrayContaining(['completed', 'interrupted', 'failed']),
    )
    const item = p.at(completed, 'turn', 'items', '[]')!
    const types = (
      item.oneOf as { properties: { type: { enum: string[] } } }[]
    ).map((variant) => variant.properties.type.enum[0])
    expect(types).toEqual(
      expect.arrayContaining([
        'agentMessage',
        'commandExecution',
        'fileChange',
        'mcpToolCall',
        'dynamicToolCall',
        'webSearch',
        'imageGeneration',
        'collabAgentToolCall',
      ]),
    )
    const input = 'ToolRequestUserInputParams.json'
    has(input, 'threadId')
    has(input, 'turnId')
    has(input, 'questions', '[]', 'id')
    has(input, 'questions', '[]', 'question')
    has(input, 'questions', '[]', 'options', '[]', 'label')
  })

  it('model/list rows carry model, displayName, isDefault and hidden (FIX-16)', () => {
    const p = protocol()
    const model = p.at('v2/ModelListResponse.json', 'data', '[]')!
    expect(model.required).toEqual(
      expect.arrayContaining(['model', 'displayName', 'isDefault', 'hidden']),
    )
    expect(
      p.at('v2/ModelListResponse.json', 'data', '[]', 'isDefault')!.type,
    ).toBe('boolean')
    expect(
      p.at('v2/ModelListResponse.json', 'data', '[]', 'hidden')!.type,
    ).toBe('boolean')
    expect(p.at('v2/ModelListResponse.json', 'nextCursor')).toBeDefined()
    expect(
      p.requestViolations('model/list', {
        limit: 100,
        includeHidden: true,
        cursor: 'next',
      }),
    ).toEqual([])
  })

  it('steer requires expectedTurnId and question answers are distinct per question', () => {
    const p = protocol()
    const steer = p.file('v2/TurnSteerParams.json')
    expect(steer.required).toContain('expectedTurnId')
    expect(steer.properties).toHaveProperty('clientUserMessageId')
    const response = p.file('ToolRequestUserInputResponse.json')
    expect(response.required).toEqual(['answers'])
    expect(
      (
        (response.definitions as Record<string, Record<string, unknown>>)
          .ToolRequestUserInputAnswer as Record<string, unknown>
      ).required,
    ).toEqual(['answers'])
  })

  it('supports metadata-only resume and paged turn history', () => {
    const p = protocol()
    expect(p.at('v2/ThreadResumeParams.json', 'excludeTurns')!.type).toBe(
      'boolean',
    )
    expect(p.methods('ClientRequest.json')).toContain('thread/turns/list')
    const list = (
      p.file('ClientRequest.json').definitions as Record<
        string,
        Record<string, unknown>
      >
    ).ThreadTurnsListParams!
    expect(list.required).toEqual(['threadId'])
    expect(Object.keys(list.properties as object)).toEqual(
      expect.arrayContaining(['cursor', 'limit', 'sortDirection', 'itemsView']),
    )
    expect(
      JSON.stringify(
        (p.file('ClientRequest.json').definitions as Record<string, unknown>)
          .TurnItemsView,
      ),
    ).toContain('summary')
  })
})

it('only 0.163 can split an answer into partial_answer messages (MessagePhase)', () => {
  const phases = (version: string) =>
    (
      recordedProtocol(version).file('v2/TurnCompletedNotification.json')
        .definitions as Record<string, { oneOf: { enum: string[] }[] }>
    ).MessagePhase!.oneOf.map((branch) => branch.enum[0])
  expect(phases('0.153.4')).toEqual(['commentary', 'final_answer'])
  expect(phases('0.163.0')).toEqual([
    'commentary',
    'partial_answer',
    'final_answer',
  ])
})

it('the schema check rejects what a protocol rejects', () => {
  for (const version of VERIFIED) {
    const p = recordedProtocol(version)
    expect(p.requestViolations('turn/start', { input: [] })).toContain(
      'turn/start.threadId: required',
    )
    expect(
      p.requestViolations('turn/start', {
        threadId: 't',
        input: [{ type: 'text', text: 'x', text_elements: [] }],
        sandboxPolicy: { type: 'bogus' },
      }).length,
    ).toBeGreaterThan(0)
    expect(
      p.requestViolations('turn/steer', {
        threadId: 't',
        input: [{ type: 'text', text: 'x', text_elements: [] }],
      }),
    ).toContain('turn/steer.expectedTurnId: required')
    expect(p.requestViolations('no/such', {})).toEqual([
      `no/such: not a request of Codex ${version}`,
    ])
  }
  // 0.163 removed thread/rollback (Emperor never used it).
  expect(recordedProtocol('0.153.4').methods('ClientRequest.json')).toContain(
    'thread/rollback',
  )
  expect(
    recordedProtocol('0.163.0').methods('ClientRequest.json'),
  ).not.toContain('thread/rollback')
})

it('every boundary flag is overridden off, at spawn and in thread/start', async () => {
  for (const name of BOUNDARY_OFF)
    expect(CODEX_FEATURES[name], name).toBe(false)
  const args = codexAppServerArgs()
  for (const [name, value] of Object.entries(CODEX_FEATURES))
    expect(args.join(' '), name).toContain(`features.${name}=${value}`)
  const f = recordingAdapter('0.163.0')
  const spawn = vi.mocked(f.processes.spawn)
  const session = await f.adapter.open(f.input)
  expect(spawn.mock.calls[0]![0].args).toEqual(codexAppServerArgs())
  const config = (
    f.requests.find((r) => r.method === 'thread/start')!.params as {
      config: Record<string, unknown>
    }
  ).config
  for (const [name, value] of Object.entries(CODEX_FEATURES))
    expect(config['features.' + name], name).toBe(value)
  await session.close()
  f.cleanup()
})

it('0.163 knows every override; 0.153.4 does not know eight of them and ignores them silently', () => {
  const unknown = (version: string) =>
    Object.keys(CODEX_FEATURES)
      .filter((name) => !(name in featureDefaults(version)))
      .sort()
  // 0.163 would log a configWarning for a key it does not know.
  expect(unknown('0.163.0')).toEqual([])
  // Checked against the real 0.153.4 (AGT-13): no warning, no error, the
  // known features unchanged. The keys are sent to both versions.
  expect(unknown('0.153.4')).toEqual([
    'browser_annotation_api',
    'cli_daybreak',
    'daemon_auto_start',
    'in_app_voice',
    'instant_interrupt',
    'ultrafast_mode',
    'unified_exec_tty',
    'worktrees',
  ])
})
