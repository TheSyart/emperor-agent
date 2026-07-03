/**
 * Plan 领域模型 (MIG-CTRL-012)。对齐 Python `agent/plans/models.py`。
 * 磁盘兼容: PlanRecord/Step/DraftState/Discovery 的 from_dict/to_dict 字段与回退逐字保真。
 */
import {
  requirementFromDict,
  requirementToDict,
  type VerificationRequirement,
} from './verification'

export enum PlanStatus {
  DRAFT = 'draft',
  WAITING_APPROVAL = 'waiting_approval',
  APPROVED = 'approved',
  EXECUTING = 'executing',
  COMPLETED = 'completed',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
}

export enum PlanStepStatus {
  PENDING = 'pending',
  ACTIVE = 'active',
  DONE = 'done',
  FAILED = 'failed',
  BLOCKED = 'blocked',
  SKIPPED = 'skipped',
}

export enum PlanDraftPhase {
  EXPLORING = 'exploring',
  QUESTIONING = 'questioning',
  DESIGNING = 'designing',
  REVIEWING = 'reviewing',
  READY_FOR_APPROVAL = 'ready_for_approval',
  APPROVED = 'approved',
  EXECUTING = 'executing',
}

const PLAN_STATUSES = new Set<string>(Object.values(PlanStatus))
const PLAN_STEP_STATUSES = new Set<string>(Object.values(PlanStepStatus))
const PLAN_DRAFT_PHASES = new Set<string>(Object.values(PlanDraftPhase))

function validValue(value: unknown, allowed: Set<string>, fallback: string): string {
  const text = String(value ?? '').trim()
  return allowed.has(text) ? text : fallback
}

function stringList(value: unknown, limit = 120): string[] {
  if (!Array.isArray(value)) return []
  const result: string[] = []
  for (const item of value.slice(0, limit)) {
    const text = String(item ?? '').trim()
    if (text) result.push(text)
  }
  return result
}

function dictList(value: unknown, limit = 120): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return []
  return value.slice(0, limit).filter((item) => item && typeof item === 'object' && !Array.isArray(item)).map((item) => ({ ...(item as Record<string, unknown>) }))
}

