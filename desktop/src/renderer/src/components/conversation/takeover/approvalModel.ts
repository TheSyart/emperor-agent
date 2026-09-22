import type { ControlInteraction, ControlQuestion } from '../../../types'

/**
 * Permission (approval) takeover model: parses the `meta.permission` payload
 * of a `meta.interaction_type === 'permission'` ask into display data, and
 * derives the decision buttons from the permission question's own options so
 * the answer payload stays identical to the option-picker it replaced.
 */

export const HOST_BOUNDARY_DISCLOSURE =
  '执行范围：宿主直执；可读写真实用户环境（含 HOME 与用户配置），并可使用本机网络。'

const MAX_OPERATIONS = 64

export interface ApprovalOperation {
  tool: string
  risk: string
  reason: string
  summary: string
  /** Execution-boundary disclosure copy ('' when nothing to disclose). */
  boundary: string
}

export interface ApprovalPresentation {
  headline: string
  count: number
  operations: ApprovalOperation[]
}

export type ApprovalActionVariant = 'danger' | 'outline' | 'primary'

export interface ApprovalAction {
  key: string
  label: string
  description: string
  optionId: string
  deny: boolean
  variant: ApprovalActionVariant
}

export type ApprovalAnswers = Record<
  string,
  { option_id?: string; choice: string; freeform: string }
>

export function isPermissionInteraction(
  interaction?: ControlInteraction | null,
): boolean {
  return interaction?.meta?.interaction_type === 'permission'
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function text(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number'
    ? String(value).trim()
    : ''
}

function boundaryDisclosure(value: unknown): string {
  return text(value) === 'host' ? HOST_BOUNDARY_DISCLOSURE : ''
}

/** Structured operations of a permission payload (v2 list or legacy v1 single). */
export function permissionOperations(
  interaction: ControlInteraction,
): ApprovalOperation[] {
  const data = record(interaction.meta?.permission)
  if (!data) return []
  if (Number(data.version) === 2 && Array.isArray(data.operations)) {
    return data.operations
      .map(record)
      .filter((item): item is Record<string, unknown> => item !== null)
      .slice(0, MAX_OPERATIONS)
      .map((operation) => ({
        tool: text(operation.tool_name) || '工具操作',
        risk: text(operation.risk) || 'unknown',
        reason: text(operation.reason),
        summary: text(operation.summary),
        boundary: boundaryDisclosure(operation.execution_boundary),
      }))
  }
  return [
    {
      tool: text(data.tool_name) || '工具操作',
      risk: text(data.risk) || 'unknown',
      reason: text(data.reason),
      summary: text(data.command_summary),
      boundary: boundaryDisclosure(data.execution_boundary),
    },
  ]
}

/** Number of operations awaiting a decision (0 = not a permission ask). */
export function permissionOperationCount(
  interaction: ControlInteraction,
): number {
  if (!isPermissionInteraction(interaction)) return 0
  const permission = record(interaction.meta?.permission)
  if (!permission) return 1
  const count = Math.trunc(Number(permission.operation_count) || 0)
  return Math.max(1, Math.min(MAX_OPERATIONS, count))
}

export function riskLabel(risk: string): string {
  const labels: Record<string, string> = {
    high: '高风险',
    medium: '中风险',
    low: '低风险',
    escalation: '需要提权',
  }
  return labels[risk] || `风险 ${risk}`
}

export function approvalPresentation(
  interaction: ControlInteraction,
): ApprovalPresentation {
  const operations = permissionOperations(interaction)
  const count = Math.max(
    operations.length,
    permissionOperationCount(interaction),
    1,
  )
  const first = operations[0]
  const question = text(interaction.questions?.[0]?.question)
  const headline =
    operations.length > 1
      ? `${count} 项操作需要权限确认`
      : first?.reason ||
        (first ? `${first.tool} 需要你的授权` : '') ||
        question ||
        '该操作需要你的权限确认。'
  return { headline, count, operations }
}

/**
 * Plain-text detail of a permission / ask interaction for the timeline history
 * card. Never echoes raw context of permission / Ask Guard interactions (they
 * may carry internal diagnostics).
 */
export function safeInteractionDetail(
  interaction: ControlInteraction,
  fallback = '',
): string {
  const context = String(interaction.context || '')
  if (context.trimStart().startsWith('Ask Guard'))
    return fallback || '需要确认会影响实施方案的关键信息。'
  const isPermission =
    isPermissionInteraction(interaction) ||
    context.trimStart().startsWith('Permission Guard')
  if (!isPermission) return context || fallback
  const data = record(interaction.meta?.permission)
  if (!data) return '该操作需要你的权限确认。'
  const operations = permissionOperations(interaction)
  if (Number(data.version) === 2 && Array.isArray(data.operations)) {
    const lines = operations.map((operation, index) =>
      [
        `${index + 1}. ${operation.tool} · 风险 ${operation.risk}`,
        operation.reason,
        operation.summary ? `摘要：${operation.summary}` : '',
        operation.boundary,
      ]
        .filter(Boolean)
        .join('\n'),
    )
    return [`${lines.length} 项操作需要权限确认`, ...lines].join('\n')
  }
  const operation = operations[0]!
  return [
    `${operation.tool} · 风险 ${operation.risk}`,
    operation.reason,
    operation.summary ? `摘要：${operation.summary}` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

const DEFAULT_PERMISSION_OPTIONS: ControlQuestion['options'] = [
  { id: 'allow_once', label: '允许本次' },
  { id: 'deny', label: '拒绝' },
]

function isDenyOption(option: ControlQuestion['options'][number]): boolean {
  const id = String(option.id || '').toLowerCase()
  if (id) return id === 'deny' || id.startsWith('deny') || id === 'reject'
  return /拒绝|deny|reject/i.test(option.label)
}

/** The permission question the decision answers (first question). */
export function permissionQuestion(
  interaction: ControlInteraction,
): ControlQuestion {
  const question = interaction.questions?.[0]
  if (question && question.options?.length) return question
  return {
    id: question?.id || 'permission',
    header: question?.header || '权限',
    question: question?.question || '',
    options: DEFAULT_PERMISSION_OPTIONS,
  }
}

/**
 * Decision buttons in render order: deny options first (danger), then the
 * allow options; the last allow option is the primary action, earlier ones
 * are outline (e.g. 本次允许 outline · 总是允许 primary).
 */
export function approvalActions(
  interaction: ControlInteraction,
): ApprovalAction[] {
  const options = permissionQuestion(interaction).options
  const deny = options.filter(isDenyOption)
  const allow = options.filter((option) => !isDenyOption(option))
  const toAction = (
    option: ControlQuestion['options'][number],
    variant: ApprovalActionVariant,
  ): ApprovalAction => ({
    key: option.id || option.label,
    label: option.label,
    description: option.description || '',
    optionId: option.id || '',
    deny: variant === 'danger',
    variant,
  })
  return [
    ...deny.map((option) => toAction(option, 'danger')),
    ...allow.map((option, index) =>
      toAction(option, index === allow.length - 1 ? 'primary' : 'outline'),
    ),
  ]
}

/** Answer payload for one decision — same shape the option picker sent. */
export function approvalAnswer(
  interaction: ControlInteraction,
  action: ApprovalAction,
): ApprovalAnswers {
  const question = permissionQuestion(interaction)
  return {
    [question.id]: {
      ...(action.optionId ? { option_id: action.optionId } : {}),
      choice: action.label,
      freeform: '',
    },
  }
}
