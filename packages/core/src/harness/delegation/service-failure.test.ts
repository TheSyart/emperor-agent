/**
 * FIX-15: an external run that fails outside its executor's own report
 * (preparing its workspace, its runtime, opening the process) says why —
 * a failure code the UI and the parent can act on, one Chinese line in the
 * run's summary, and a sanitised line in core.log — instead of a bare
 * EXECUTOR_ERROR with nothing anywhere.
 */
import { afterEach, expect, it } from 'vitest'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fixture, spec } from './service-test-fixture'
import { settlementNotice } from './notices'
import { WorkspaceOperationError } from '../../workspace/common'
import { setCoreLogSink, type LogLine } from '../../util/log'
import { codexModelRejection } from './testing'
import type { NormalizedExecutorEvent } from './types'

const lines: LogLine[] = []
afterEach(() => {
  setCoreLogSink(null)
  lines.length = 0
})
function capture() {
  setCoreLogSink((line) => lines.push(line))
}
const failures = () =>
  lines.filter((line) => line.msg === 'external run failed')

async function failedRun(
  f: ReturnType<typeof fixture>,
  start: Partial<typeof spec> = {},
) {
  const record = await f.service.start(f.owner, { ...spec, ...start })
  const run = await f.service.wait(record.id, record.currentRunId!)
  const state = f.service.inspect(record.id)
  return { record: state.record!, run, state }
}

it('1 · 2 · Git unavailable while preparing: a specific code, the Chinese reason in the summary, and a core.log line', async () => {
  capture()
  const f = fixture()
  f.prepare.mockRejectedValueOnce(
    new WorkspaceOperationError(
      'git_unavailable',
      '当前签名执行环境中没有可用 Git。',
    ),
  )
  try {
    const { record, run } = await failedRun(f)
    expect(run).toMatchObject({
      phase: 'failed',
      failureCode: 'WORKSPACE_GIT_UNAVAILABLE',
      summary: '准备工作区失败：当前签名执行环境中没有可用 Git。',
    })
    expect(failures()).toHaveLength(1)
    expect(failures()[0]).toMatchObject({
      level: 'warn',
      fields: {
        component: 'executors',
        backend: 'codex',
        profileId: record.profileId,
        delegationId: record.id,
        runId: run.id,
        phase: 'preparing',
        stage: 'workspace',
        code: 'git_unavailable',
        failureCode: 'WORKSPACE_GIT_UNAVAILABLE',
        message: '当前签名执行环境中没有可用 Git。',
      },
    })
  } finally {
    await f.service.shutdown()
    f.cleanup()
  }
})

it('2 · a Git command that fails while preparing is WORKSPACE_GIT_FAILED with what Git said', async () => {
  capture()
  const f = fixture()
  f.prepare.mockRejectedValueOnce(
    new WorkspaceOperationError(
      'git_command_failed',
      'fatal: unable to access the index',
    ),
  )
  try {
    const { run } = await failedRun(f)
    expect(run.failureCode).toBe('WORKSPACE_GIT_FAILED')
    expect(run.summary).toBe(
      '准备工作区失败：Git 命令失败：fatal: unable to access the index',
    )
  } finally {
    await f.service.shutdown()
    f.cleanup()
  }
})

it('2 · a file-system error while preparing is WORKSPACE_PREPARE_FAILED; the home folder reads ~', async () => {
  capture()
  const f = fixture()
  const error = Object.assign(
    new Error(
      `EACCES: permission denied, open '${join(homedir(), '.emperor', 'delegations', 'leases', 'x.json')}'`,
    ),
    { code: 'EACCES', syscall: 'open' },
  )
  f.prepare.mockRejectedValueOnce(error)
  try {
    const { run } = await failedRun(f)
    expect(run.failureCode).toBe('WORKSPACE_PREPARE_FAILED')
    expect(run.summary).toBe(
      "准备工作区失败：没有权限（EACCES）：EACCES: permission denied, open '~/.emperor/delegations/leases/x.json'",
    )
    expect(failures()[0]!.fields).toMatchObject({
      stage: 'workspace',
      code: 'EACCES',
      failureCode: 'WORKSPACE_PREPARE_FAILED',
    })
    expect(JSON.stringify(failures()[0])).not.toContain(homedir())
  } finally {
    await f.service.shutdown()
    f.cleanup()
  }
})

it('7 · a runtime failure stays EXECUTOR_ERROR, says where it failed, and never carries a key, the environment or the prompt', async () => {
  capture()
  const f = fixture()
  const secret = 'sk-live-0123456789abcdefghijklmnop'
  f.options.runtime = async () => {
    throw new Error(
      `spawn failed: OPENAI_API_KEY=${secret} Authorization: Bearer ${secret}`,
    )
  }
  try {
    const { record, run } = await failedRun(f, {
      prompt: 'the private task prompt',
    })
    expect(run.failureCode).toBe('EXECUTOR_ERROR')
    expect(run.summary).toMatch(/^准备 Codex 的运行环境失败：spawn failed:/)
    const all = JSON.stringify([run, lines])
    expect(all).not.toContain(secret)
    expect(JSON.stringify(lines)).not.toContain('the private task prompt')
    expect(failures()[0]!.fields).toMatchObject({
      stage: 'runtime',
      failureCode: 'EXECUTOR_ERROR',
      delegationId: record.id,
    })
    expect(failures()[0]!.fields).not.toHaveProperty('environment')
  } finally {
    await f.service.shutdown()
    f.cleanup()
  }
})

