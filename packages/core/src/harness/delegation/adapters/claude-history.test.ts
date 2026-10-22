import { afterEach, expect, it } from 'vitest'
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ClaudeExecutorAdapter } from './claude'
import { readClaudeSessionHistory } from './claude-history'
import { ManagedAgentProcess } from '../process'
import { defaultExecutorConfig } from '../config'
import { DelegationError, type ExecutorOpenInput } from '../types'

const SESSION = '11111111-2222-4333-8444-555555555555'
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

/** A Claude Code config dir holding one transcript, the way the CLI writes it. */
function transcript(turns = 2): { configDir: string; cwd: string } {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), 'emperor-claude-history-')),
  )
  roots.push(root)
  const cwd = join(root, 'work')
  const configDir = join(root, 'config')
  const project = join(configDir, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))
  mkdirSync(cwd)
  mkdirSync(project, { recursive: true })
  const lines: string[] = []
  let parent: string | null = null
  for (let i = 0; i < turns; i++) {
    const uuid = `aaaaaaaa-0000-4000-8000-${String(i + 1).padStart(12, '0')}`
    const base = {
      uuid,
      parentUuid: parent,
      sessionId: SESSION,
      cwd,
      isSidechain: false,
      userType: 'external',
      version: '2.1.281',
      timestamp: new Date(Date.UTC(2026, 9, 19, 0, 0, i)).toISOString(),
    }
    lines.push(
      JSON.stringify(
        i % 2 === 0
          ? {
              ...base,
              type: 'user',
              message: { role: 'user', content: `question ${i}` },
            }
          : {
              ...base,
              type: 'assistant',
              message: {
                id: `msg_${i}`,
                type: 'message',
                role: 'assistant',
                model: 'x',
                content: [{ type: 'text', text: `answer ${i}` }],
              },
            },
      ),
    )
    parent = uuid
  }
  writeFileSync(join(project, `${SESSION}.jsonl`), lines.join('\n') + '\n')
  return { configDir, cwd }
}

const sdkUrl = pathToFileURL(
  createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk'),
).href

it('reads the native history in a worker with the delegation environment, not the host one', async () => {
  const { configDir, cwd } = transcript()
  const before = process.env.CLAUDE_CONFIG_DIR
  const history = await readClaudeSessionHistory({
    sdkUrl,
    sessionId: SESSION,
    cwd,
    env: { CLAUDE_CONFIG_DIR: configDir, HOME: cwd },
  })
  expect(history).toEqual({
    sessionId: SESSION,
    nativeStatus: 'unknown',
    turns: [
      {
        id: 'aaaaaaaa-0000-4000-8000-000000000001',
        status: 'user',
        text: 'question 0',
      },
      {
        id: 'aaaaaaaa-0000-4000-8000-000000000002',
        status: 'assistant',
        text: 'answer 1',
      },
    ],
  })
  // The SDK memoizes its config dir; the host must never see the delegation's.
  expect(process.env.CLAUDE_CONFIG_DIR).toBe(before)
})

it('keeps the last 20 turns', async () => {
  const { configDir, cwd } = transcript(25)
  const history = await readClaudeSessionHistory({
    sdkUrl,
    sessionId: SESSION,
    cwd,
    env: { CLAUDE_CONFIG_DIR: configDir },
  })
  expect(history.turns).toHaveLength(20)
  expect(history.turns[0]!.text).toBe('answer 5')
  expect(history.turns.at(-1)!.text).toBe('question 24')
})

it('reports a history it cannot read as unavailable', async () => {
  const { cwd } = transcript()
  await expect(
    readClaudeSessionHistory({
      sdkUrl: 'file:///nonexistent/claude-agent-sdk/sdk.mjs',
      sessionId: SESSION,
      cwd,
      env: {},
    }),
  ).rejects.toMatchObject({ code: 'HISTORY_UNAVAILABLE' })
})

it('stops the reader when the inspection is aborted', async () => {
  const { configDir, cwd } = transcript()
  const controller = new AbortController()
  controller.abort()
  await expect(
    readClaudeSessionHistory({
      sdkUrl,
      sessionId: SESSION,
      cwd,
      env: { CLAUDE_CONFIG_DIR: configDir },
      signal: controller.signal,
    }),
  ).rejects.toBeInstanceOf(DelegationError)
})

it('inspects without starting the app binary as Node (the RunAsNode fuse is off, SEC-04)', async () => {
  const { configDir, cwd } = transcript()
  class NoProcesses extends ManagedAgentProcess {
    override async open(): Promise<never> {
      throw new Error('inspect must not spawn process.execPath')
    }
    override spawn(): never {
      throw new Error('inspect must not spawn process.execPath')
    }
  }
  const adapter = new ClaudeExecutorAdapter({
    processes: new NoProcesses(),
    sdkUrl: () => sdkUrl,
  })
  const profile = defaultExecutorConfig().profiles.find(
    (item) => item.backend === 'claude-code',
  )!
  const history = await adapter.inspect({
    delegationId: 'dg-1',
    profile,
    cwd,
    environment: { CLAUDE_CONFIG_DIR: configDir },
    runtimeRoot: cwd,
    resumeSessionId: SESSION,
    generation: 1,
    boundaryReceiptId: 'dgb-1',
    signal: new AbortController().signal,
    policy: { mode: 'read-only', workspaceRoot: cwd },
  } as unknown as ExecutorOpenInput)
  expect(history.turns.map((turn) => turn.text)).toEqual([
    'question 0',
    'answer 1',
  ])
})
