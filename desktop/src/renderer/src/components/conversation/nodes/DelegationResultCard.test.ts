// @vitest-environment jsdom
/**
 * AGT-06 card tests 4–6 and 12 in the conversation: 「Codex 改了 N 个文件
 * +A −D · 查看差异 · 应用到项目 · 丢弃」, conflicts, undo after applying, and
 * the cleanup prompt for a result left alone for 14 days.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick } from 'vue'
import type { DelegationResultChatData } from '../../../conversation/types'

const { delegations, confirm } = vi.hoisted(() => ({
  delegations: {
    applyDelegationResult: vi.fn(),
    discardDelegationResult: vi.fn(),
    undoDelegationResult: vi.fn(),
    delegationResultDiff: vi.fn(),
  },
  confirm: vi.fn(async () => true),
}))
vi.mock('../../../api/delegations', () => delegations)
vi.mock('../../ui/confirm', () => ({ confirm }))

import { createExpansionStore, provideChatContext } from '../chatContext'
import DelegationResultCard from './DelegationResultCard.vue'

const DAY = 86_400_000
let container: HTMLDivElement | null = null

beforeEach(() => {
  for (const fn of Object.values(delegations)) fn.mockReset()
  confirm.mockClear()
})
afterEach(() => {
  container?.remove()
  container = null
  document.body.innerHTML = ''
})

const files: DelegationResultChatData['files'] = [
  { path: 'src/login/form.ts', status: 'modified', additions: 4, deletions: 1 },
  {
    path: 'src/login/form.test.ts',
    status: 'added',
    additions: 3,
    deletions: 0,
  },
  { path: 'docs/old.md', status: 'deleted', additions: 0, deletions: 0 },
  {
    path: 'logo.png',
    status: 'added',
    additions: null,
    deletions: null,
    binary: true,
  },
]

function data(
  patch: Partial<DelegationResultChatData> = {},
): DelegationResultChatData {
  return {
    delegationId: 'dlg-one',
    runId: 'dgr-one',
    backend: 'codex',
    title: '重构登录页',
    state: 'ready',
    files,
    totals: { files: 4, additions: 7, deletions: 1 },
    truncated: false,
    conflicts: [],
    at: Date.now() - 60_000,
    undoable: false,
    verifyFirst: false,
    ...patch,
  }
}

function mount(value: DelegationResultChatData): HTMLDivElement {
  container = document.createElement('div')
  document.body.appendChild(container)
  const Host = defineComponent({
    setup() {
      provideChatContext({
        actions: {
          inspect: () => undefined,
          openSubagent: () => undefined,
          editMessage: () => undefined,
        },
        expansion: createExpansionStore(),
        sessionId: () => 'child',
        rootSessionId: () => 'root',
      })
      return () =>
        h(DelegationResultCard, {
          node: {
            key: 'delegationResult:dlg-one',
            kind: 'delegationResult',
            id: 'dlg-one',
            target: 'chat',
            anchorSeq: 12,
            visibility: 'visible',
            turn: null,
            step: null,
            data: value,
          },
        })
    },
  })
  createApp(Host).mount(container)
  return container
}

async function flush() {
  for (let index = 0; index < 4; index += 1) {
    await Promise.resolve()
    await nextTick()
  }
}
const action = (root: HTMLElement, name: string) =>
  root.querySelector<HTMLButtonElement>(`[data-action="${name}"]`)

describe('DelegationResultCard', () => {
  it('4 · sums up what the subagent changed, like the turn files card', () => {
    const root = mount(data())
    expect(root.querySelector('.headline')?.textContent?.trim()).toBe(
      'Codex 改了 4 个文件',
    )
    expect(root.querySelector('.head .add')?.textContent).toBe('+7')
    expect(root.querySelector('.head .del')?.textContent).toBe('−1')
    expect(
      [...root.querySelectorAll('.file .name')].map((el) => el.textContent),
    ).toEqual(['form.ts', 'form.test.ts', 'old.md'])
    expect(root.querySelector('.more')?.textContent).toContain(
      '再显示 1 个文件',
    )
    expect(action(root, 'apply')?.textContent?.trim()).toBe('应用到项目')
    expect(action(root, 'apply')?.dataset.variant).toBe('primary')
    expect(action(root, 'diff')?.textContent?.trim()).toBe('查看差异')
    expect(action(root, 'discard')?.textContent?.trim()).toBe('丢弃')
    expect(root.querySelector('[data-result-cleanup]')).toBeNull()
  })

  it('5 · 应用到项目 applies it for the owning conversation', async () => {
    delegations.applyDelegationResult.mockResolvedValue({ state: 'applied' })
    const root = mount(data())
    action(root, 'apply')!.click()
    await flush()
    expect(delegations.applyDelegationResult).toHaveBeenCalledWith({
      runId: 'dgr-one',
      sessionId: 'root',
    })
  })

  it('5 · an applied result can be undone, after asking', async () => {
    delegations.undoDelegationResult.mockResolvedValue({ state: 'reverted' })
    const root = mount(data({ state: 'applied', by: 'user', undoable: true }))
    expect(root.textContent).toContain('已应用到项目')
    expect(action(root, 'apply')).toBeNull()
    action(root, 'undo')!.click()
    await flush()
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ title: '撤销应用的改动？' }),
    )
    expect(delegations.undoDelegationResult).toHaveBeenCalledWith({
      runId: 'dgr-one',
      sessionId: 'root',
    })
  })

  it('6 · a conflict names the files and nothing was applied', () => {
    const root = mount(
      data({ state: 'conflicted', conflicts: ['src/login/form.ts'] }),
    )
    expect(root.querySelector('[data-result-conflict]')?.textContent).toContain(
      '1 个文件与项目里的改动冲突，没有应用任何文件',
    )
    const first = root.querySelector('.file')!
    expect(first.textContent).toContain('冲突')
    expect(action(root, 'apply')?.textContent?.trim()).toBe('再次应用')
  })

  it('discarding asks first and leaves the project alone', async () => {
    delegations.discardDelegationResult.mockResolvedValue({
      state: 'discarded',
    })
    const root = mount(data())
    action(root, 'discard')!.click()
    await flush()
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ title: '丢弃这个成果？' }),
    )
    expect(delegations.discardDelegationResult).toHaveBeenCalledWith({
      runId: 'dgr-one',
      sessionId: 'root',
    })
  })

  it('12 · a result left alone for 14 days asks to be cleaned up', async () => {
    delegations.discardDelegationResult.mockResolvedValue({
      state: 'discarded',
    })
    const fresh = mount(data({ at: Date.now() - 13 * DAY }))
    expect(fresh.querySelector('[data-result-cleanup]')).toBeNull()
    fresh.remove()
    const root = mount(data({ at: Date.now() - 15 * DAY }))
    const prompt = root.querySelector('[data-result-cleanup]')!
    expect(prompt.textContent).toContain('已保留 15 天')
    prompt.querySelector<HTMLButtonElement>('button')!.click()
    await flush()
    expect(delegations.discardDelegationResult).toHaveBeenCalled()
  })

  it('with 验证后再应用 on, the primary action opens the checks instead', () => {
    const root = mount(data({ verifyFirst: true }))
    expect(action(root, 'apply')).toBeNull()
    expect(action(root, 'verify')?.textContent?.trim()).toBe('验证后再应用')
  })

  it('a discarded result says so and offers nothing more', () => {
    const root = mount(data({ state: 'discarded' }))
    expect(root.textContent).toContain('已丢弃')
    expect(root.querySelectorAll('.actions button')).toHaveLength(0)
  })
})
