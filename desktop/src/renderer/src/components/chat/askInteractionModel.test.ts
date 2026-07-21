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

  it('submits stable option ids while retaining labels for display compatibility', () => {
    const permissionQuestions: ControlQuestion[] = [
      {
        id: 'permission',
        header: '权限',
        question: '是否允许？',
        options: [
          {
            id: 'allow_once',
            label: '允许本次',
            description: '仅批准当前操作',
          },
          { id: 'deny', label: '拒绝', description: '拒绝当前操作' },
        ],
      },
    ]

    expect(
      toPlainAskAnswers(permissionQuestions, {
        permission: {
          optionId: 'allow_once',
          choice: '允许本次',
          freeform: '',
        },
      }),
    ).toEqual({
      permission: {
        option_id: 'allow_once',
        choice: '允许本次',
        freeform: '',
      },
    })
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

  it('renders permission v2 operation summaries without private diagnostics', () => {
    const presentation = askHistoryPresentation(
      ask({
        context: '内部上下文不应成为权限详情',
        meta: {
          interaction_type: 'permission',
          permission: {
            version: 2,
            request_id: 'permission_private',
            operation_count: 2,
            operations: [
              {
                operation_id: 'operation_1',
                tool_name: 'delete_file',
                risk: 'high',
                reason: '删除文件',
                summary: 'delete_file a.txt',
              },
              {
                operation_id: 'operation_2',
                tool_name: 'delete_file',
                risk: 'high',
                reason: '删除文件',
                summary: 'delete_file b.txt',
              },
            ],
          },
        },
      }),
    )

    expect(presentation.title).toBe('2 项操作需要权限确认')
    expect(presentation.status).toBe('等待决定')
    expect(presentation.detail).toContain('2 项操作')
    expect(presentation.detail).toContain('delete_file a.txt')
    expect(presentation.detail).toContain('delete_file b.txt')
    expect(presentation.detail).not.toContain('permission_private')
    expect(presentation.detail).not.toContain('内部上下文')
  })

  it('does not render historical Ask Guard diagnostics verbatim', () => {
    const presentation = askHistoryPresentation(
      ask({ context: 'Ask Guard: risk_boundary internal diagnostics' }),
    )

    expect(presentation.detail).toBe('选择风格？')
    expect(presentation.detail).not.toContain('risk_boundary')
  })
})
