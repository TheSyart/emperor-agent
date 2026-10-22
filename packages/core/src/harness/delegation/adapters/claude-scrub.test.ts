import { afterEach, expect, it } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  Options,
  Query,
  SDKUserMessage,
  WarmQuery,
} from '@anthropic-ai/claude-agent-sdk'
import { ClaudeExecutorAdapter } from './claude'
import { defaultExecutorConfig } from '../config'
import { ExecutorRuntimeService } from '../runtime'
import { delegationTestDirectory } from '../testing'

/**
 * AGT-02 test 9 · the Bash a Claude run starts does not inherit Claude's
 * credentials (since AGT-12 the only one Emperor passes is the user's own
 * API key; Claude.ai sign-ins stay inside claude). A real child process stands in for the CLI: it holds the
 * environment Emperor spawned it with and runs `printenv` the way Claude
 * Code 2.1's Bash tool does, which drops the credential variables when
 * CLAUDE_CODE_SUBPROCESS_ENV_SCRUB is set (the names below are the ones
 * the 2.1.281 binary removes). No real Claude CLI and no account.
 */
const INSTRUMENTED_CLI = `
const { execFileSync } = require('node:child_process')
const truthy = (v) => v !== undefined && /^(1|true|yes|on)$/i.test(String(v).trim())
const scrubbed = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_CUSTOM_HEADERS',
  'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_REFRESH_TOKEN']
const env = { ...process.env }
if (truthy(env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB)) for (const name of scrubbed) delete env[name]
const printed = execFileSync('/bin/sh', ['-c', 'printenv'], { env, encoding: 'utf8' })
const token = process.env.ANTHROPIC_API_KEY
process.stdout.write(JSON.stringify({
  cliHasToken: typeof token === 'string' && token.length > 0,
  scrub: process.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB ?? null,
  bashNamesToken: /^ANTHROPIC_API_KEY=/m.test(printed),
  bashHasValue: !!token && printed.includes(token),
  bashNames: printed.split('\\n').map((l) => l.split('=')[0]).filter(Boolean),
}) + '\\n')
process.stdin.resume()
`
const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach((c) => c()))

it('9 · printenv in the run’s shell has no ANTHROPIC_API_KEY', async () => {
  const f = delegationTestDirectory()
  cleanups.push(f.cleanup)
  const script = join(f.root, 'instrumented-claude.cjs')
  writeFileSync(script, INSTRUMENTED_CLI)
  // An API key in the (temporary) ~/.claude/settings.json.
  mkdirSync(join(f.root, 'home', '.claude'), { recursive: true })
  writeFileSync(
    join(f.root, 'home', '.claude', 'settings.json'),
    JSON.stringify({
      env: { ANTHROPIC_API_KEY: 'sk-ant-api03-fixture-scrub-key-9999' },
    }),
  )
  const profile = {
    ...defaultExecutorConfig().profiles[0]!,
    enabled: true,
  }
  const runtime = await new ExecutorRuntimeService({
    root: join(f.root, 'delegations'),
    home: join(f.root, 'home'),
    environment: { PATH: '/usr/bin:/bin' },
  }).prepare(profile, 'dlg-scrub')
  let report: Promise<Record<string, unknown>> | undefined
  const startup = async (
    opts: Options,
  ): Promise<Pick<WarmQuery, 'query' | 'close'>> => {
    const proc = opts.spawnClaudeCodeProcess!({
      command: process.execPath,
      args: [script],
      cwd: f.root,
      env: {},
      signal: new AbortController().signal,
    })
    report = new Promise((resolve, reject) => {
      let text = ''
      proc.stdout.on('data', (chunk: Buffer) => {
        text += chunk.toString('utf8')
        const line = text.indexOf('\n')
        if (line >= 0) resolve(JSON.parse(text.slice(0, line)))
      })
      proc.on('exit', () => reject(new Error('exited: ' + text)))
    })
    return {
      close: () => proc.stdin.end(),
      query: (prompts: string | AsyncIterable<SDKUserMessage>) =>
        Object.assign(
          (async function* () {
            if (typeof prompts === 'string') return
            for await (const _ of prompts) yield* []
          })(),
          {
            initializationResult: async () => ({ hooks_applied: true }),
            interrupt: async () => undefined,
            close: () => proc.stdin.end(),
          },
        ) as unknown as Query,
    }
  }
  const session = await new ClaudeExecutorAdapter({
    startup,
  }).open({
    delegationId: 'dlg-scrub',
    profile,
    cwd: f.root,
    environment: runtime.environment,
    secretValues: runtime.secretValues,
    runtimeRoot: runtime.runtimeRoot,
    policy: {
      mode: 'workspace-write',
      workspaceRoot: f.root,
      runtimeStateRoots: runtime.stateRoots,
      privateTempRoot: runtime.tempRoot,
    },
    boundaryReceiptId: 'boundary',
    generation: 1,
    signal: new AbortController().signal,
  })
  try {
    const seen = await report!
    // The CLI itself was signed in…
    expect(seen.cliHasToken).toBe(true)
    expect(seen.scrub).toBe('1')
    // …and its shell was not.
    expect(seen.bashNamesToken).toBe(false)
    expect(seen.bashHasValue).toBe(false)
    expect(seen.bashNames).not.toContain('ANTHROPIC_API_KEY')
    expect(seen.bashNames).toContain('HOME')
  } finally {
    await session.close()
  }
})
