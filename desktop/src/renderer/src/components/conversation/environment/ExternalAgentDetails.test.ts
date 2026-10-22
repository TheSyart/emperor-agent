// @vitest-environment jsdom
import { createApp, h, nextTick, type App } from 'vue'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import ExternalAgentDetails from './ExternalAgentDetails.vue'
const api = vi.hoisted(() => ({
  getDelegation: vi.fn(),
  getDelegationReceipt: vi.fn(),
  sendDelegationMessage: vi.fn(),
  interruptDelegation: vi.fn(),
  recoverDelegation: vi.fn(),
  collectDelegation: vi.fn(),
  validateDelegation: vi.fn(),
  integrateDelegation: vi.fn(),
  closeDelegation: vi.fn(),
  abandonDelegation: vi.fn(),
  listExecutors: vi.fn(),
  core: vi.fn(),
}))
vi.mock('../../../api/delegations', () => api)
vi.mock('../../../api/http', () => ({ core: api.core }))
vi.mock('../../../api/backend', () => ({ onCoreEvent: () => () => {} }))
let app: App | undefined, root: HTMLDivElement
const configure = vi.fn()
function state(backend = 'claude-code', phase = 'completed') {
  return {
    record: {
      id: 'dlg-one',
      backend,
      profileId: 'profile',
      cwd: '/retained/worktree',
      owner: { rootSessionId: 'root' },
      currentRunId: 'dgr-one',
      availability: 'idle',
      capabilitySnapshot: {
        steer: backend === 'codex',
        queuedFollowup: true,
        interrupt: true,
      },
    },
    runs: {
      'dgr-one': {
        id: 'dgr-one',
        revision: 3,
        phase,
        acceptance: 'unverified',
        summary: 'native finished',
      },
    },
  }
}
async function settle() {
  for (let i = 0; i < 16; i++) await Promise.resolve()
  await nextTick()
}
async function mount() {
  root = document.createElement('div')
  document.body.append(root)
  app = createApp({
    render: () =>
      h(ExternalAgentDetails, {
        runId: 'dgr-one',
        delegationId: 'dlg-one',
        sessionId: 'root',
        onConfigure: configure,
      }),
  })
  app.mount(root)
  await settle()
  return document.body
}
beforeEach(() => {
  api.listExecutors.mockResolvedValue({ config: {}, profiles: [] })
  api.getDelegation.mockResolvedValue(state())
  api.getDelegationReceipt.mockResolvedValue({
    receipt: null,
    acceptance: null,
    preview: null,
    verificationActive: false,
    verificationRecoveryIds: [],
  })
  api.sendDelegationMessage.mockResolvedValue({
    state: 'queued',
    messageId: 'dgm-next',
  })
  api.core.mockResolvedValue({
    entries: [
      { role: 'assistant', content: '<img src=x onerror=alert(1)>' },
      { role: 'assistant', content: 'sum' },
      { role: 'assistant', content: '.m' },
      { role: 'assistant', content: 'js' },
    ],
    eof: false,
    total: 501,
  })
})
afterEach(() => {
  app?.unmount()
  root?.remove()
  document.body.innerHTML = ''
  vi.clearAllMocks()
})
it('shows completed execution without an artifact warning before collection and hides unsupported Claude steer', async () => {
  const dom = await mount()
  expect(dom.textContent).toContain('本轮执行完成')
  expect(dom.textContent).not.toContain('未验证')
  expect(dom.querySelector('[data-steer]')).toBeNull()
})
it('collects text-only results without file acceptance or integration controls', async () => {
  api.getDelegationReceipt.mockResolvedValue({
    receipt: { id: 'drr-text', changedFiles: [], unresolved: [], excluded: [] },
    acceptance: null,
    preview: null,
  })
  const dom = await mount()
  expect(dom.textContent).toContain('结果已返回')
  expect(dom.querySelector('[data-acceptance]')).toBeNull()
  expect(dom.textContent).not.toContain('独立验证当前成果')
  expect(dom.textContent).not.toContain('生成整合预览')
})
it('shows delivery checks for changed files without marking them passed', async () => {
  api.getDelegationReceipt.mockResolvedValue({
    receipt: {
      id: 'drr-code',
      changedFiles: [{ path: 'main.ts', status: 'modified' }],
      unresolved: [],
      excluded: [],
    },
    acceptance: null,
    preview: null,
  })
  const dom = await mount()
  expect(dom.querySelector('[data-acceptance]')?.textContent).toBe(
    '交付前待检查',
  )
  expect(dom.textContent).toContain('独立验证当前成果')
})
it('keeps excluded writable output visible as a file delivery', async () => {
  api.getDelegationReceipt.mockResolvedValue({
    receipt: {
      id: 'drr-excluded',
      changedFiles: [],
      unresolved: [],
      excluded: [{ path: 'ignored', reason: 'ignored' }],
    },
    requiresAcceptance: true,
    acceptance: null,
    preview: null,
  })
  const dom = await mount()
  expect(dom.querySelector('[data-text-result]')).toBeNull()
  expect(dom.textContent).toContain('ignored')
  expect(dom.textContent).toContain('独立验证当前成果')
})
it('retains the retry-check form for a previous failed text check', async () => {
  api.getDelegationReceipt.mockResolvedValue({
    receipt: { id: 'drr-text', changedFiles: [], unresolved: [], excluded: [] },
    requiresAcceptance: false,
    acceptance: { state: 'failed', evidence: [] },
    preview: null,
  })
  const dom = await mount()
  expect(dom.textContent).toContain('验证失败')
  expect(dom.textContent).toContain('独立验证当前成果')
  expect(dom.textContent).not.toContain('生成整合预览')
})
it('keeps continuation and steer inputs out of task details and routes followup through the root', async () => {
  api.getDelegation.mockResolvedValue(state('codex', 'running'))
  const dom = await mount()
  expect(dom.querySelector('[data-followup]')).toBeNull()
  expect(dom.querySelector('[data-send]')).toBeNull()
  expect(dom.querySelector('[data-steer]')).toBeNull()
  expect(dom.textContent).toContain('主会话')
  expect(api.sendDelegationMessage).not.toHaveBeenCalled()
})
it('offers 标记为已结束 for a run without an outcome, instead of sending the user back to the root', async () => {
  const paused = state('codex', 'outcome_unknown')
  Object.assign(paused.record, {
    availability: 'needs_recovery',
    dispatchPaused: true,
  })
  api.getDelegation.mockResolvedValue(paused)
  api.abandonDelegation.mockResolvedValue(paused.record)
  const dom = await mount()
  expect(dom.textContent).toContain('结果待确认')
  expect(dom.textContent).not.toContain('恢复调度')
  expect(dom.textContent).not.toContain('请返回主会话处理')
  const end = dom.querySelector<HTMLButtonElement>('[data-abandon-run]')!
  expect(end.textContent).toContain('标记为已结束')
  end.click()
  await settle()
  expect(api.abandonDelegation).toHaveBeenCalledWith({
    id: 'dlg-one',
    sessionId: 'root',
  })
  expect(api.recoverDelegation).not.toHaveBeenCalled()
})
it('does not offer 标记为已结束 for a run that settled normally', async () => {
  const dom = await mount()
  expect(dom.querySelector('[data-abandon-run]')).toBeNull()
})
it('shows passed host evidence and preserves a conflicting integration preview without an apply action', async () => {
  api.getDelegationReceipt.mockResolvedValue({
    receipt: {
      id: 'drr-one',
      version: '0.153.4',
      resultTreeDigest: 'abc',
      changedFiles: [{ path: 'image.bin', status: 'added', binary: true }],
      excluded: [],
      unresolved: [],
    },
    acceptance: {
      id: 'dar-one',
      state: 'passed',
      evidence: [
        {
          source: 'host-verified',
          exitCode: 0,
          treeDigest: 'abc',
          argv: ['node', 'test'],
          cwd: '/retained/worktree',
          quiescent: true,
        },
      ],
    },
    preview: {
      id: 'dpi-one',
      status: 'needs_user',
      reason: 'MERGE_CONFLICT',
      cwd: '/retained/integration',
      target: {
        cwd: '/original/project',
        head: 'original-head',
        indexDigest: 'original-index',
        treeDigest: 'original-tree',
      },
      treeDigest: 'merged-tree',
      revision: 1,
      verificationId: 'dar-preview',
      operations: [
        {
          path: 'image.bin',
          before: { sha256: 'before' },
          after: { sha256: 'after' },
        },
      ],
      conflicts: ['image.bin'],
    },
    verificationActive: false,
    verificationRecoveryIds: [],
  })
  const dom = await mount()
  expect(dom.textContent).toContain('验证通过')
  expect(dom.textContent).toContain('/retained/integration')
  expect(dom.textContent).toContain('/original/project')
  expect(dom.textContent).toContain('merged-tree')
  expect(dom.textContent).toContain('original-head')
  expect(dom.textContent).toContain('image.bin')
  expect(dom.querySelector('[data-apply]')).toBeNull()
})
it('opens paged output as escaped text and leaves more output available', async () => {
  const dom = await mount()
  dom.querySelector<HTMLButtonElement>('[data-open-output]')!.click()
  await settle()
  expect(dom.querySelector('[data-task-output]')?.textContent).toContain(
    '<img src=x',
  )
  expect(dom.querySelector('[data-task-output]')?.textContent).toContain(
    'sum.mjs',
  )
  expect(dom.querySelector('img')).toBeNull()
  expect(dom.textContent).toContain('加载更多')
})

