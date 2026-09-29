/**
 * Renderer interaction payloads (`ControlInteraction` in the desktop types)
 * built from session-log facts: sandbox-escalation approvals, user questions,
 * and plan reviews.
 */

import type { SessionEventMap } from '../../session-log/types'
import { GRANT_QUESTION_ID, grantOptions } from '../computer-use/grants/answer'
import type { UserAnswers, UserQuestionItem } from '../questions/service'

export type InteractionPayload = Record<string, unknown> & {
  id: string
  kind: 'ask' | 'plan'
  status: 'waiting' | 'answered' | 'approved' | 'commented' | 'cancelled'
}

export const PERMISSION_QUESTION_ID = 'permission'
export const PERMISSION_ALLOW = 'allow_once'
export const PERMISSION_DENY = 'deny'
export const PLAN_APPROVE_LABEL = 'Approve'
export const PLAN_KEEP_LABEL = 'Keep planning'

export function approvalInteractionId(approvalId: string): string {
  return `approval_${approvalId}`
}

export function questionInteractionId(questionId: string): string {
  return `ask_${questionId}`
}

export function planInteractionId(questionId: string): string {
  return `plan_${questionId}`
}

/** Pending sandbox-escalation approval as an ask interaction. */
export function approvalInteraction(
  asked: SessionEventMap['approval/asked'],
  toolArguments: Record<string, unknown> | undefined,
  time: number,
): InteractionPayload {
  const reason = asked.reason ?? `tool "${asked.toolName}" requires approval`
  const command =
    typeof toolArguments?.command === 'string'
      ? toolArguments.command
      : undefined
  const path =
    typeof toolArguments?.file_path === 'string'
      ? toolArguments.file_path
      : undefined
  const summary = command ?? path ?? ''
  return {
    id: approvalInteractionId(asked.id),
    kind: 'ask',
    status: 'waiting',
    created_at: time,
    updated_at: time,
    parent_call_id: asked.callId ?? null,
    context: reason,
    questions: [
      {
        id: PERMISSION_QUESTION_ID,
        header: '权限',
        question: reason,
        options: [
          { id: PERMISSION_ALLOW, label: '允许本次' },
          { id: PERMISSION_DENY, label: '拒绝' },
        ],
      },
    ],
    answers: {},
    meta: {
      interaction_type: 'permission',
      approval_id: asked.id,
      permission: {
        version: 2,
        operation_count: 1,
        operations: [
          {
            tool_name: asked.toolName,
            risk: 'escalation',
            reason,
            summary,
            requested_mode:
              typeof toolArguments?.sandbox_permissions === 'string'
                ? toolArguments.sandbox_permissions
                : null,
          },
        ],
      },
    },
  }
}

export function decidedApprovalInteraction(
  base: InteractionPayload,
  outcome: SessionEventMap['approval/decided']['outcome'],
  time: number,
): InteractionPayload {
  const allowed = outcome === 'allowed-once'
  const answered = outcome === 'allowed-once' || outcome === 'rejected'
  return {
    ...base,
    status: answered ? 'answered' : 'cancelled',
    updated_at: time,
    answers: answered
      ? {
          [PERMISSION_QUESTION_ID]: {
            option_id: allowed ? PERMISSION_ALLOW : PERMISSION_DENY,
            choice: allowed ? '允许本次' : '拒绝',
            freeform: '',
          },
        }
      : {},
  }
}

function uiQuestions(
  questions: readonly UserQuestionItem[],
): Array<Record<string, unknown>> {
  return questions.map((question) => ({
    id: question.id,
    header: question.header ?? '',
    question:
      question.detail === undefined
        ? question.question
        : `${question.question}\n\n${question.detail}`,
    options: (question.options ?? []).map((option) => ({
      label: option.label,
      ...(option.description === undefined
        ? {}
        : { description: option.description }),
    })),
    ...(question.multiSelect === true ? { multi_select: true } : {}),
  }))
}

/** A pending `ask_user_question` or plan review. */
export function questionInteraction(
  asked: SessionEventMap['question/asked'],
  time: number,
): InteractionPayload {
  if (asked.intent?.kind === 'plan-review') {
    const review = asked.questions[0]
    const plan = review?.detail ?? ''
    const heading = /^#{1,6}\s+(.+?)\s*$/m.exec(plan)?.[1]
    return {
      id: planInteractionId(asked.id),
      kind: 'plan',
      status: 'waiting',
      created_at: time,
      updated_at: time,
      parent_call_id: asked.callId ?? null,
      title: heading ?? '计划',
      plan_markdown: plan,
      comments: [],
      meta: {
        question_id: asked.id,
        review_question_id: review?.id ?? null,
        plan_stream_id: asked.callId ?? asked.id,
      },
    }
  }
  return {
    id: questionInteractionId(asked.id),
    kind: 'ask',
    status: 'waiting',
    created_at: time,
    updated_at: time,
    parent_call_id: asked.callId ?? null,
    questions: uiQuestions(asked.questions),
    answers: {},
    meta: { interaction_type: 'question', question_id: asked.id },
  }
}

