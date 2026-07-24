/**
 * 控制态模型 (MIG-CTRL-001)。对齐 Python `agent/control/models.py`。
 * Interaction/Question/QuestionOption/ControlState + from_dict/to_dict 校验逐字保真。
 * Control v2 会由 ControlStore.load() 将 v1 的 accept_edits/auto 以及 Plan
 * previous_mode 原子迁移为 smart_auto/full_access。
 */
import { nowTs } from '../util/time'
import { randomUUID } from 'node:crypto'

export const SCHEMA_VERSION = 2
const SAFE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/

export enum ControlMode {
  ASK_BEFORE_EDIT = 'ask_before_edit',
  SMART_AUTO = 'smart_auto',
  FULL_ACCESS = 'full_access',
  PLAN = 'plan',
}

export enum InteractionKind {
  ASK = 'ask',
  PLAN = 'plan',
}

export enum InteractionStatus {
  WAITING = 'waiting',
  ANSWERED = 'answered',
  COMMENTED = 'commented',
  APPROVED = 'approved',
  CANCELLED = 'cancelled',
}

const INTERACTION_KINDS = new Set<string>(Object.values(InteractionKind))
const INTERACTION_STATUSES = new Set<string>(Object.values(InteractionStatus))
const CONTROL_MODES = new Set<string>(Object.values(ControlMode))

export function nowTsControl(): number {
  return nowTs()
}

export function newInteractionId(kind: string): string {
  return `${kind}_${randomUUID().replace(/-/g, '').slice(0, 12)}`
}

export function safeId(value: string, label = 'id'): string {
  const text = String(value ?? '').trim()
  if (!SAFE_ID_RE.test(text)) {
    throw new Error(`${label} must match [a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}`)
  }
  return text
}

// ── QuestionOption ──

export interface QuestionOption {
  id?: string
  label: string
  description: string
}

export interface QuestionOptionPayload {
  id?: string
  label: string
  description: string
}

export function questionOptionFromDict(
  raw: Record<string, unknown>,
): QuestionOption {
  const label = String(raw.label ?? '').trim()
  if (!label) throw new Error('option label is required')
  const idRaw = String(raw.id ?? '').trim()
  return {
    ...(idRaw ? { id: safeId(idRaw, 'option id') } : {}),
    label: label.slice(0, 80),
    description: String(raw.description ?? '')
      .trim()
      .slice(0, 240),
  }
}

export function questionOptionToDict(o: QuestionOption): QuestionOptionPayload {
  return {
    ...(o.id ? { id: o.id } : {}),
    label: o.label,
    description: o.description,
  }
}

// ── Question ──

export interface Question {
  id: string
  header: string
  question: string
  options: QuestionOption[]
}

export interface QuestionPayload {
  id: string
  header: string
  question: string
  options: QuestionOptionPayload[]
}

export function questionFromDict(raw: Record<string, unknown>): Question {
  const qid = safeId(String(raw.id ?? ''), 'question id')
  const header = String(raw.header ?? '').trim()
  const text = String(raw.question ?? '').trim()
  if (!header || !text)
    throw new Error('question header and question are required')
  const optionsRaw = raw.options ?? []
  if (!Array.isArray(optionsRaw))
    throw new Error('question options must be an array')
  const options = optionsRaw
    .filter((item) => item && typeof item === 'object')
    .map((item) => questionOptionFromDict(item as Record<string, unknown>))
  if (options.length < 2 || options.length > 4)
    throw new Error('each question must have 2-4 options')
  return {
    id: qid,
    header: header.slice(0, 24),
    question: text.slice(0, 400),
    options,
  }
}

export function questionToDict(q: Question): QuestionPayload {
  return {
    id: q.id,
    header: q.header,
    question: q.question,
    options: q.options.map(questionOptionToDict),
  }
}

// ── Interaction ──

export interface Interaction {
  id: string
  kind: string
  status: string
  createdAt: number
  updatedAt: number
  parentCallId: string | null
  context: string
  questions: Question[]
  answers: Record<string, unknown>
  title: string
  summary: string
  planMarkdown: string
  assumptions: string[]
  riskLevel: string
  comments: Array<Record<string, unknown>>
  meta: Record<string, unknown>
}

export interface InteractionCommentPayload {
  content?: string
  timestamp?: number
  [key: string]: unknown
}

export interface InteractionPayload {
  id: string
  kind: string
  status: string
  created_at: number
  updated_at: number
  parent_call_id: string | null
  context: string
  questions: QuestionPayload[]
  answers: Record<string, unknown>
  title: string
  summary: string
  plan_markdown: string
  assumptions: string[]
  risk_level: string
  comments: InteractionCommentPayload[]
  meta: Record<string, unknown>
  [key: string]: unknown
}

