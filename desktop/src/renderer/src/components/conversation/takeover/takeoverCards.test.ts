// @vitest-environment jsdom
import { createApp, h, nextTick, ref, type Component } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { APP_CONTEXT_KEY } from '../../../composables/useAppContext'
import type { ControlInteraction } from '../../../types'
import ApprovalPanel from './ApprovalPanel.vue'
import PlanReviewPanel from './PlanReviewPanel.vue'
import QuestionComposer from './QuestionComposer.vue'
import TakeoverSeat from './TakeoverSeat.vue'
import { approvalActions, approvalPresentation } from './approvalModel'

let container: HTMLDivElement | null = null
let unmount: (() => void) | null = null

afterEach(() => {
  unmount?.()
  unmount = null
  container?.remove()
  container = null
})

function fakeContext(extra: Record<string, unknown> = {}) {
  return {
    boot: ref<Record<string, unknown> | null>({}),
    sendInteractionAnswer: vi.fn(() => true),
    approvePlan: vi.fn(() => true),
    sendPlanComment: vi.fn(() => true),
    cancelInteraction: vi.fn(() => true),
    skipProfileInterview: vi.fn(async () => {}),
    runSafely: vi.fn(async (task: () => Promise<void>) => await task()),
    ...extra,
  }
}

async function mount(
  component: Component,
  props: Record<string, unknown>,
  ctx = fakeContext(),
) {
  container = document.createElement('div')
  document.body.append(container)
  const app = createApp({ render: () => h(component, props) })
  app.provide(APP_CONTEXT_KEY, ctx as never)
  app.mount(container)
  unmount = () => app.unmount()
  await nextTick()
  await nextTick()
  return { ctx, root: container }
}

function buttons(root: HTMLElement, text: string): HTMLButtonElement[] {
  return [...root.querySelectorAll('button')].filter((button) =>
    (button.textContent || '').includes(text),
  )
}

function button(root: HTMLElement, text: string): HTMLButtonElement {
  const found = buttons(root, text)[0]
  if (!found) throw new Error(`button "${text}" not found`)
  return found
}

function key(target: Element, keyName: string, init: KeyboardEventInit = {}) {
  target.dispatchEvent(
    new KeyboardEvent('keydown', { key: keyName, bubbles: true, ...init }),
  )
}

const ask = (extra: Partial<ControlInteraction> = {}): ControlInteraction => ({
  id: 'ask-1',
  kind: 'ask',
  status: 'waiting',
  meta: { interaction_type: 'question' },
  questions: [
    {
      id: 'style',
      header: '风格',
      question: '选择风格？',
      options: [
        { label: '完整', description: '完整实现' },
        { label: '快速', description: '先跑通' },
      ],
    },
    {
      id: 'colors',
      header: '颜色',
      question: '选颜色',
      multi_select: true,
      options: [{ label: 'red' }, { label: 'green' }, { label: 'blue' }],
    },
  ],
  ...extra,
})

const permission = (
  extra: Partial<ControlInteraction> = {},
): ControlInteraction => ({
  id: 'approval_1',
  kind: 'ask',
  status: 'waiting',
  context: 'internal context',
  questions: [
    {
      id: 'permission',
      header: '权限',
      question: '执行安装命令',
      options: [
        { id: 'allow_once', label: '允许本次' },
        { id: 'deny', label: '拒绝' },
      ],
    },
  ],
  meta: {
    interaction_type: 'permission',
    permission: {
      version: 2,
      operation_count: 1,
      operations: [
        {
          tool_name: 'run_command',
          risk: 'escalation',
          reason: '执行安装命令',
          summary: 'npm install',
          execution_boundary: 'host',
          authorization_id: 'must-not-leak',
        },
      ],
    },
  },
  ...extra,
})

const plan = (extra: Partial<ControlInteraction> = {}): ControlInteraction => ({
  id: 'plan-1',
  kind: 'plan',
  status: 'waiting',
  title: '重构计划',
  plan_markdown: '# 重构计划\n\n- 第一步',
  ...extra,
})

