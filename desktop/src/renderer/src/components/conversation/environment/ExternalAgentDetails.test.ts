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
it('separates native completion from unverified delivery and hides unsupported Claude steer', async () => {
  const dom = await mount()
  expect(dom.textContent).toContain('本轮执行完成')
  expect(dom.textContent).toContain('未验证')
  expect(dom.querySelector('[data-steer]')).toBeNull()
})
it('sends a queued followup once and refreshes stale clicks without automatically resending', async () => {
  const dom = await mount(),
    input = dom.querySelector<HTMLTextAreaElement>('[data-followup]')!
  input.value = 'make the correction'
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await settle()
  api.sendDelegationMessage.mockRejectedValue(new Error('STALE_RUN: changed'))
  const button = dom.querySelector<HTMLButtonElement>('[data-send]')!
  button.click()
  button.click()
  await settle()
  expect(api.sendDelegationMessage).toHaveBeenCalledTimes(1)
  expect(api.sendDelegationMessage.mock.calls[0]?.[0]).toMatchObject({
    id: 'dlg-one',
    delivery: 'queue',
    text: 'make the correction',
  })
  expect(api.getDelegation).toHaveBeenCalledTimes(2)
  expect(dom.textContent).toContain('STALE_RUN')
})
it('offers Codex steer only for the current running native turn', async () => {
  api.getDelegation.mockResolvedValue(state('codex', 'running'))
  const dom = await mount()
  expect(dom.querySelector('[data-steer]')).not.toBeNull()
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
  expect(dom.textContent).toContain('验收通过')
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
      (item) => item.textContent?.includes('打开执行器设置'),
    )
  expect(button).toBeTruthy()
  button!.click()
  await settle()
  expect(configure).toHaveBeenCalledOnce()
  expect(api.sendDelegationMessage).not.toHaveBeenCalled()
})
