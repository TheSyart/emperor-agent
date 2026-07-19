/**
 * 权限模型 (MIG-CTRL-014)。对齐 Python `agent/permissions/models.py`。
 * PermissionDecision 字段集合: allowed/requiresApproval/risk/reason/toolName/arguments/rule/trace —— 无 `behavior`。
 */
import { createHash } from 'node:crypto'
import type { ShellAstSummary } from './shell-ast'
import type {
  PermissionRuleAction,
  PermissionRuleCandidate,
  PermissionRuleSource,
} from './rules'

export enum PermissionMode {
  ASK_BEFORE_EDIT = 'ask_before_edit',
  ACCEPT_EDITS = 'accept_edits',
  AUTO = 'auto',
  PLAN = 'plan',
}

export enum RiskLevel {
  LOW = 'low',
  MEDIUM = 'medium',
  HIGH = 'high',
}

export interface PermissionTraceEntry {
  rule: string
  outcome: string
  detail: string
}

export function traceEntry(
  rule: string,
  outcome: string,
  detail = '',
): PermissionTraceEntry {
  return { rule, outcome, detail }
}

export interface ToolPermissionProfile {
  name: string
  arguments: Record<string, unknown>
  readOnly: boolean
  concurrencySafe: boolean
  destructive: boolean
  path: string | null
  paths: string[]
  command: string
  schedulerAction: string
}

export function makeProfile(
  p: Partial<ToolPermissionProfile> & { name: string },
): ToolPermissionProfile {
  return {
    name: p.name,
    arguments: p.arguments ?? {},
    readOnly: p.readOnly ?? false,
    concurrencySafe: p.concurrencySafe ?? false,
    destructive: p.destructive ?? true,
    path: p.path ?? null,
    paths: p.paths ?? (p.path ? [p.path] : []),
    command: p.command ?? '',
    schedulerAction: p.schedulerAction ?? '',
  }
}

export interface PlanPermissionToken {
  planId: string
  stepId: string
  toolName: string
  argumentHash: string
  expiresAt: number
  usesRemaining: number
  reason: string
}

export function planPermissionTokenFromDict(
  raw: Record<string, unknown>,
): PlanPermissionToken {
  const s = (a: unknown, b: unknown): string => String(a ?? b ?? '')
  const n = (a: unknown, b: unknown): number => Number(a ?? b ?? 0) || 0
  return {
    planId: s(raw.plan_id, raw.planId),
    stepId: s(raw.step_id, raw.stepId),
    toolName: s(raw.tool_name, raw.toolName),
    argumentHash: s(raw.argument_hash, raw.argumentHash),
    expiresAt: n(raw.expires_at, raw.expiresAt),
    usesRemaining: Math.max(
      0,
      Math.trunc(n(raw.uses_remaining, raw.usesRemaining)),
    ),
    reason: String(raw.reason ?? ''),
  }
}

export interface PermissionDecision {
  allowed: boolean
  requiresApproval: boolean
  risk: string
  reason: string
  toolName: string
  arguments: Record<string, unknown> | null
  rule: string
  trace: PermissionTraceEntry[]
  explanation?: PermissionDecisionExplanation
}

export interface PermissionDecisionExplanation {
  version: 1
  candidates: PermissionRuleCandidate[]
  selected: {
    id: string
    action: PermissionRuleAction
    source: PermissionRuleSource
    precedence: string
  }
  shell?: ShellAstSummary
}

export const PermissionDecision = {
  allow(opts: {
    toolName: string
    arguments?: Record<string, unknown> | null
    rule?: string
    trace?: PermissionTraceEntry[]
    explanation?: PermissionDecisionExplanation
  }): PermissionDecision {
    return {
      allowed: true,
      requiresApproval: false,
      risk: RiskLevel.LOW,
      reason: '',
      toolName: opts.toolName,
      arguments: opts.arguments ?? {},
      rule: opts.rule ?? '',
      trace: opts.trace ?? [],
      ...(opts.explanation ? { explanation: opts.explanation } : {}),
    }
  },
  deny(opts: {
    toolName: string
    reason: string
    arguments?: Record<string, unknown> | null
    rule?: string
    trace?: PermissionTraceEntry[]
    explanation?: PermissionDecisionExplanation
  }): PermissionDecision {
    return {
      allowed: false,
      requiresApproval: false,
      risk: RiskLevel.HIGH,
      reason: opts.reason,
      toolName: opts.toolName,
      arguments: opts.arguments ?? {},
      rule: opts.rule ?? '',
      trace: opts.trace ?? [],
      ...(opts.explanation ? { explanation: opts.explanation } : {}),
    }
  },
  approval(opts: {
    toolName: string
    reason: string
    arguments?: Record<string, unknown> | null
    risk?: string
    rule?: string
    trace?: PermissionTraceEntry[]
    explanation?: PermissionDecisionExplanation
  }): PermissionDecision {
    return {
      allowed: false,
      requiresApproval: true,
      risk: opts.risk ?? RiskLevel.HIGH,
      reason: opts.reason,
      toolName: opts.toolName,
      arguments: opts.arguments ?? {},
      rule: opts.rule ?? '',
      trace: opts.trace ?? [],
      ...(opts.explanation ? { explanation: opts.explanation } : {}),
    }
  },
}

/** 稳定 JSON: sort_keys + 无空格。对齐 Python json.dumps(..., sort_keys=True, separators=(",",":"))。 */
export function stableJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(jsonSafe(value)))
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeysDeep((value as Record<string, unknown>)[key])
    }
    return out
  }
  return value
}

function jsonSafe(value: unknown): unknown {
  if (value === null || value === undefined) return value
  if (Array.isArray(value)) return value.map(jsonSafe)
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>))
      out[String(k)] = jsonSafe(v)
    return out
  }
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  )
    return value
  return String(value)
}

export function permissionArgumentHash(args: Record<string, unknown>): string {
  return createHash('sha256')
    .update(stableJson(args ?? {}), 'utf8')
    .digest('hex')
}