it('3 · the notice the parent receives names the failure and its reason', async () => {
  capture()
  const f = fixture()
  f.prepare.mockRejectedValueOnce(
    new WorkspaceOperationError(
      'git_unavailable',
      '当前签名执行环境中没有可用 Git。',
    ),
  )
  try {
    const { record, run, state } = await failedRun(f)
    const notice = Object.values(state.outbox).find((n) => n.runId === run.id)
    expect(notice?.text).toContain(
      'execution=failed (WORKSPACE_GIT_UNAVAILABLE)',
    )
    expect(notice?.text).toContain(
      '准备工作区失败：当前签名执行环境中没有可用 Git。',
    )
    expect(settlementNotice(record, run).text).toBe(notice?.text)
  } finally {
    await f.service.shutdown()
    f.cleanup()
  }
})

it('a DelegationError keeps its own code and is logged as a stop, not as an unexplained failure', async () => {
  capture()
  const f = fixture()
  const { DelegationError } = await import('./types')
  f.prepare.mockRejectedValueOnce(
    new DelegationError('COPY_LIMIT', 'more than 10000 files to copy'),
  )
  try {
    const { run } = await failedRun(f)
    expect(run.failureCode).toBe('COPY_LIMIT')
    expect(failures()).toHaveLength(0)
    expect(
      lines.find((line) => line.msg === 'external run stopped')?.fields,
    ).toMatchObject({ code: 'COPY_LIMIT', stage: 'workspace' })
  } finally {
    await f.service.shutdown()
    f.cleanup()
  }
})

it.each([
  [
    new WorkspaceOperationError(
      'git_command_failed',
      'spawn /usr/bin/git EMFILE',
    ),
    'WORKSPACE_GIT_FAILED',
    '准备工作区失败：Git 命令失败：打开的文件太多（EMFILE）：spawn /usr/bin/git EMFILE',
  ],
  [
    Object.assign(new Error('spawn /usr/bin/git EAGAIN'), {
      code: 'EAGAIN',
      syscall: 'spawn /usr/bin/git',
    }),
    'WORKSPACE_PREPARE_FAILED',
    '准备工作区失败：系统暂时无法启动新进程（EAGAIN）：spawn /usr/bin/git EAGAIN',
  ],
])(
  '1 · a spawn that runs out of files or processes says so in Chinese (%#)',
  async (error, failureCode, summary) => {
    capture()
    const f = fixture()
    f.prepare.mockRejectedValueOnce(error)
    try {
      const { run } = await failedRun(f)
      expect(run).toMatchObject({ failureCode, summary })
    } finally {
      await f.service.shutdown()
      f.cleanup()
    }
  },
)

// FIX-16: a failed turn the executor reported says why. An empty text used
// to hide its error (every Codex run of the user's ended with `text: ""`
// and a 400 about the model); now the readable reason opens the summary.

const REASON =
  'Codex 不支持模型 gpt-6.1-sol（ChatGPT 账号登录）。请在「设置 › 子智能体 › Codex › 默认模型」里换一个可用的模型。'

function scripted(
  events: (base: {
    delegationId: string
    runId: string
    generation: number
  }) => NormalizedExecutorEvent[],
) {
  return fixture(async function* (turn, open) {
    yield* events({
      delegationId: open.delegationId,
      runId: turn.runId,
      generation: open.generation,
    })
  })
}

async function settle(f: ReturnType<typeof fixture>) {
  try {
    const { record, run, state } = await failedRun(f)
    return {
      record,
      run,
      notice: Object.values(state.outbox).find((n) => n.runId === run.id),
    }
  } finally {
    await f.service.shutdown()
    f.cleanup()
  }
}

it('FIX-16 · 1 · 7 · an empty text no longer hides the error: the summary and the parent’s notice carry its readable reason', async () => {
  const f = scripted((base) => [
    {
      type: 'turn_finished',
      status: 'failed',
      text: '  ',
      error:
        '{"type":"error","status":500,"error":{"type":"server_error","message":"The server had an error"}}',
      ...base,
    },
  ])
  const { run, notice, record } = await settle(f)
  const reason =
    'Codex 这一轮失败：服务暂时出错（HTTP 500，server_error）：The server had an error'
  expect(run).toMatchObject({
    phase: 'failed',
    failureCode: 'EXECUTOR_TURN_FAILED',
    summary: reason,
  })
  expect(notice?.text).toContain('execution=failed (EXECUTOR_TURN_FAILED)')
  expect(notice?.text).toContain(reason)
  expect(settlementNotice(record, run).text).toBe(notice?.text)
})

it('FIX-16 · 2 · 7 · the user’s 400 is EXECUTOR_MODEL_UNSUPPORTED, naming the model and where to change it', async () => {
  const f = scripted((base) => [
    {
      type: 'runtime_metadata',
      source: 'thread-configuration',
      model: 'gpt-6.1-sol',
      provider: 'openai',
      ...base,
    },
    {
      type: 'turn_finished',
      status: 'failed',
      text: '',
      error: codexModelRejection('gpt-6.1-sol'),
      ...base,
    },
  ])
  const { run, notice } = await settle(f)
  expect(run).toMatchObject({
    phase: 'failed',
    failureCode: 'EXECUTOR_MODEL_UNSUPPORTED',
    summary: REASON,
  })
  expect(notice?.text).toContain(
    'execution=failed (EXECUTOR_MODEL_UNSUPPORTED)',
  )
  expect(notice?.text).toContain(REASON)
})

it('FIX-16 · 1 · what the subagent wrote before failing follows the reason', async () => {
  const f = scripted((base) => [
    {
      type: 'turn_finished',
      status: 'failed',
      text: 'Read the files; started the review.',
      error: 'stream disconnected before completion',
      ...base,
    },
  ])
  const { run } = await settle(f)
  expect(run.summary).toBe(
    'Codex 这一轮失败：stream disconnected before completion\n\nRead the files; started the review.',
  )
})
