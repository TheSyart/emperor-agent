import type { ControlInteraction } from '../../../types'

/**
 * Computer Use grant card model (`meta.interaction_type ===
 * 'computer_use_grant'`): what the Agent wants to do where, which scopes the
 * user may choose, and the answer payload Core parses
 * (`{ grant: { option_id, background } }`). Anything Core did not offer is
 * never sent — Core would treat it as a denial anyway.
 */

export const GRANT_QUESTION_ID = 'grant'
export const GRANT_DENY = 'deny'

export interface GrantScopeOption {
  value: string
  label: string
}

/** Exactly what a desktop action types or presses (per-input consent). */
export interface GrantInput {
  kind: 'text' | 'key'
  /** Text with each line break marked `⏎`, or the key chord as sent. */
  value: string
  /** A line break or Enter/Return: the shell or form acts on it at once. */
  submits: boolean
}

export interface GrantPresentation {
  headline: string
  /** Full URL(s) or the app name — plain text, never a link. */
  target: string
  /** The page that embeds the cross-origin frame the action targets. */
  embeddedIn: string
  targetKind: 'browser' | 'desktop'
  actions: string[]
  /** Agent-supplied reason; shown as unverified. */
  reason: string
  highImpact: boolean
  highRiskApp: boolean
  input: GrantInput | null
  /** Whether to offer "allow in the background". */
  backgroundOffered: boolean
  tool: string
  scopes: GrantScopeOption[]
  defaultScope: string
}

export type GrantAnswers = Record<
  string,
  { option_id: string; choice: string; freeform: string; background?: boolean }
>

const ACTION_LABELS: Record<string, string> = {
  observe: '查看',
  interact: '操作',
  navigate: '跳转',
  transfer: '上传或下载',
  'high-impact': '高影响操作',
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

export function isGrantInteraction(
  interaction?: ControlInteraction | null,
): boolean {
  return interaction?.meta?.interaction_type === 'computer_use_grant'
}

function grantMeta(interaction: ControlInteraction): Record<string, unknown> {
  return record(interaction.meta?.grant) ?? {}
}

function scopeOptions(interaction: ControlInteraction): GrantScopeOption[] {
  const options = interaction.questions?.[0]?.options ?? []
  return options
    .filter((option) => option.id && option.id !== GRANT_DENY)
    .map((option) => ({ value: option.id!, label: option.label }))
}

function grantInput(value: unknown): GrantInput | null {
  const input = record(value)
  if (input?.kind === 'text' && typeof input.text === 'string')
    return {
      kind: 'text',
      value: input.text.replace(/\r\n|\r|\n/g, '⏎\n'),
      submits: /[\r\n]/.test(input.text),
    }
  if (input?.kind === 'key' && typeof input.key === 'string')
    return {
      kind: 'key',
      value: input.key,
      submits: /(^|\+)(enter|return)$/i.test(input.key),
    }
  return null
}

export function grantPresentation(
  interaction: ControlInteraction,
): GrantPresentation {
  const meta = grantMeta(interaction)
  const scope = record(meta.target_scope) ?? {}
  const display = record(meta.display) ?? {}
  const targetKind = scope.kind === 'desktop' ? 'desktop' : 'browser'
  const target =
    text(display.url) ||
    (targetKind === 'browser'
      ? strings(scope.origins).join('\n')
      : text(display.appName) || text(scope.appId))
  const actions = strings(meta.actions).map(
    (action) => ACTION_LABELS[action] ?? action,
  )
  const highImpact = meta.high_impact === true
  const highRiskApp = meta.high_risk_app === true
  const scopes = scopeOptions(interaction)
  const preferred = ['task', 'once']
  const defaultScope =
    preferred.find((value) => scopes.some((scope) => scope.value === value)) ??
    scopes[0]?.value ??
    ''
  const verb = actions.length > 0 ? actions.join('、') : '操作'
  const place = targetKind === 'browser' ? '这个网站' : '这个应用'
  return {
    headline: highImpact
      ? `允许 Agent 在${place}执行一次高影响操作？`
      : `允许 Agent ${verb}${place}？`,
    target,
    embeddedIn: text(display.embeddedIn),
    targetKind,
    actions,
    reason: text(meta.reason),
    highImpact,
    highRiskApp,
    input: grantInput(display.input),
    backgroundOffered: meta.background === true,
    tool: text(meta.tool_name),
    scopes,
    defaultScope,
  }
}

export function grantAnswer(
  interaction: ControlInteraction,
  optionId: string,
  background: boolean,
): GrantAnswers {
  const options = interaction.questions?.[0]?.options ?? []
  const label =
    options.find((option) => option.id === optionId)?.label ??
    (optionId === GRANT_DENY ? '拒绝' : optionId)
  return {
    [GRANT_QUESTION_ID]: {
      option_id: optionId,
      choice: label,
      freeform: '',
      ...(background ? { background: true } : {}),
    },
  }
}