it('offers configuration on real authentication failure without retrying through another billing route', async () => {
  const failed = {
    ...state('codex', 'failed'),
    runs: {
      'dgr-one': {
        ...state('codex', 'failed').runs['dgr-one'],
        failureCode: 'AUTH_REQUIRED',
      },
    },
  }
  api.getDelegation.mockResolvedValue(failed)
  const dom = await mount(),
    button = [...dom.querySelectorAll<HTMLButtonElement>('button')].find(
      (item) => item.textContent?.includes('打开子智能体设置'),
    )
  expect(button).toBeTruthy()
  button!.click()
  await settle()
  expect(configure).toHaveBeenCalledOnce()
  expect(api.sendDelegationMessage).not.toHaveBeenCalled()
})

// AGT-07: the cost line says how the run is paid, with the ledger's number.
function withRun(patch: Record<string, unknown>) {
  const s = state()
  Object.assign(s.runs['dgr-one'], patch)
  api.getDelegation.mockResolvedValue(s)
}
it('7 · a subscription run reads 订阅额度，不计费用, not a dollar figure', async () => {
  withRun({
    usage: {
      inputTokens: 1200,
      outputTokens: 300,
      nominalUsd: 12.5,
      billing: 'subscription',
    },
  })
  const body = await mount()
  const line = body.querySelector('[data-run-usage]')!
  expect(line.textContent).toContain('订阅额度，不计费用')
  expect(line.textContent).not.toContain('$')
})
it('7 · an API run shows the same estimate the budget counted', async () => {
  withRun({
    usage: {
      inputTokens: 1200,
      outputTokens: 300,
      estimatedUsd: 1.2345,
      billing: 'api',
    },
  })
  const body = await mount()
  expect(body.querySelector('[data-run-usage]')!.textContent).toContain(
    '估算 $1.2345',
  )
})
it('names the task limits a run stopped at', async () => {
  withRun({ phase: 'failed', failureCode: 'TOKEN_LIMIT' })
  const body = await mount()
  expect(body.textContent).toContain('已达到单任务 token 上限')
  withRun({ phase: 'failed', failureCode: 'BUDGET_LIMIT' })
  app?.unmount()
  root.remove()
  const again = await mount()
  expect(again.textContent).toContain('已达到单任务费用上限')
})
it('keeps the receipt, check and preview chain out of sight by default (AGT-06)', async () => {
  const dom = await mount()
  expect(dom.textContent).not.toContain('文件交付与检查')
  expect(dom.textContent).not.toContain('收集成果')
  expect(dom.textContent).not.toContain('生成整合预览')
})
it('shows the chain again under 高级 › 验证后再应用 (AGT-06)', async () => {
  api.listExecutors.mockResolvedValue({
    config: { verifyBeforeApply: true },
    profiles: [],
  })
  const dom = await mount()
  expect(dom.textContent).toContain('文件交付与检查')
  expect(dom.textContent).toContain('收集成果')
})

