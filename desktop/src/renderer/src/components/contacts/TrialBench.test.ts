// @vitest-environment jsdom
/**
 * GRP-04: the trial bench — runs the unsaved draft once on a sample task,
 * shows the answer and what it cost, and stops the run when the user stops
 * it or closes the editor (card tests: 试用台结果与花费；关闭编辑器中止试用).
 */
import { createApp, h, nextTick, type App } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ContactDraftInput, ContactTrialResult } from '@emperor/core/api'

const { core } = vi.hoisted(() => ({ core: vi.fn() }))
vi.mock('../../api/http', () => ({ core }))

const { default: TrialBench } = await import('./TrialBench.vue')

const DRAFT: ContactDraftInput = {
  name: '安全审计',
  role: {
    mission: '审查。',
    deliverable: '清单。',
    playbook: '1. 读\n2. 列',
    boundaries: '不改代码。',
    knowledge: [],
  },
}

function result(
  overrides: Partial<ContactTrialResult> = {},
): ContactTrialResult {
  return {
    trialId: 'tr-x',
    status: 'completed',
    text: '高 · git-runner.ts:212 分支名直接拼进参数',
    costUsd: 0.00123,
    usage: { inputTokens: 1200, outputTokens: 300 },
    durationMs: 8200,
    at: 1,
    ...overrides,
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await nextTick()
  }
}

let app: App | null = null
let container: HTMLDivElement | null = null
const ran = vi.fn()

function mount() {
  container = document.createElement('div')
  document.body.append(container)
  app = createApp(() =>
    h(TrialBench, {
      draft: DRAFT,
      defaultTask: '审查 git-runner.ts 里新加的 diff 调用',
      onRan: ran,
    }),
  )
  app.mount(container)
}

function button(name: string): HTMLButtonElement {
  const found = [
    ...document.querySelectorAll<HTMLButtonElement>('button'),
  ].find((item) => item.textContent?.trim() === name)
  if (!found) throw new Error(`no button ${name}`)
  return found
}

function bench(): string {
  return document.querySelector('[data-trial-bench]')?.textContent ?? ''
}

beforeEach(() => {
  core.mockReset()
  ran.mockReset()
})

afterEach(() => {
  app?.unmount()
  container?.remove()
  app = null
  container = null
})

describe('TrialBench', () => {
  it('runs the draft on the sample task and shows the answer and cost', async () => {
    core.mockResolvedValue(result())
    mount()
    await flush()
    const task = document.querySelector<HTMLTextAreaElement>(
      '[data-trial-bench] textarea',
    )!
    expect(task.value).toBe('审查 git-runner.ts 里新加的 diff 调用')
    button('运行').click()
    await flush()
    expect(core).toHaveBeenCalledTimes(1)
    const [op, input] = core.mock.calls[0]!
    expect(op).toBe('contacts.trial')
    expect(input).toMatchObject({
      draft: DRAFT,
      task: '审查 git-runner.ts 里新加的 diff 调用',
    })
    expect(input.trialId).toMatch(/^tr-[a-z0-9]{6,32}$/)
    expect(bench()).toContain('高 · git-runner.ts:212 分支名直接拼进参数')
    expect(bench()).toContain('$0.0012')
    expect(bench()).toContain('8 秒')
    expect(ran).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'completed' }),
    )
  })

  it('says when the price is unknown and when a run failed', async () => {
    core.mockResolvedValueOnce(result({ costUsd: null }))
    mount()
    await flush()
    button('运行').click()
    await flush()
    expect(bench()).toContain('花费未知')
    core.mockResolvedValueOnce(
      result({
        status: 'failed',
        text: '试用没能完成：模型认证失败',
        costUsd: 0,
      }),
    )
    button('再跑一次').click()
    await flush()
    expect(bench()).toContain('试用没能完成：模型认证失败')
    expect(
      document.querySelector('[data-trial-status="failed"]'),
    ).not.toBeNull()
  })

  it('stops a running trial with 停止', async () => {
    let finish: (value: ContactTrialResult) => void = () => {}
    core.mockImplementation(async (op: string) => {
      if (op === 'contacts.trial')
        return new Promise<ContactTrialResult>((resolve) => (finish = resolve))
      if (op === 'contacts.stopTrial') {
        finish(result({ status: 'stopped', text: '' }))
        return { stopped: true }
      }
      throw new Error(op)
    })
    mount()
    await flush()
    button('运行').click()
    await flush()
    expect(bench()).toContain('正在试用')
    button('停止').click()
    await flush()
    const trialId = core.mock.calls[0]![1].trialId
    expect(core).toHaveBeenCalledWith('contacts.stopTrial', { trialId })
    expect(bench()).toContain('已停止')
  })

  it('stops the run when the editor closes', async () => {
    core.mockImplementation(async (op: string) => {
      if (op === 'contacts.trial') return new Promise(() => {})
      return { stopped: true }
    })
    mount()
    await flush()
    button('运行').click()
    await flush()
    const trialId = core.mock.calls[0]![1].trialId
    app!.unmount()
    app = null
    await flush()
    expect(core).toHaveBeenCalledWith('contacts.stopTrial', { trialId })
  })

  it('wants a task', async () => {
    mount()
    await flush()
    const task = document.querySelector<HTMLTextAreaElement>(
      '[data-trial-bench] textarea',
    )!
    task.value = '  '
    task.dispatchEvent(new Event('input'))
    await flush()
    expect(button('运行').disabled).toBe(true)
  })
})
