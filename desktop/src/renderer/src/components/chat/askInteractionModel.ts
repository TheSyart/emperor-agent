import type { ControlInteraction, ControlPayload, ControlQuestion } from '../../types'

export interface AskAnswerDraft {
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

export function activeAskInteraction(control?: ControlPayload | null): ControlInteraction | null {
  const pending = control?.pending
  if (!pending || pending.kind !== 'ask' || pending.status !== 'waiting') return null
  return pending
}

export function ensureAskDraft(drafts: AskAnswerDrafts, questionId: string): AskAnswerDraft {
  drafts[questionId] ||= { choice: '', freeform: '' }
  return drafts[questionId]
}

export function askQuestionCanContinue(answer?: AskAnswerDraft): boolean {
  return Boolean((answer?.choice || '').trim() || (answer?.freeform || '').trim())
}

export function askSubmitLabel(index: number, total: number): string {
  return index >= total - 1 ? '提交' : '继续'
}

export function toPlainAskAnswers(questions: ControlQuestion[] = [], drafts: AskAnswerDrafts = {}): Record<string, { choice: string; freeform: string }> {
  const out: Record<string, { choice: string; freeform: string }> = {}
  for (const question of questions) {
    const draft = drafts[question.id] || {}
    const choice = String(draft.choice || '').trim()
    const freeform = String(draft.freeform || '').trim()
    if (!choice && !freeform) continue
    out[question.id] = { choice, freeform }
  }
  return out
}

export function allAskQuestionsAnswered(questions: ControlQuestion[] = [], drafts: AskAnswerDrafts = {}): boolean {
  return questions.length > 0 && questions.every((question) => askQuestionCanContinue(drafts[question.id]))
}

export function askHistoryPresentation(interaction: ControlInteraction): AskHistoryPresentation {
  const questions = interaction.questions || []
  const count = questions.length
  const status = String(interaction.status || '')
  const answers = answerSummaries(questions, interaction.answers || {})

  if (status === 'waiting') {
    return {
      title: `正在询问 ${count || 1} 个问题`,
      status: '等待回答',
      tone: 'waiting',
      detail: interaction.context || questions[0]?.question || '',
      answers: [],
    }
  }
  if (status === 'answered') {
    return {
      title: `已回答 ${answers.length || count || 1} 个问题`,
      status: '已回答',
      tone: 'answered',
      detail: interaction.context || '',
      answers,
    }
  }
  if (status === 'cancelled') {
    return {
      title: '澄清问题已取消',
      status: '已取消',
      tone: 'cancelled',
      detail: interaction.context || '',
      answers: [],
    }
  }

  return {
    title: '澄清问题',
    status: status || '未知',
    tone: 'default',
    detail: interaction.context || '',
    answers,
  }
}

function answerSummaries(questions: ControlQuestion[], answers: Record<string, unknown>): AskHistoryAnswer[] {
  return questions.flatMap((question) => {
    const raw = answers[question.id]
    const value = answerValue(raw)
    return value ? [{ header: question.header, question: question.question, value }] : []
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