export function makeAsk(opts: {
  id?: string
  questions: Question[]
  context?: string
  parentCallId?: string | null
  meta?: Record<string, unknown> | null
}): Interaction {
  if (opts.questions.length < 1 || opts.questions.length > 3)
    throw new Error('ask_user requires 1-3 questions')
  return {
    id: opts.id
      ? safeId(opts.id, 'interaction id')
      : newInteractionId(InteractionKind.ASK),
    kind: InteractionKind.ASK,
    status: InteractionStatus.WAITING,
    createdAt: nowTs(),
    updatedAt: nowTs(),
    parentCallId: opts.parentCallId ?? null,
    context: (opts.context ?? '').trim().slice(0, 1000),
    questions: opts.questions,
    answers: {},
    title: '',
    summary: '',
    planMarkdown: '',
    assumptions: [],
    riskLevel: 'medium',
    comments: [],
    meta: opts.meta ?? {},
  }
}

export function makePlanInteraction(opts: {
  title: string
  summary: string
  planMarkdown: string
  assumptions?: string[] | null
  riskLevel?: string
  parentCallId?: string | null
  meta?: Record<string, unknown> | null
}): Interaction {
  const title = opts.title.trim()
  const summary = opts.summary.trim()
  const planMarkdown = opts.planMarkdown.trim()
  if (!title || !summary || !planMarkdown)
    throw new Error('title, summary and plan_markdown are required')
  return {
    id: newInteractionId(InteractionKind.PLAN),
    kind: InteractionKind.PLAN,
    status: InteractionStatus.WAITING,
    createdAt: nowTs(),
    updatedAt: nowTs(),
    parentCallId: opts.parentCallId ?? null,
    context: '',
    questions: [],
    answers: {},
    title: title.slice(0, 160),
    summary: summary.slice(0, 1200),
    planMarkdown,
    assumptions: (opts.assumptions ?? [])
      .map((item) => String(item).trim().slice(0, 300))
      .filter((item) => item),
    riskLevel: (opts.riskLevel || 'medium').trim().toLowerCase().slice(0, 24),
    comments: [],
    meta: opts.meta ?? {},
  }
}

export function interactionFromDict(raw: Record<string, unknown>): Interaction {
  const kind = String(raw.kind ?? '')
  if (!INTERACTION_KINDS.has(kind))
    throw new Error(`unknown interaction kind: ${kind}`)
  let status = String(raw.status ?? InteractionStatus.WAITING)
  if (!INTERACTION_STATUSES.has(status)) status = InteractionStatus.WAITING
  const questions: Question[] = []
  for (const item of (raw.questions as unknown[]) ?? []) {
    if (item && typeof item === 'object')
      questions.push(questionFromDict(item as Record<string, unknown>))
  }
  const commentsRaw = Array.isArray(raw.comments) ? raw.comments : []
  const parentCallId =
    String(raw.parent_call_id ?? raw.parentCallId ?? '') || null
  return {
    id: safeId(String(raw.id ?? newInteractionId(kind)), 'interaction id'),
    kind,
    status,
    createdAt: Number(raw.created_at ?? raw.createdAt ?? nowTs()),
    updatedAt: Number(raw.updated_at ?? raw.updatedAt ?? nowTs()),
    parentCallId,
    context: String(raw.context ?? ''),
    questions,
    answers:
      raw.answers &&
      typeof raw.answers === 'object' &&
      !Array.isArray(raw.answers)
        ? (raw.answers as Record<string, unknown>)
        : {},
    title: String(raw.title ?? ''),
    summary: String(raw.summary ?? ''),
    planMarkdown: String(raw.plan_markdown ?? raw.planMarkdown ?? ''),
    assumptions: ((raw.assumptions as unknown[]) ?? []).map((item) =>
      String(item),
    ),
    riskLevel: String(raw.risk_level ?? raw.riskLevel ?? 'medium'),
    comments: commentsRaw.filter(
      (item) => item && typeof item === 'object',
    ) as Array<Record<string, unknown>>,
    meta:
      raw.meta && typeof raw.meta === 'object' && !Array.isArray(raw.meta)
        ? (raw.meta as Record<string, unknown>)
        : {},
  }
}

export function interactionToDict(i: Interaction): InteractionPayload {
  return {
    id: i.id,
    kind: i.kind,
    status: i.status,
    created_at: i.createdAt,
    updated_at: i.updatedAt,
    parent_call_id: i.parentCallId,
    context: i.context,
    questions: i.questions.map(questionToDict),
    answers: i.answers,
    title: i.title,
    summary: i.summary,
    plan_markdown: i.planMarkdown,
    assumptions: [...i.assumptions],
    risk_level: i.riskLevel,
    comments: i.comments.map(interactionCommentPayload),
    meta: { ...i.meta },
  }
}