// AGT-02: Claude's failures arrive with a code; the details say the reason
// in Chinese and what to do next.
async function failedWith(code: string) {
  app?.unmount()
  root?.remove()
  withRun({ phase: 'failed', failureCode: code, summary: 'API Error' })
  const body = await mount()
  const note = body.querySelector<HTMLElement>('[data-failure-code]')!
  const configureButton = [
    ...body.querySelectorAll<HTMLButtonElement>('button'),
  ].find((b) => b.textContent?.includes('打开子智能体设置'))
  return { note, configureButton }
}
it('6 · AUTH_EXPIRED says the sign-in expired and how to sign in again', async () => {
  const { note, configureButton } = await failedWith('AUTH_EXPIRED')
  expect(note.dataset.failureCode).toBe('AUTH_EXPIRED')
  expect(note.textContent).toContain('登录已失效或过期')
  expect(note.textContent).toContain('「登录 Claude Code」')
  expect(note.textContent).toContain('API Key')
  expect(note.textContent).not.toMatch(/setup-token|设置令牌/)
  expect(configureButton).toBeTruthy()
})
it('7 · RATE_LIMITED says it hit a rate or usage limit and to wait', async () => {
  const { note } = await failedWith('RATE_LIMITED')
  expect(note.textContent).toContain('限流')
  expect(note.textContent).toContain('稍后')
})
it('8 · MAX_TURNS names the limit and where to raise it', async () => {
  const { note, configureButton } = await failedWith('MAX_TURNS')
  expect(note.textContent).toContain('最多轮数')
  expect(note.textContent).toContain('设置 › 子智能体 › 高级')
  expect(configureButton).toBeTruthy()
})
it.each([
  ['BILLING', '余额'],
  ['CONTEXT_OVERFLOW', '上下文'],
  ['EXECUTOR_TURN_FAILED', '执行失败'],
])('names %s in Chinese with a next step', async (code, text) => {
  const { note } = await failedWith(code)
  expect(note.textContent).toContain(text)
  expect(note.querySelector('[data-failure-next]')!.textContent).not.toBe('')
})

