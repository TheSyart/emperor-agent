import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type {
  Options,
  Query,
  SDKUserMessage,
  WarmQuery,
} from '@anthropic-ai/claude-agent-sdk'
import { ClaudeExecutorAdapter, normalizeClaudeMessage } from './claude'
import { defaultExecutorConfig, parseExecutorConfig } from '../config'
import { fixture, spec } from '../service-test-fixture'
import { FakeExecutorAdapter, delegationTestDirectory } from '../testing'
import type { ExecutorOpenInput } from '../types'

/**
 * AGT-02 · a Claude turn that fails says why: the SDK result's `is_error`,
 * `result` text, `api_error_status` and `terminal_reason` become one of
 * AUTH_EXPIRED / RATE_LIMITED / BILLING / MAX_TURNS / CONTEXT_OVERFLOW /
 * EXECUTOR_TURN_FAILED, instead of "Claude execution failed".
 */
const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach((c) => c()))

const usage = { input_tokens: 10, output_tokens: 2 }
function finished(result: Record<string, unknown>) {
  const events = normalizeClaudeMessage({
    type: 'result',
    usage,
    total_cost_usd: 0,
    ...result,
  })
  return events.find((e) => e.type === 'turn_finished')!
}

describe('AGT-02 · Claude failure codes', () => {
  it('6 · a 401 is AUTH_EXPIRED, and the summary keeps the error text', () => {
    expect(
      finished({
        subtype: 'success',
        is_error: true,
        api_error_status: 401,
        terminal_reason: 'api_error',
        result:
          'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired."}}',
      }),
    ).toMatchObject({
      type: 'turn_finished',
      status: 'failed',
      failureCode: 'AUTH_EXPIRED',
      error: expect.stringContaining('OAuth token has expired'),
    })
    // Without a status, the text still says it.
    expect(
      finished({
        subtype: 'success',
        is_error: true,
        result: 'Invalid API key · Please run /login',
      }),
    ).toMatchObject({ failureCode: 'AUTH_EXPIRED' })
  })

  it('7 · a 429 is RATE_LIMITED', () => {
    expect(
      finished({
        subtype: 'success',
        is_error: true,
        api_error_status: 429,
        terminal_reason: 'api_error',
        result: 'API Error: 429 rate_limit_error',
      }),
    ).toMatchObject({ status: 'failed', failureCode: 'RATE_LIMITED' })
    expect(
      finished({
        subtype: 'success',
        is_error: true,
        result: 'Claude AI usage limit reached|1760000000',
      }),
    ).toMatchObject({ failureCode: 'RATE_LIMITED' })
  })

  it('a billing refusal is BILLING; a prompt too long is CONTEXT_OVERFLOW', () => {
    expect(
      finished({
        subtype: 'success',
        is_error: true,
        api_error_status: 400,
        result:
          'API Error: 400 Your credit balance is too low to access the Anthropic API.',
      }),
    ).toMatchObject({ failureCode: 'BILLING' })
    expect(
      finished({
        subtype: 'success',
        is_error: true,
        api_error_status: 402,
        result: 'payment required',
      }),
    ).toMatchObject({ failureCode: 'BILLING' })
    for (const terminal_reason of [
      'prompt_too_long',
      'blocking_limit',
      'rapid_refill_breaker',
    ])
      expect(
        finished({
          subtype: 'success',
          is_error: true,
          terminal_reason,
          result: 'Prompt is too long',
        }),
      ).toMatchObject({ failureCode: 'CONTEXT_OVERFLOW' })
  })

  it('8 · running past maxTurns is MAX_TURNS', () => {
    expect(
      finished({
        subtype: 'error_max_turns',
        is_error: true,
        terminal_reason: 'max_turns',
        num_turns: 201,
        errors: [],
      }),
    ).toMatchObject({ status: 'failed', failureCode: 'MAX_TURNS' })
  })

  it('anything else is EXECUTOR_TURN_FAILED, and success is untouched', () => {
    expect(
      finished({
        subtype: 'error_during_execution',
        is_error: true,
        errors: ['tool crashed'],
      }),
    ).toMatchObject({
      status: 'failed',
      failureCode: 'EXECUTOR_TURN_FAILED',
      error: 'tool crashed',
    })
    expect(
      finished({ subtype: 'success', is_error: false, result: 'done' }),
    ).toEqual({ type: 'turn_finished', status: 'completed', text: 'done' })
  })

  it('the run records the mapped code; an unmapped failure stays EXECUTOR_TURN_FAILED', async () => {
    for (const [code, expected] of [
      ['RATE_LIMITED', 'RATE_LIMITED'],
      [undefined, 'EXECUTOR_TURN_FAILED'],
    ] as const) {
      const f = fixture()
      cleanups.push(f.cleanup)
      const adapter = new FakeExecutorAdapter('claude-code', async function* (
        turn,
        open,
      ) {
        yield {
          type: 'turn_finished',
          status: 'failed',
          error: 'API Error: 429',
          ...(code ? { failureCode: code } : {}),
          delegationId: open.delegationId,
          runId: turn.runId,
          generation: open.generation,
        }
      })
      f.options.adapters.set('claude-code', adapter)
      const record = await f.service.start(f.owner, {
        ...spec,
        backend: 'claude-code',
        profileId: 'claude-default',
      })
      const run = await f.service.wait(record.id, record.currentRunId!)
      expect(run).toMatchObject({ phase: 'failed', failureCode: expected })
      await f.service.shutdown()
    }
  })
})