describe('QuestionComposer', () => {
  it('pages through questions and submits the plain answer payload', async () => {
    const { ctx, root } = await mount(QuestionComposer, { interaction: ask() })
    const submit = root.querySelector<HTMLButtonElement>(
      '[data-action="submit"]',
    )!
    expect(root.querySelector('.title')?.textContent).toBe('选择风格？')
    expect(root.querySelector('.progress')?.textContent).toContain('1 / 2')
    expect(submit.textContent).toContain('继续')
    expect(submit.disabled).toBe(true)

    button(root, '完整').click()
    await nextTick()
    expect(submit.disabled).toBe(false)
    submit.click()
    await nextTick()

    expect(root.querySelector('.title')?.textContent).toBe('选颜色')
    expect(submit.textContent).toContain('提交')
    // multi-select: checkboxes toggle membership in option order
    button(root, 'blue').click()
    button(root, 'red').click()
    await nextTick()
    button(root, 'blue').click()
    button(root, 'green').click()
    await nextTick()
    expect(
      root.querySelectorAll('[role="checkbox"][aria-checked="true"]').length,
    ).toBe(2)
    submit.click()

    expect(ctx.sendInteractionAnswer).toHaveBeenCalledWith('ask-1', {
      style: { choice: '完整', freeform: '' },
      colors: {
        choice: 'red, green',
        freeform: '',
        selected: ['red', 'green'],
      },
    })
  })

  it('uses the pager and keyboard shortcuts', async () => {
    const { ctx, root } = await mount(QuestionComposer, { interaction: ask() })
    const card = root.querySelector('.card')!
    const next = root.querySelector<HTMLButtonElement>('[aria-label="下一题"]')!
    expect(next.disabled).toBe(true)
    key(card, '2')
    await nextTick()
    expect(
      root.querySelector('[role="radio"][aria-checked="true"]')?.textContent,
    ).toContain('快速')
    expect(next.disabled).toBe(false)
    key(card, 'Enter')
    await nextTick()
    expect(root.querySelector('.title')?.textContent).toBe('选颜色')
    root.querySelector<HTMLButtonElement>('[aria-label="上一题"]')!.click()
    await nextTick()
    expect(root.querySelector('.title')?.textContent).toBe('选择风格？')
    key(card, 'Escape')
    expect(ctx.cancelInteraction).toHaveBeenCalledWith('ask-1')
  })

  it('accepts a free-form answer in the custom row', async () => {
    const single = ask({ questions: [ask().questions![0]!] })
    const { ctx, root } = await mount(QuestionComposer, {
      interaction: single,
    })
    expect(root.querySelector('.progress')).toBeNull()
    const field = root.querySelector<HTMLTextAreaElement>('.field-input')!
    expect(field.placeholder).toBe('否，请告知 Agent 如何调整')
    field.value = '自己判断'
    field.dispatchEvent(new Event('input'))
    await nextTick()
    key(field, 'Enter')
    expect(ctx.sendInteractionAnswer).toHaveBeenCalledWith('ask-1', {
      style: { choice: '', freeform: '自己判断' },
    })
  })

  it('shows the profile onboarding actions', async () => {
    const { ctx, root } = await mount(QuestionComposer, {
      interaction: ask({ meta: { profileOnboardingVersion: 2 } }),
    })
    expect(
      root.querySelector<HTMLTextAreaElement>('.field-input')!.placeholder,
    ).toBe('补充你的实际情况或其他说明（可选）')
    button(root, '稍后再说').click()
    expect(ctx.cancelInteraction).toHaveBeenCalledWith('ask-1')
    button(root, '不再提醒').click()
    await nextTick()
    expect(ctx.skipProfileInterview).toHaveBeenCalled()
  })
})