export function answeredQuestionInteraction(
  base: InteractionPayload,
  answered: SessionEventMap['question/answered'],
  time: number,
): {
  interaction: InteractionPayload
  outcome: 'answered' | 'approved' | 'commented' | 'cancelled'
  comment?: string
} {
  if ('outcome' in answered) {
    return {
      interaction: { ...base, status: 'cancelled', updated_at: time },
      outcome: 'cancelled',
    }
  }
  const answers: UserAnswers = answered.answers
  if (base.kind === 'plan') {
    const reviewId = String(
      (base.meta as Record<string, unknown> | undefined)?.review_question_id ??
        '',
    )
    const review = answers[reviewId] ?? Object.values(answers)[0]
    const approved =
      review?.selected.length === 1 &&
      review.selected[0] === PLAN_APPROVE_LABEL &&
      review.custom === undefined
    if (approved)
      return {
        interaction: { ...base, status: 'approved', updated_at: time },
        outcome: 'approved',
      }
    const comment = review?.custom ?? ''
    const comments = [
      ...(Array.isArray(base.comments) ? (base.comments as unknown[]) : []),
      { content: comment, timestamp: time },
    ]
    return {
      interaction: { ...base, status: 'commented', updated_at: time, comments },
      outcome: 'commented',
      comment,
    }
  }
  const uiAnswers: Record<string, unknown> = {}
  for (const [id, answer] of Object.entries(answers)) {
    uiAnswers[id] = {
      choice: answer.selected.join(', '),
      freeform: answer.custom ?? '',
    }
  }
  return {
    interaction: {
      ...base,
      status: 'answered',
      updated_at: time,
      answers: uiAnswers,
    },
    outcome: 'answered',
  }
}

export function grantInteractionId(requestId: string): string {
  return `grant_${requestId}`
}

const ACTION_LABELS: Record<string, string> = {
  observe: '查看',
  interact: '操作',
  navigate: '跳转',
  transfer: '上传或下载',
  'high-impact': '高影响操作',
}

/** A pending Computer Use grant card. */
export function grantInteraction(
  asked: SessionEventMap['ui/grant-requested'],
  time: number,
): InteractionPayload {
  const scope = asked.targetScope
  const target =
    asked.display?.url ??
    (scope.kind === 'browser'
      ? scope.origins.join('、')
      : (asked.display?.appName ?? scope.appId))
  const actions = asked.actions
    .map((action) => ACTION_LABELS[action] ?? action)
    .join('、')
  const question = `允许 Agent ${actions}：${target}`
  return {
    id: grantInteractionId(asked.requestId),
    kind: 'ask',
    status: 'waiting',
    created_at: time,
    updated_at: time,
    parent_call_id: asked.callId ?? null,
    ...(asked.reason === undefined ? {} : { context: asked.reason }),
    questions: [
      {
        id: GRANT_QUESTION_ID,
        header: '电脑操作',
        question,
        options: grantOptions(asked.allowedScopes),
      },
    ],
    answers: {},
    meta: {
      interaction_type: 'computer_use_grant',
      request_id: asked.requestId,
      grant: {
        subject: asked.subject,
        driver: asked.driver,
        target_scope: asked.targetScope,
        actions: asked.actions,
        allowed_scopes: asked.allowedScopes,
        display: asked.display ?? null,
        tool_name: asked.toolName ?? null,
        reason: asked.reason ?? null,
        reason_unverified: true,
        high_impact: asked.highImpact === true,
        high_risk_app: asked.highRiskApp === true,
        background: asked.background === true,
      },
    },
  }
}

export function decidedGrantInteraction(
  base: InteractionPayload,
  decided: SessionEventMap['ui/grant-decided'],
  time: number,
): InteractionPayload {
  const byUser = decided.cause === undefined || decided.cause === 'user'
  if (!byUser)
    return { ...base, status: 'cancelled', updated_at: time, answers: {} }
  const optionId =
    decided.decision === 'denied'
      ? 'deny'
      : decided.decision === 'timed' && decided.minutes !== undefined
        ? `timed:${decided.minutes}`
        : decided.decision
  const questions = Array.isArray(base.questions)
    ? (base.questions as Array<{
        options?: Array<{ id: string; label: string }>
      }>)
    : []
  const label =
    questions[0]?.options?.find((option) => option.id === optionId)?.label ??
    optionId
  return {
    ...base,
    status: 'answered',
    updated_at: time,
    answers: {
      [GRANT_QUESTION_ID]: { option_id: optionId, choice: label, freeform: '' },
    },
    meta: {
      ...(base.meta as Record<string, unknown>),
      decision: decided.decision,
      grant_id: decided.grantId ?? null,
      expires_at: decided.expiresAt ?? null,
    },
  }
}
