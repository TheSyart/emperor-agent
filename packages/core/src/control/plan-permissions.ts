/**
 * PlanPermissionTokenManager。
 * approved plan active step 的一次性 run_command token；高风险命令永不发放 token (PE-13)。
 */
import { nowTs } from '../util/time'
import {
  permissionArgumentHash,
  planPermissionTokenFromDict,
  type PlanPermissionToken,
} from '../permissions/models'
import { isHighRiskCommand } from '../tools/resolvers'
import { PlanStatus, PlanStepStatus, type PlanRecord } from '../plans/models'
import { PlanStoreConflictError } from '../plans/store'
import {
  isPlanInvalidated,
  latestApprovedPlanGeneration,
  metadataWithoutPlanPermissionTokens,
} from './plan-helpers'
import type { ControlManagerHost } from './host'

const PLAN_PERMISSION_TOKEN_TTL_SECONDS = 3600.0

function tokenToDict(t: PlanPermissionToken): Record<string, unknown> {
  return {
    plan_id: t.planId,
    step_id: t.stepId,
    tool_name: t.toolName,
    argument_hash: t.argumentHash,
    expires_at: t.expiresAt,
    uses_remaining: t.usesRemaining,
    reason: t.reason,
  }
}

export class PlanPermissionTokenManager {
  private readonly cm: ControlManagerHost
  constructor(cm: ControlManagerHost) {
    this.cm = cm
  }

  issue(record: PlanRecord): PlanRecord {
    const now = nowTs()
    const tokens: Array<Record<string, unknown>> = []
    for (const step of record.steps) {
      if (step.status !== PlanStepStatus.ACTIVE) continue
      for (const command of step.commands) {
        const text = String(command ?? '')
        if (!text.trim() || isHighRiskCommand(text)) continue
        tokens.push(
          tokenToDict({
            planId: record.id,
            stepId: step.id,
            toolName: 'run_command',
            argumentHash: permissionArgumentHash({ command: text }),
            expiresAt: now + PLAN_PERMISSION_TOKEN_TTL_SECONDS,
            usesRemaining: 1,
            reason: 'approved plan active step verification command',
          }),
        )
      }
    }
    const metadata = { ...record.metadata }
    metadata.permission_tokens = tokens
    return { ...record, metadata }
  }

  consume(opts: {
    toolName: string
    arguments: Record<string, unknown>
  }): PlanPermissionToken | null {
    const record = this.cm.latestExecutablePlan()
    if (record === null || !this.isCurrentExecutableGeneration(record))
      return null
    const activeStepIds = new Set(
      record.steps
        .filter((s) => s.status === PlanStepStatus.ACTIVE)
        .map((s) => s.id),
    )
    if (!activeStepIds.size) return null
    const now = nowTs()
    const targetHash = permissionArgumentHash(opts.arguments ?? {})
    const tokensRaw = record.metadata.permission_tokens ?? []
    if (!Array.isArray(tokensRaw)) return null
    const kept: Array<Record<string, unknown>> = []
    let consumed: PlanPermissionToken | null = null
    let changed = false
    for (const item of tokensRaw) {
      if (!item || typeof item !== 'object') {
        changed = true
        continue
      }
      const token = planPermissionTokenFromDict(item as Record<string, unknown>)
      if (
        token.planId !== record.id ||
        !activeStepIds.has(token.stepId) ||
        token.expiresAt <= now ||
        token.usesRemaining <= 0
      ) {
        changed = true
        continue
      }
      if (
        consumed === null &&
        token.toolName === opts.toolName &&
        token.argumentHash === targetHash
      ) {
        consumed = token
        changed = true
        const remaining = { ...token, usesRemaining: token.usesRemaining - 1 }
        if (remaining.usesRemaining > 0) kept.push(tokenToDict(remaining))
        continue
      }
      kept.push(tokenToDict(token))
    }
    if (changed) {
      if (!this.isCurrentExecutableGeneration(record)) return null
      const metadata = { ...record.metadata }
      metadata.permission_tokens = kept
      try {
        this.cm.planStore.save({ ...record, updatedAt: now, metadata })
      } catch (error) {
        if (error instanceof PlanStoreConflictError) return null
        throw error
      }
    }
    return consumed
  }

  private isCurrentExecutableGeneration(record: PlanRecord): boolean {
    if (
      this.cm.planStore.isExecutionBlocked(record.id) ||
      isPlanInvalidated(record) ||
      (record.status !== PlanStatus.APPROVED &&
        record.status !== PlanStatus.EXECUTING)
    )
      return false
    const current = latestApprovedPlanGeneration(
      this.cm.planStore.list(),
      (item) => this.cm.planMatchesCurrentScope(item),
    )
    return current?.id === record.id && !isPlanInvalidated(current)
  }

  revoke(opts?: {
    planId?: string | null
    reason?: string
  }): PlanRecord | null {
    const record = opts?.planId
      ? this.cm.planStore.get(opts.planId)
      : this.cm.latestExecutablePlan()
    if (record === null) return null
    if (
      !record.metadata.permission_tokens ||
      !(record.metadata.permission_tokens as unknown[]).length
    )
      return record
    const metadata = metadataWithoutPlanPermissionTokens(record.metadata, {
      reason: opts?.reason ?? 'revoked',
    })
    const updated = { ...record, updatedAt: nowTs(), metadata }
    return this.cm.planStore.save(updated)
  }
}