/**
 * Public Renderer/runtime projection. Core-signed Plan execution requests stay
 * in the private ControlStore and settlement store; the UI only needs stable
 * option IDs and safe ownership metadata.
 */
export function interactionToPublicDict(i: Interaction): InteractionPayload {
  const payload = interactionToDict(i)
  if (payload.meta?.interaction_type === 'plan_execution') {
    const meta = { ...payload.meta }
    delete meta.plan_execution_action_request
    payload.meta = meta
  }
  return payload
}

export function touchInteraction(
  i: Interaction,
  opts?: { status?: string },
): Interaction {
  const data = interactionToDict(i)
  if (opts?.status) data.status = opts.status
  data.updated_at = nowTs()
  return interactionFromDict(data)
}

// ── ControlState ──

export interface ControlState {
  version: number
  mode: string
  previousMode: string | null
  pending: Interaction | null
  lastInteraction: Interaction | null
  updatedAt: number
}

export interface ControlStatePayload {
  version: number
  mode: string
  previous_mode:
    | ControlMode.ASK_BEFORE_EDIT
    | ControlMode.SMART_AUTO
    | ControlMode.FULL_ACCESS
    | null
  pending: InteractionPayload | null
  last_interaction: InteractionPayload | null
  updated_at: number
  [key: string]: unknown
}

export function defaultControlState(): ControlState {
  return {
    version: SCHEMA_VERSION,
    mode: ControlMode.ASK_BEFORE_EDIT,
    previousMode: null,
    pending: null,
    lastInteraction: null,
    updatedAt: nowTs(),
  }
}

function parseInteractionSafe(value: unknown): Interaction | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  try {
    return interactionFromDict(value as Record<string, unknown>)
  } catch {
    return null
  }
}

export function controlStateFromDict(
  raw: Record<string, unknown>,
): ControlState {
  const sourceVersion = Number(raw.version ?? 1) || 1
  let mode = String(raw.mode ?? ControlMode.ASK_BEFORE_EDIT)
  mode = migratePermissionMode(mode, sourceVersion)
  if (!CONTROL_MODES.has(mode)) mode = ControlMode.ASK_BEFORE_EDIT
  let previousMode: string | null =
    String(raw.previous_mode ?? raw.previousMode ?? '') || null
  if (previousMode)
    previousMode = migratePermissionMode(previousMode, sourceVersion)
  if (
    previousMode !== ControlMode.ASK_BEFORE_EDIT &&
    previousMode !== ControlMode.SMART_AUTO &&
    previousMode !== ControlMode.FULL_ACCESS
  )
    previousMode = null
  return {
    version: SCHEMA_VERSION,
    mode,
    previousMode,
    pending: parseInteractionSafe(raw.pending),
    lastInteraction: parseInteractionSafe(
      raw.last_interaction ?? raw.lastInteraction,
    ),
    updatedAt: Number(raw.updated_at ?? raw.updatedAt ?? nowTs()),
  }
}

export function controlStateToDict(s: ControlState): ControlStatePayload {
  return {
    version: s.version,
    mode: s.mode,
    previous_mode: previousModePayload(s.previousMode),
    pending: s.pending ? interactionToDict(s.pending) : null,
    last_interaction: s.lastInteraction
      ? interactionToDict(s.lastInteraction)
      : null,
    updated_at: s.updatedAt,
  }
}

export function controlStateToPublicDict(s: ControlState): ControlStatePayload {
  const payload = controlStateToDict(s)
  payload.pending = s.pending ? interactionToPublicDict(s.pending) : null
  payload.last_interaction = s.lastInteraction
    ? interactionToPublicDict(s.lastInteraction)
    : null
  return payload
}

function interactionCommentPayload(
  value: Record<string, unknown>,
): InteractionCommentPayload {
  const { content, timestamp, ...rest } = value
  return {
    ...rest,
    ...(typeof content === 'string' ? { content } : {}),
    ...(typeof timestamp === 'number' ? { timestamp } : {}),
  }
}

function previousModePayload(
  value: string | null,
): ControlStatePayload['previous_mode'] {
  return value === ControlMode.ASK_BEFORE_EDIT ||
    value === ControlMode.SMART_AUTO ||
    value === ControlMode.FULL_ACCESS
    ? value
    : null
}

function migratePermissionMode(value: string, sourceVersion: number): string {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase()
  if (!normalized || normalized === 'normal') return ControlMode.ASK_BEFORE_EDIT
  if (normalized === 'accept_edits') return ControlMode.SMART_AUTO
  if (normalized === 'auto') return ControlMode.FULL_ACCESS
  if (sourceVersion < SCHEMA_VERSION) {
    if (normalized === 'accept-edits' || normalized === 'accept edits')
      return ControlMode.SMART_AUTO
    if (normalized === 'automatic') return ControlMode.FULL_ACCESS
  }
  return normalized
}
