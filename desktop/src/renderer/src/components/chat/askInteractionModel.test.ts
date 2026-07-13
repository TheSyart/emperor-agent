import { describe, expect, it } from 'vitest'
import type { ControlInteraction, ControlQuestion } from '../../types'
import * as askModel from './askInteractionModel'

const {
  activeAskInteraction,
  askFreeformPresentation,
  askHistoryPresentation,
  askQuestionCanContinue,
  askSubmitLabel,
  isProfileOnboardingAsk,
  toPlainAskAnswers,
} = askModel

const questions: ControlQuestion[] = [
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
    id: 'depth',
    header: '深度',
    question: '做到什么程度？',
    options: [
      { label: 'MVP', description: '最小可用' },
      { label: '精简', description: '少量代码' },
    ],
  },
]

function ask(extra: Partial<ControlInteraction> = {}): ControlInteraction {
  return {
    id: 'ask-1',
    kind: 'ask',
    status: 'waiting',
    context: '需要澄清',
    questions,
    ...extra,
  }
}

describe('ask interaction model', () => {
  it('selects only the waiting ask interaction as active', () => {
    expect(activeAskInteraction({ mode: 'plan', pending: ask() })?.id).toBe(
      'ask-1',
    )
    expect(
      activeAskInteraction({
        mode: 'plan',
        pending: ask({ status: 'answered' }),
      }),
    ).toBeNull()
    expect(
      activeAskInteraction({
        mode: 'plan',
        pending: { ...ask(), kind: 'plan' },
      }),
    ).toBeNull()
  })

  it('normalizes ask drafts into plain JSON answers for IPC', () => {
    const draft = {
      style: { choice: '完整', freeform: '' },
      depth: { choice: '', freeform: '自己判断' },
      stale: { choice: '忽略', freeform: '' },
    }

    const plain = toPlainAskAnswers(questions, draft)

    expect(plain).toEqual({
      style: { choice: '完整', freeform: '' },
      depth: { choice: '', freeform: '自己判断' },
    })
    expect(structuredClone(plain)).toEqual(plain)
  })

  it('reports per-question progression labels and validity', () => {
    expect(askQuestionCanContinue({ choice: '', freeform: '' })).toBe(false)
    expect(askQuestionCanContinue({ choice: '完整', freeform: '' })).toBe(true)
    expect(askQuestionCanContinue({ choice: '', freeform: '按你建议来' })).toBe(
      true,
    )
    expect(askSubmitLabel(0, 2)).toBe('继续')
    expect(askSubmitLabel(1, 2)).toBe('提交')
  })

  it('keeps dynamic onboarding questions generic and does not infer validation from labels', () => {
    const profile = ask({ meta: { profileOnboardingVersion: 2 } })

    expect(isProfileOnboardingAsk(profile)).toBe(true)
    expect(askQuestionCanContinue({ choice: '自定义称呼', freeform: '' })).toBe(
      true,
    )
    expect(askFreeformPresentation(true)).toEqual({
      label: '补充你的实际情况或其他说明（可选）',
      placeholder: '可补充选项没有覆盖的偏好',
    })
  })

  it('renders timeline ask interactions as compact history summaries', () => {
    expect(askHistoryPresentation(ask())).toMatchObject({
      title: '正在询问 2 个问题',
      tone: 'waiting',
    })
    expect(
      askHistoryPresentation(
        ask({
          status: 'answered',
          answers: {
            style: { choice: '完整', freeform: '' },
            depth: { choice: '', freeform: '自己判断' },
          },
        }),
      ),
    ).toMatchObject({
      title: '已回答 2 个问题',
      tone: 'answered',
      answers: [
        { header: '风格', value: '完整' },
        { header: '深度', value: '自己判断' },
      ],
    })
    expect(askHistoryPresentation(ask({ status: 'cancelled' }))).toMatchObject({
      title: '澄清问题已取消',
      tone: 'cancelled',
    })
  })
})
