// @vitest-environment jsdom
import { createApp, h, nextTick, type App } from 'vue'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { VersionFailureContext } from '@emperor/core/runtime-contract'
import VersionFailureActions from './VersionFailureActions.vue'
import {
  resetExecutorUpgrades,
  useExecutorUpgrades,
} from '../settings/executors/executorUpgrades'

// VER-06 · 7: the failure card's buttons. 退回 and 装 x（已验证） open the
// confirmation in 设置 › 子智能体 (they never run anything here); 打开设置
// goes to the executor's page; 重新检查 runs the self-check.

const { core, push, onCoreEvent } = vi.hoisted(() => ({
  core: vi.fn(),
  push: vi.fn(async () => undefined),
  onCoreEvent: vi.fn(() => () => undefined),
}))
vi.mock('../../api/http', () => ({ core }))
vi.mock('../../api/backend', () => ({ onCoreEvent }))
vi.mock('../ui/toasts', () => ({ pushToast: vi.fn() }))
vi.mock('vue-router', () => ({
  useRoute: () => ({ path: '/chat/root', query: {} }),
  useRouter: () => ({ push, replace: push }),
}))

const context = (
  over: Partial<VersionFailureContext> = {},
): VersionFailureContext => ({
  backend: 'claude-code',
  profileId: 'claude-default',
  current: '2.1.315',
  lastGood: '2.1.310',
  verifiedMax: '2.1.310',
  reason: 'Claude Code 2.1.315 自检不兼容：Claude Code 加载了 MCP server：x',
  actions: ['rollback', 'open_settings', 'recheck'],
  ...over,
})

let app: App | undefined, root: HTMLDivElement
async function settle() {
  for (let i = 0; i < 20; i++) await Promise.resolve()
  await nextTick()
}
async function mount(value: VersionFailureContext) {
  root = document.createElement('div')
  document.body.append(root)
  app = createApp({
    render: () => h(VersionFailureActions, { context: value }),
  })
  app.mount(root)
  await settle()
  return root
}
const button = (label: string) =>
  [...root.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === label,
  )!

beforeEach(() => {
  resetExecutorUpgrades()
  core.mockImplementation(async (operation: string) => {
    if (operation === 'executors.versions')
      return {
        checkedAt: null,
        checking: false,
        error: null,
        executors: [],
        upgrades: [],
        dismissed: false,
      }
    if (operation === 'executors.selfCheck') return { selfCheck: {} }
    return null
  })
})
afterEach(() => {
  app?.unmount()
  root?.remove()
  vi.clearAllMocks()
})

it('the line and the buttons of the approved card', async () => {
  const dom = await mount(context())
  expect(dom.querySelector('[data-version-failure-reason]')!.textContent).toBe(
    'Claude Code 2.1.315 自检不兼容：Claude Code 加载了 MCP server：x。上次正常的版本：2.1.310。',
  )
  expect(
    [...dom.querySelectorAll('button')].map((b) => b.textContent?.trim()),
  ).toEqual(['退回 2.1.310', '打开设置', '重新检查'])
})

it('7 · 退回 opens the confirmation in 设置 › 子智能体; nothing runs here', async () => {
  await mount(context())
  button('退回 2.1.310').click()
  await settle()
  expect(useExecutorUpgrades().askingRollback.value).toBe('claude-default')
  expect(push).toHaveBeenCalledWith({
    path: '/chat/root',
    query: { settings: 'executors', page: 'claude-code' },
  })
  expect(core.mock.calls.map(([op]) => op)).not.toContain('executors.rollback')
})

it('装 x（已验证） opens the upgrade confirmation; 打开设置 the executor page; 重新检查 checks now', async () => {
  await mount(
    context({
      current: '2.1.200',
      lastGood: undefined,
      actions: ['install_verified', 'open_settings', 'recheck'],
    }),
  )
  button('装 2.1.310（已验证）').click()
  await settle()
  expect(useExecutorUpgrades().asking.value).toEqual(['claude-default'])
  expect(core.mock.calls.map(([op]) => op)).not.toContain('executors.upgrade')
  push.mockClear()
  button('打开设置').click()
  await settle()
  expect(push).toHaveBeenCalledWith({
    path: '/chat/root',
    query: { settings: 'executors', page: 'claude-code' },
  })
  button('重新检查').click()
  await settle()
  expect(core).toHaveBeenCalledWith('executors.selfCheck', {
    profileId: 'claude-default',
  })
})
