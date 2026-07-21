import type {
  ControlInteraction,
  ControlPayload,
  ControlQuestion,
} from '../../types'

export interface AskAnswerDraft {
  optionId?: string
  choice?: string
  freeform?: string
}

export type AskAnswerDrafts = Record<string, AskAnswerDraft>

export interface AskHistoryAnswer {
  header: string
  question: string
  value: string
}

export interface AskHistoryPresentation {
  title: string
  status: string
  tone: 'waiting' | 'answered' | 'cancelled' | 'default'
  detail: string
  answers: AskHistoryAnswer[]
}

export interface AskFreeformPresentation {
  label: string
  placeholder: string
}

export function activeAskInteraction(
  control?: ControlPayload | null,
): ControlInteraction | null {
  const pending = control?.pending
  if (!pending || pending.kind !== 'ask' || pending.status !== 'waiting')
    return null
  return pending
}

export function ensureAskDraft(
  drafts: AskAnswerDrafts,
  questionId: string,
): AskAnswerDraft {
  drafts[questionId] ||= { choice: '', freeform: '' }
  return drafts[questionId]
}

export function askQuestionCanContinue(answer?: AskAnswerDraft): boolean {
  const choice = (answer?.choice || '').trim()
  const freeform = (answer?.freeform || '').trim()
  return Boolean(choice || freeform)
}

export function isProfileOnboardingAsk(
  interaction: ControlInteraction,
): boolean {
  return Number(interaction.meta?.profileOnboardingVersion) === 2
}

export function askFreeformPresentation(
  profileOnboarding: boolean,
): AskFreeformPresentation {
  if (!profileOnboarding) {
    return {
      label: '否，请告知 Agent 如何调整',
      placeholder: '补充说明，或用这条内容替代上面的选项',
    }
  }
  return {
    label: '补充你的实际情况或其他说明（可选）',
    placeholder: '可补充选项没有覆盖的偏好',
  }
}

export function askSubmitLabel(index: number, total: number): string {
  return index >= total - 1 ? '提交' : '继续'
}

export function toPlainAskAnswers(
  questions: ControlQuestion[] = [],
  drafts: AskAnswerDrafts = {},
): Record<string, { option_id?: string; choice: string; freeform: string }> {
  const out: Record<
    string,
    { option_id?: string; choice: string; freeform: string }
  > = {}
  for (const question of questions) {
    const draft = drafts[question.id] || {}
    const choice = String(draft.choice || '').trim()
    const freeform = String(draft.freeform || '').trim()
    if (!choice && !freeform) continue
    const optionId = String(draft.optionId || '').trim()
    out[question.id] = {
      ...(optionId ? { option_id: optionId } : {}),
      choice,
      freeform,
    }
  }
  return out
}

export function allAskQuestionsAnswered(
  questions: ControlQuestion[] = [],
  drafts: AskAnswerDrafts = {},
): boolean {
  return (
    questions.length > 0 &&
    questions.every((question) => askQuestionCanContinue(drafts[question.id]))
  )
}

export function askHistoryPresentation(
  interaction: ControlInteraction,
): AskHistoryPresentation {
  const questions = interaction.questions || []
  const count = questions.length
  const status = String(interaction.status || '')
  const answers = answerSummaries(questions, interaction.answers || {})
  const permissionCount = permissionOperationCount(interaction)

  if (permissionCount > 0) {
    return {
      title:
        status === 'waiting'
          ? `${permissionCount} 项操作需要权限确认`
          : status === 'cancelled'
            ? '权限确认已取消'
            : `已处理 ${permissionCount} 项操作的权限决定`,
      status:
        status === 'waiting'
          ? '等待决定'
          : status === 'cancelled'
            ? '已取消'
            : '已处理',
      tone:
        status === 'waiting'
          ? 'waiting'
          : status === 'cancelled'
            ? 'cancelled'
            : 'answered',
      detail: safeInteractionDetail(interaction),
      answers: status === 'answered' ? answers : [],
    }
  }

  if (status === 'waiting') {
    return {
      title: `正在询问 ${count || 1} 个问题`,
      status: '等待回答',
      tone: 'waiting',
      detail: safeInteractionDetail(interaction, questions[0]?.question || ''),
      answers: [],
    }
  }
  if (status === 'answered') {
    return {
      title: `已回答 ${answers.length || count || 1} 个问题`,
      status: '已回答',
      tone: 'answered',
      detail: safeInteractionDetail(interaction),
      answers,
    }
  }
  if (status === 'cancelled') {
    return {
      title: '澄清问题已取消',
      status: '已取消',
      tone: 'cancelled',
      detail: safeInteractionDetail(interaction),
      answers: [],
    }
  }

  return {
    title: '澄清问题',
    status: status || '未知',
    tone: 'default',
    detail: safeInteractionDetail(interaction),
    answers,
  }
}

function permissionOperationCount(interaction: ControlInteraction): number {
  if (interaction.meta?.interaction_type !== 'permission') return 0
  const permission = interaction.meta.permission
  if (!permission || typeof permission !== 'object') return 1
  const count = Math.trunc(
    Number((permission as Record<string, unknown>).operation_count) || 0,
  )
  return Math.max(1, Math.min(64, count))
}

function safeInteractionDetail(
  interaction: ControlInteraction,
  fallback = '',
): string {
  const context = String(interaction.context || '')
  if (context.trimStart().startsWith('Ask Guard'))
    return fallback || '需要确认会影响实施方案的关键信息。'
  const permission = interaction.meta?.permission
  const isPermission =
    interaction.meta?.interaction_type === 'permission' ||
    context.trimStart().startsWith('Permission Guard')
  if (!isPermission) return context || fallback
  if (!permission || typeof permission !== 'object')
    return '该操作需要你的权限确认。'
  const data = permission as Record<string, unknown>
  if (Number(data.version) === 2 && Array.isArray(data.operations)) {
    const operations = data.operations
      .filter((item) => item && typeof item === 'object')
      .slice(0, 64)
      .map((item, index) => {
        const operation = item as Record<string, unknown>
        const tool = String(operation.tool_name || '工具操作')
        const risk = String(operation.risk || 'unknown')
        const reason = String(operation.reason || '').trim()
        const summary = String(operation.summary || '').trim()
        return [
          `${index + 1}. ${tool} · 风险 ${risk}`,
          reason,
          summary ? `摘要：${summary}` : '',
        ]
          .filter(Boolean)
          .join('\n')
      })
    return [`${operations.length} 项操作需要权限确认`, ...operations].join('\n')
  }
  const tool = String(data.tool_name || '工具操作')
  const risk = String(data.risk || 'unknown')
  const reason = String(data.reason || '').trim()
  const command = String(data.command_summary || '').trim()
  return [`${tool} · 风险 ${risk}`, reason, command ? `摘要：${command}` : '']
    .filter(Boolean)
    .join('\n')
}

function answerSummaries(
  questions: ControlQuestion[],
  answers: Record<string, unknown>,
): AskHistoryAnswer[] {
  return questions.flatMap((question) => {
    const raw = answers[question.id]
    const value = answerValue(raw)
    return value
      ? [{ header: question.header, question: question.question, value }]
      : []
  })
}

function answerValue(raw: unknown): string {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>
    const choice = String(obj.choice || '').trim()
    const freeform = String(obj.freeform || '').trim()
    return [choice, freeform].filter(Boolean).join(' · ')
  }
  return String(raw || '').trim()
}