function optionalFloat(value: unknown): number | null {
  if (value === null || value === undefined) return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

// ── PlanDiscovery ──

export interface PlanDiscovery {
  id: string
  source: string
  summary: string
  files: string[]
  symbols: string[]
  evidenceRefs: string[]
  createdAt: number
}

export function discoveryToDict(d: PlanDiscovery): Record<string, unknown> {
  return {
    id: d.id,
    source: d.source,
    summary: d.summary,
    files: d.files,
    symbols: d.symbols,
    evidence_refs: d.evidenceRefs,
    created_at: d.createdAt,
  }
}

function legacyDiscoveryFiles(raw: Record<string, unknown>): string[] {
  const files: string[] = []
  for (const key of ['path', 'file']) {
    const value = String(raw[key] ?? '').trim()
    if (value) files.push(value)
  }
  return files
}

export function discoveryFromDict(raw: Record<string, unknown>): PlanDiscovery {
  return {
    id: String(raw.id ?? ''),
    source: String(raw.source ?? '').trim().slice(0, 80),
    summary: String(raw.summary ?? '').trim().slice(0, 1200),
    files: stringList(raw.files ?? legacyDiscoveryFiles(raw)),
    symbols: stringList(raw.symbols),
    evidenceRefs: stringList(raw.evidence_refs ?? raw.evidenceRefs),
    createdAt: Number(raw.created_at ?? raw.createdAt ?? 0) || 0,
  }
}

// ── PlanDraftState ──

export interface PlanDraftState {
  phase: string
  discoveries: Array<Record<string, unknown>>
  relevantFiles: string[]
  openQuestions: Array<Record<string, unknown>>
  resolvedQuestions: Array<Record<string, unknown>>
  alternativesConsidered: string[]
  recommendedApproach: string
  verificationStrategy: string[]
  lastContextRefreshAt: number | null
}

export function emptyDraft(): PlanDraftState {
  return {
    phase: PlanDraftPhase.EXPLORING,
    discoveries: [],
    relevantFiles: [],
    openQuestions: [],
    resolvedQuestions: [],
    alternativesConsidered: [],
    recommendedApproach: '',
    verificationStrategy: [],
    lastContextRefreshAt: null,
  }
}

export function draftToDict(d: PlanDraftState): Record<string, unknown> {
  return {
    phase: d.phase,
    discoveries: d.discoveries,
    relevant_files: d.relevantFiles,
    open_questions: d.openQuestions,
    resolved_questions: d.resolvedQuestions,
    alternatives_considered: d.alternativesConsidered,
    recommended_approach: d.recommendedApproach,
    verification_strategy: d.verificationStrategy,
    last_context_refresh_at: d.lastContextRefreshAt,
  }
}

export function draftFromDict(raw: Record<string, unknown> | null | undefined): PlanDraftState {
  if (!raw || typeof raw !== 'object') return emptyDraft()
  return {
    phase: validValue(raw.phase, PLAN_DRAFT_PHASES, PlanDraftPhase.EXPLORING),
    discoveries: dictList(raw.discoveries),
    relevantFiles: stringList(raw.relevant_files),
    openQuestions: dictList(raw.open_questions),
    resolvedQuestions: dictList(raw.resolved_questions),
    alternativesConsidered: stringList(raw.alternatives_considered),
    recommendedApproach: String(raw.recommended_approach ?? '').trim().slice(0, 1200),
    verificationStrategy: stringList(raw.verification_strategy),
    lastContextRefreshAt: optionalFloat(raw.last_context_refresh_at),
  }
}

// ── PlanStep ──

export interface PlanStep {
  id: string
  title: string
  status: string
  description: string
  files: string[]
  commands: string[]
  acceptance: string[]
  discoveryRefs: string[]
  verification: VerificationRequirement[]
  evidence: Array<Record<string, unknown>>
  risk: string
  riskNote: string
  rollback: string
}

export function makeStep(p: Partial<PlanStep> & { id: string; title: string }): PlanStep {
  return {
    id: p.id,
    title: p.title,
    status: p.status ?? PlanStepStatus.PENDING,
    description: p.description ?? '',
    files: p.files ?? [],
    commands: p.commands ?? [],
    acceptance: p.acceptance ?? [],
    discoveryRefs: p.discoveryRefs ?? [],
    verification: p.verification ?? [],
    evidence: p.evidence ?? [],
    risk: p.risk ?? 'medium',
    riskNote: p.riskNote ?? '',
    rollback: p.rollback ?? '',
  }
}

export function stepToDict(s: PlanStep): Record<string, unknown> {
  return {
    id: s.id,
    title: s.title,
    status: s.status,
    description: s.description,
    files: s.files,
    commands: s.commands,
    acceptance: s.acceptance,
    discovery_refs: s.discoveryRefs,
    verification: s.verification.map(requirementToDict),
    evidence: s.evidence,
    risk: s.risk,
    risk_note: s.riskNote,
    rollback: s.rollback,
  }
}

export function stepFromDict(raw: Record<string, unknown>): PlanStep {
  const verificationRaw = (raw.verification ?? raw.verification_requirements ?? []) as unknown[]
  return {
    id: String(raw.id),
    title: String(raw.title),
    status: validValue(raw.status, PLAN_STEP_STATUSES, PlanStepStatus.PENDING),
    description: String(raw.description ?? ''),
    files: ((raw.files ?? []) as unknown[]).map((v) => String(v)),
    commands: ((raw.commands ?? []) as unknown[]).map((v) => String(v)),
    acceptance: ((raw.acceptance ?? []) as unknown[]).map((v) => String(v)),
    discoveryRefs: ((raw.discovery_refs ?? raw.discoveryRefs ?? []) as unknown[])
      .map((v) => String(v))
      .filter((v) => v.trim()),
    verification: verificationRaw
      .filter((item) => item && typeof item === 'object')
      .map((item) => requirementFromDict(item as Record<string, unknown>)),
    evidence: ((raw.evidence ?? []) as unknown[]).filter((item) => item && typeof item === 'object') as Array<Record<string, unknown>>,
    risk: String(raw.risk ?? 'medium'),
    riskNote: String(raw.risk_note ?? raw.riskNote ?? ''),
    rollback: String(raw.rollback ?? raw.rollback_path ?? raw.rollbackPath ?? ''),
  }
}

// ── PlanRecord ──

export interface PlanRecord {
  id: string
  title: string
  summary: string
  status: string
  createdAt: number
  updatedAt: number
  sessionId: string | null
  sourceInteractionId: string | null
  approvedAt: number | null
  completedAt: number | null
  planMarkdown: string
  assumptions: string[]
  steps: PlanStep[]
  verification: Array<Record<string, unknown>>
  draft: PlanDraftState
  metadata: Record<string, unknown>
}

export function makePlanRecord(p: Partial<PlanRecord> & { id: string; title: string; summary: string; status: string; createdAt: number; updatedAt: number }): PlanRecord {
  return {
    id: p.id,
    title: p.title,
    summary: p.summary,
    status: p.status,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    sessionId: p.sessionId ?? null,
    sourceInteractionId: p.sourceInteractionId ?? null,
    approvedAt: p.approvedAt ?? null,
    completedAt: p.completedAt ?? null,
    planMarkdown: p.planMarkdown ?? '',
    assumptions: p.assumptions ?? [],
    steps: p.steps ?? [],
    verification: p.verification ?? [],
    draft: p.draft ?? emptyDraft(),
    metadata: p.metadata ?? {},
  }
}

export function planToDict(r: PlanRecord): Record<string, unknown> {
  return {
    id: r.id,
    title: r.title,
    summary: r.summary,
    status: r.status,
    created_at: r.createdAt,
    updated_at: r.updatedAt,
    session_id: r.sessionId,
    source_interaction_id: r.sourceInteractionId,
    approved_at: r.approvedAt,
    completed_at: r.completedAt,
    plan_markdown: r.planMarkdown,
    assumptions: r.assumptions,
    steps: r.steps.map(stepToDict),
    verification: r.verification,
    draft: draftToDict(r.draft),
    metadata: r.metadata,
  }
}

export function planFromDict(raw: Record<string, unknown>): PlanRecord {
  const metadata = { ...((raw.metadata as Record<string, unknown>) ?? {}) }
  return {
    id: String(raw.id),
    title: String(raw.title),
    summary: String(raw.summary),
    status: validValue(raw.status, PLAN_STATUSES, PlanStatus.DRAFT),
    createdAt: Number(raw.created_at),
    updatedAt: Number(raw.updated_at),
    sessionId: (raw.session_id ?? null) as string | null,
    sourceInteractionId: (raw.source_interaction_id ?? null) as string | null,
    approvedAt: (raw.approved_at ?? null) as number | null,
    completedAt: (raw.completed_at ?? null) as number | null,
    planMarkdown: String(raw.plan_markdown ?? ''),
    assumptions: ((raw.assumptions ?? []) as unknown[]).map((v) => String(v)),
    steps: ((raw.steps ?? []) as unknown[])
      .filter((item) => item && typeof item === 'object')
      .map((item) => stepFromDict(item as Record<string, unknown>)),
    verification: ((raw.verification ?? []) as unknown[]).filter((item) => item && typeof item === 'object') as Array<Record<string, unknown>>,
    draft: draftFromDict((raw.draft as Record<string, unknown>) ?? (metadata.draft as Record<string, unknown>)),
    metadata,
  }
}