describe('ApprovalPanel', () => {
  it('renders structured operations without private fields', async () => {
    const { root } = await mount(ApprovalPanel, {
      interaction: permission(),
    })
    const text = root.textContent || ''
    expect(text).toContain('需要你的授权')
    expect(root.querySelector('.headline')?.textContent).toBe('执行安装命令')
    expect(root.querySelector('.command')?.textContent).toContain('npm install')
    expect(root.querySelector('.boundary')?.textContent).toContain('宿主直执')
    expect(text).not.toContain('must-not-leak')
    expect(text).not.toContain('internal context')
  })

  it('answers with the permission option ids', async () => {
    const { ctx, root } = await mount(ApprovalPanel, {
      interaction: permission(),
    })
    const deny = button(root, '拒绝')
    const allow = button(root, '允许本次')
    expect(deny.dataset.variant).toBe('danger')
    expect(allow.dataset.variant).toBe('primary')
    allow.click()
    await nextTick()
    expect(ctx.sendInteractionAnswer).toHaveBeenCalledWith('approval_1', {
      permission: { option_id: 'allow_once', choice: '允许本次', freeform: '' },
    })
    // one-shot latch
    expect(allow.disabled).toBe(true)
    deny.click()
    expect(ctx.sendInteractionAnswer).toHaveBeenCalledTimes(1)
  })

  it('re-arms after a rejected send and supports Esc to cancel', async () => {
    const ctx = fakeContext({ sendInteractionAnswer: vi.fn(() => false) })
    const { root } = await mount(
      ApprovalPanel,
      { interaction: permission() },
      ctx,
    )
    button(root, '拒绝').click()
    await nextTick()
    expect(ctx.sendInteractionAnswer).toHaveBeenCalledWith('approval_1', {
      permission: { option_id: 'deny', choice: '拒绝', freeform: '' },
    })
    expect(button(root, '拒绝').disabled).toBe(false)
    key(root.querySelector('.card')!, 'Escape')
    expect(ctx.cancelInteraction).toHaveBeenCalledWith('approval_1')
  })

  it('derives outline/primary from several allow options', () => {
    const actions = approvalActions(
      permission({
        questions: [
          {
            id: 'permission',
            header: '权限',
            question: '?',
            options: [
              { id: 'allow_once', label: '本次允许' },
              { id: 'allow_always', label: '总是允许' },
              { id: 'deny', label: '拒绝' },
            ],
          },
        ],
      }),
    )
    expect(actions.map((a) => [a.label, a.variant])).toEqual([
      ['拒绝', 'danger'],
      ['本次允许', 'outline'],
      ['总是允许', 'primary'],
    ])
  })

  it('summarizes multi-operation requests', () => {
    const presentation = approvalPresentation(
      permission({
        meta: {
          interaction_type: 'permission',
          permission: {
            version: 2,
            operation_count: 2,
            operations: [
              { tool_name: 'a', risk: 'high', summary: 'x' },
              { tool_name: 'b', risk: 'low', summary: 'y' },
            ],
          },
        },
      }),
    )
    expect(presentation.headline).toBe('2 项操作需要权限确认')
    expect(presentation.operations.map((o) => o.tool)).toEqual(['a', 'b'])
  })
})

describe('PlanReviewPanel', () => {
  it('renders the plan markdown and approves', async () => {
    const { ctx, root } = await mount(PlanReviewPanel, { interaction: plan() })
    expect(root.textContent).toContain('计划待确认')
    expect(root.querySelector('.markdown-body')?.innerHTML).toContain('第一步')
    button(root, '批准并执行').click()
    expect(ctx.approvePlan).toHaveBeenCalledWith('plan-1')
    expect(ctx.sendPlanComment).not.toHaveBeenCalled()
  })

  it('sends a trimmed comment via 继续规划', async () => {
    const { ctx, root } = await mount(PlanReviewPanel, { interaction: plan() })
    const keep = button(root, '继续规划')
    expect(keep.disabled).toBe(true)
    const field = root.querySelector<HTMLTextAreaElement>('.comment')!
    field.value = '  拆小一点 '
    field.dispatchEvent(new Event('input'))
    await nextTick()
    expect(keep.disabled).toBe(false)
    keep.click()
    await nextTick()
    expect(ctx.sendPlanComment).toHaveBeenCalledWith('plan-1', '拆小一点')
    expect(field.value).toBe('')
    key(root.querySelector('.card')!, 'Escape')
    expect(ctx.cancelInteraction).toHaveBeenCalledWith('plan-1')
  })

  it('stays hidden for provisional or resolved plans', async () => {
    const { root } = await mount(PlanReviewPanel, {
      interaction: plan({ meta: { provisional: true } }),
    })
    expect(root.querySelector('.card')).toBeNull()
  })
})

describe('TakeoverSeat', () => {
  it('routes each waiting interaction to its card', async () => {
    const cases: Array<[ControlInteraction | null, string | null]> = [
      [permission(), 'approval'],
      [ask(), 'question'],
      [plan(), 'plan'],
      [plan({ meta: { provisional: true } }), null],
      [ask({ status: 'answered' }), null],
      [null, null],
    ]
    for (const [interaction, kind] of cases) {
      const { root } = await mount(TakeoverSeat, { interaction })
      const seat = root.querySelector('[data-takeover]')
      expect(seat?.getAttribute('data-takeover') ?? null).toBe(kind)
      unmount?.()
      unmount = null
      container?.remove()
      container = null
    }
  })
})
