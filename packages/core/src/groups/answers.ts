/**
 * The user's answers to group members (GRP-12). A member that asks during
 * its speech waits in its own session; the user answers it through
 * `control.*` (the group page, or the member's work page). Core then keeps
 * one line in the group log for the user only — 「你回答了 架构师 的提问：…」,
 * 「你批准了 …」, 「你拒绝了 …」, 「你没有回答 …」 — built here from the
 * interaction card Core projected and what the user did with it. Pure.
 */
import type {
  GroupAnswerNote,
  GroupAnswerOutcome,
  GroupAnswerSubject,
} from './types'

/** What the user did with a pending interaction, as control.* received it. */
export type InteractionSettle =
  | { action: 'answer'; answers: Record<string, unknown> }
  | { action: 'cancel' }
  | { action: 'approvePlan' }
  | { action: 'commentPlan'; comment: string }

export type GroupAnswerDraft = Pick<
  GroupAnswerNote,
  'outcome' | 'subject' | 'asked' | 'reply'
>

/** How long `asked` and `reply` may be in the log and on the line. */
const CLIP = 200
/** The allow options of an approval and of Claude Code / Codex's first use. */
const ALLOW_IDS = new Set(['allow_once', 'allow_always'])
const CONSENT_ALLOW_LABELS = new Set(['本次允许', '以后都允许'])
/** The plan review's approve label (harness/projection/interactions.ts). */
const PLAN_APPROVE = 'Approve'

type Card = Record<string, unknown>

function record(value: unknown): Card | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Card)
    : null
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** One line, at most CLIP characters (code points, not halves of one). */
export function clipLine(value: string): string {
  const line = value.replace(/\s+/g, ' ').trim()
  const chars = Array.from(line)
  return chars.length > CLIP ? `${chars.slice(0, CLIP).join('')}…` : line
}

/** A UI answer `{ option_id?, choice, freeform }` or `{ selected, custom }`. */
function uiAnswer(value: unknown): {
  optionId: string
  choices: string[]
  freeform: string
} {
  if (typeof value === 'string')
    return { optionId: '', choices: value ? [value] : [], freeform: '' }
  const answer = record(value) ?? {}
  const choices = Array.isArray(answer.selected)
    ? answer.selected.map(String)
    : text(answer.choice)
        .split('\u0000')
        .filter((part) => part !== '')
  return {
    optionId: text(answer.option_id),
    choices,
    freeform: text(answer.freeform) || text(answer.custom),
  }
}

function questionsOf(card: Card | null): Card[] {
  const list = card?.questions
  return Array.isArray(list)
    ? list.map(record).filter((q): q is Card => q !== null)
    : []
}

function subjectOf(id: string, card: Card | null): GroupAnswerSubject {
  if (id.startsWith('plan_') || card?.kind === 'plan') return 'plan'
  if (
    id.startsWith('approval_') ||
    record(card?.meta)?.interaction_type === 'permission'
  )
    return 'approval'
  return 'question'
}

/** What an approval is for: its command or file, else its reason. */
function approvalAsked(card: Card | null): string {
  const permission = record(record(card?.meta)?.permission)
  const operations = Array.isArray(permission?.operations)
    ? permission.operations
    : []
  const first = record(operations[0])
  return (
    text(first?.summary) ||
    text(first?.reason) ||
    text(questionsOf(card)[0]?.question) ||
    text(card?.context)
  )
}

function approvalDecision(
  card: Card | null,
  answers: Record<string, unknown>,
): { outcome: GroupAnswerOutcome; reply: string } {
  const id = text(questionsOf(card)[0]?.id) || 'permission'
  const answer = uiAnswer(answers[id] ?? Object.values(answers)[0])
  const label = answer.choices.join('、')
  const consent = record(record(card?.meta)?.executor_consent) !== null
  // As Core decides: only the allow option allows a permission; the first
  // use of Claude Code or Codex goes by its option or label.
  const allowed = answer.optionId
    ? ALLOW_IDS.has(answer.optionId)
    : consent && answer.choices.some((c) => CONSENT_ALLOW_LABELS.has(c))
  return { outcome: allowed ? 'approved' : 'denied', reply: label }
}

function questionReply(
  card: Card | null,
  answers: Record<string, unknown>,
): string {
  const ids = questionsOf(card).map((q) => text(q.id))
  return (ids.length ? ids : Object.keys(answers))
    .map((id) => {
      const answer = uiAnswer(answers[id])
      return [
        answer.choices.flatMap((c) => c.split(/\s*,\s*/)).join('、'),
        answer.freeform.trim(),
      ]
        .filter(Boolean)
        .join(' · ')
    })
    .filter(Boolean)
    .join('；')
}

/**
 * The line to keep for what the user did with interaction `id` (its card
 * as Core projected it, null when there is none), or null for one the
 * group does not keep (a computer-use grant).
 */
export function groupAnswer(
  id: string,
  card: Card | null,
  settle: InteractionSettle,
): GroupAnswerDraft | null {
  if (id.startsWith('grant_')) return null
  const subject = subjectOf(id, card)
  const asked = clipLine(
    subject === 'approval'
      ? approvalAsked(card)
      : subject === 'plan'
        ? text(card?.title)
        : questionsOf(card)
            .map((q) => text(q.question))
            .filter(Boolean)
            .join('；'),
  )
  const draft = (outcome: GroupAnswerOutcome, reply = '') => ({
    outcome,
    subject,
    asked,
    reply: clipLine(reply),
  })
  switch (settle.action) {
    case 'cancel':
      return draft('skipped')
    case 'approvePlan':
      return draft('approved')
    case 'commentPlan':
      return draft('answered', settle.comment)
    case 'answer':
      break
  }
  const answers = settle.answers
  if (subject === 'approval') {
    const decision = approvalDecision(card, answers)
    return draft(decision.outcome, decision.reply)
  }
  if (subject === 'plan') {
    const review = uiAnswer(Object.values(answers)[0])
    return review.choices.join('') === PLAN_APPROVE && !review.freeform
      ? draft('approved')
      : draft('answered', review.freeform)
  }
  return draft('answered', questionReply(card, answers))
}

const NOUN: Record<GroupAnswerSubject, string> = {
  question: '提问',
  approval: '请求',
  plan: '计划',
}

/** The line the user reads, naming the member as `name`. */
export function answerText(
  note: Pick<GroupAnswerNote, 'outcome' | 'subject' | 'asked' | 'reply'>,
  name: string,
): string {
  const noun = NOUN[note.subject] ?? NOUN.question
  const asked = clipLine(note.asked)
  const reply = clipLine(note.reply)
  const tail = (value: string) => (value ? `：${value}` : '')
  switch (note.outcome) {
    case 'approved':
      return `你批准了 ${name} 的${noun}${tail(asked)}`
    case 'denied':
      return `你拒绝了 ${name} 的${noun}${tail(asked)}`
    case 'skipped':
      return `你没有回答 ${name} 的${noun}${tail(asked)}`
    default:
      return note.subject === 'plan'
        ? `你对 ${name} 的计划提了意见${tail(reply)}`
        : `你回答了 ${name} 的提问${tail(reply)}`
  }
}