// FIX-15: a run that failed outside its executor's report names what failed
// in Chinese, what to do next, and shows Core's reason as 原因, not as the
// subagent's report.
it.each([
  ['WORKSPACE_GIT_UNAVAILABLE', '没有可用的 Git'],
  ['WORKSPACE_GIT_FAILED', 'Git 命令失败'],
  ['WORKSPACE_PREPARE_FAILED', '准备工作区失败'],
  ['EXECUTOR_ERROR', '意外出错'],
])(
  '4 · %s reads in Chinese with a next step and the reason',
  async (code, text) => {
    app?.unmount()
    root?.remove()
    withRun({
      phase: 'failed',
      failureCode: code,
      summary: '准备工作区失败：当前签名执行环境中没有可用 Git。',
    })
    const body = await mount()
    const note = body.querySelector<HTMLElement>('[data-failure-code]')!
    expect(note.dataset.failureCode).toBe(code)
    expect(note.textContent).toContain(text)
    expect(note.textContent).not.toContain(code)
    expect(note.querySelector('[data-failure-next]')!.textContent).not.toBe('')
    const reason = body.querySelector<HTMLElement>('[data-run-reason]')!
    expect(reason.textContent?.trim()).toBe(
      '原因：准备工作区失败：当前签名执行环境中没有可用 Git。',
    )
    expect(body.textContent).not.toContain('子智能体报告：准备工作区失败')
  },
)