describe('AGT-02 · maxTurns', () => {
  function sdk() {
    const f = delegationTestDirectory()
    cleanups.push(f.cleanup)
    const runtimeRoot = join(f.root, 'runtime')
    mkdirSync(runtimeRoot)
    let options: Options | undefined
    const start = vi.fn(
      async (opts: Options): Promise<Pick<WarmQuery, 'query' | 'close'>> => {
        options = opts
        const proc = opts.spawnClaudeCodeProcess!({
          command: process.execPath,
          args: ['-e', 'process.stdin.resume()'],
          cwd: f.root,
          env: {},
          signal: new AbortController().signal,
        })
        return {
          close: () => proc.stdin.end(),
          query: (prompts: string | AsyncIterable<SDKUserMessage>) =>
            Object.assign(
              (async function* () {
                if (typeof prompts === 'string') return
                for await (const _ of prompts)
                  yield {
                    type: 'system',
                    subtype: 'init',
                    session_id: opts.sessionId,
                    tools: ['Read'],
                    plugins: [],
                    mcp_servers: [],
                  }
              })(),
              {
                initializationResult: async () => ({ hooks_applied: true }),
                interrupt: async () => undefined,
                close: () => proc.stdin.end(),
              },
            ) as unknown as Query,
        }
      },
    )
    const input: ExecutorOpenInput = {
      delegationId: 'dlg-turns',
      profile: { ...defaultExecutorConfig().profiles[0]!, enabled: true },
      cwd: f.root,
      environment: { PATH: process.env.PATH ?? '', HOME: runtimeRoot },
      runtimeRoot,
      policy: {
        mode: 'workspace-write',
        workspaceRoot: f.root,
        runtimeStateRoots: [runtimeRoot],
        privateTempRoot: runtimeRoot,
      },
      boundaryReceiptId: 'boundary',
      generation: 1,
      signal: new AbortController().signal,
    }
    const adapter = new ClaudeExecutorAdapter({ startup: start })
    return { input, adapter, options: () => options! }
  }

  it('8 · the SDK gets 200 turns by default and the configured number otherwise', async () => {
    const a = sdk()
    const first = await a.adapter.open(a.input)
    expect(a.options().maxTurns).toBe(200)
    await first.close()
    const b = sdk()
    const second = await b.adapter.open({ ...b.input, maxTurns: 500 })
    expect(b.options().maxTurns).toBe(500)
    await second.close()
  })

  it('8 · the service passes 设置 › 子智能体 › 高级 maxTurns to the run', async () => {
    const f = fixture()
    cleanups.push(f.cleanup)
    const opened: ExecutorOpenInput[] = []
    f.options.adapters.set(
      'claude-code',
      new FakeExecutorAdapter('claude-code', async function* (turn, open) {
        opened.push(open)
        yield {
          type: 'turn_finished',
          status: 'completed',
          text: 'ok',
          delegationId: open.delegationId,
          runId: turn.runId,
          generation: open.generation,
        }
      }),
    )
    f.config.limits.claudeMaxTurns = 350
    const record = await f.service.start(f.owner, {
      ...spec,
      backend: 'claude-code',
      profileId: 'claude-default',
    })
    await f.service.wait(record.id, record.currentRunId!)
    expect(opened[0]!.maxTurns).toBe(350)
    await f.service.shutdown()
  })

  it('8 · the configuration accepts 50–1000 turns only', () => {
    const config = defaultExecutorConfig()
    const withTurns = (n: number) => ({
      ...config,
      limits: { ...config.limits, claudeMaxTurns: n },
    })
    expect(parseExecutorConfig(withTurns(50)).limits).toMatchObject({
      claudeMaxTurns: 50,
    })
    expect(parseExecutorConfig(withTurns(1000)).limits).toMatchObject({
      claudeMaxTurns: 1000,
    })
    expect(() => parseExecutorConfig(withTurns(49))).toThrow(
      'EXECUTOR_CONFIG_INVALID',
    )
    expect(() => parseExecutorConfig(withTurns(1001))).toThrow(
      'EXECUTOR_CONFIG_INVALID',
    )
    // Absent means the default; older files stay valid.
    expect(parseExecutorConfig(config).limits).not.toHaveProperty(
      'claudeMaxTurns',
    )
  })
})
