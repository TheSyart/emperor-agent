/**
 * PlanDraftingManager (MIG-CTRL-006)。对齐 Python `agent/control/plan_drafting.py`。
 * propose_plan / 草稿生命周期 / discovery ledger / draft Q&A / executing-plan 豁免。
 */
import { nowTs } from '../util/time'
import { randomUUID } from 'node:crypto'
import {
  PlanDraftPhase,
  PlanStatus,
  discoveryToDict,
  emptyDraft,
  makePlanRecord,
  type PlanRecord,
} from '../plans/models'
import { PlanQualityGate } from '../plans/quality'
import { CONTROL_RESUME_RE } from './clarification'
import { ControlMode, InteractionStatus, makePlanInteraction, type Interaction } from './models'
import { PlanDecision } from './plan-policy'
import {
  dedupeStrings,
  firstHeading,
  looksLikePlan,
  metadataWithoutPlanPermissionTokens,
  parsePlanSteps,
  plainSummary,
  readyForApprovalDraft,
} from './plan-helpers'
import type { ControlManagerHost } from './host'

export class PlanDraftingManager {
  private readonly cm: ControlManagerHost
  constructor(cm: ControlManagerHost) { this.cm = cm }

  createPlan(opts: {
    title: string
    summary: string
    planMarkdown: string
    assumptions?: string[] | null
    riskLevel?: string
    steps?: Array<Record<string, unknown>> | null
    parentCallId?: string | null
    meta?: Record<string, unknown> | null
    enforceQuality?: boolean
  }): Interaction {
    this.cm.ensureNoPending()
    const planMeta = { ...(opts.meta ?? {}) }
    const existing = this.planRecordForMeta(planMeta) ?? this.latestDraftPlan()
    const planId = existing !== null ? existing.id : `plan_${randomUUID().replace(/-/g, '').slice(0, 12)}`
    const now = nowTs()
    const structuredSteps = parsePlanSteps(opts.steps ?? [])
    const interaction = makePlanInteraction({
      title: opts.title,
      summary: opts.summary,
      planMarkdown: opts.planMarkdown,
      assumptions: opts.assumptions,
      riskLevel: opts.riskLevel ?? 'medium',
      parentCallId: opts.parentCallId,
      meta: { ...planMeta, plan_id: planId },
    })
    const draft = readyForApprovalDraft(existing !== null ? existing.draft : emptyDraft(), {
      summary: interaction.summary,
      steps: structuredSteps,
    })
    if (opts.enforceQuality) {
      new PlanQualityGate().requireOk({ steps: structuredSteps, draft })
    }
    const scope = this.cm.planScopeMetadata()
    this.cm.planStore.save(
      makePlanRecord({
        id: planId,
        title: interaction.title,
        summary: interaction.summary,
        status: PlanStatus.WAITING_APPROVAL,
        createdAt: existing !== null ? existing.createdAt : now,
        updatedAt: now,
        sessionId: (scope?.session_id as string | undefined) ?? null,
        sourceInteractionId: interaction.id,
        planMarkdown: interaction.planMarkdown,
        assumptions: [...interaction.assumptions],
        steps: structuredSteps,
        draft,
        metadata: metadataWithoutPlanPermissionTokens({
          ...(existing !== null ? existing.metadata : {}),
          risk_level: interaction.riskLevel,
          ...(scope ? { scope } : {}),
        }),
      }),
    )
    this.cm.setPending(interaction)
    return interaction
  }

  createPlanFromText(text: string): Interaction {
    let body = String(text ?? '').trim()
    if (!body) body = 'Plan 模式要求先提交可预览计划。'
    const title = firstHeading(body) || '计划预览'
    const summary = plainSummary(body)
    if (!looksLikePlan(body)) {
      body = ['# 计划预览', '', body, '', '## 验收', '- 用户批准后再执行任何写入或高影响操作。'].join('\n')
    }
    return this.createPlan({ title, summary, planMarkdown: body, assumptions: [], riskLevel: 'medium' })
  }

  assessPlanDecision(userMessage: string): PlanDecision {
    const state = this.cm.store.load()
    const hasPending = Boolean(state.pending && state.pending.status === InteractionStatus.WAITING)
    if (CONTROL_RESUME_RE.test(String(userMessage ?? '')) && this.cm.latestExecutablePlan() !== null) {
      return new PlanDecision(
        'proceed',
        'Approved plan is already executing; continuation control messages do not re-trigger the plan guard.',
        ['executing_plan'],
      )
    }
    return this.cm.planDecisionPolicy.assess(userMessage, { mode: state.mode, hasPending })
  }

  recordPlanDiscovery(opts: {
    source: string
    summary: string
    files?: string[] | null
    symbols?: string[] | null
    evidenceRefs?: string[] | null
  }): PlanRecord | null {
    if (this.cm.mode !== ControlMode.PLAN) return null
    const text = String(opts.summary ?? '').trim()
    if (!text) return null
    const now = nowTs()
    const record = this.ensurePlanDraft()
    const files = dedupeStrings(opts.files ?? [])
    const discovery = discoveryToDict({
      id: `disc_${randomUUID().replace(/-/g, '').slice(0, 10)}`,
      source: String(opts.source ?? 'tool').trim().slice(0, 80),
      summary: text.slice(0, 1200),
      files,
      symbols: dedupeStrings(opts.symbols ?? []),
      evidenceRefs: dedupeStrings(opts.evidenceRefs ?? []),
      createdAt: now,
    })
    const discoveries = [...record.draft.discoveries, discovery].slice(-80)
    const draft = {
      ...record.draft,
      discoveries,
      relevantFiles: dedupeStrings([...record.draft.relevantFiles, ...files]),
      lastContextRefreshAt: now,
    }
    const updated = { ...record, updatedAt: now, draft }
    this.cm.planStore.save(updated)
    return updated
  }

  ensurePlanDraft(): PlanRecord {
    const existing = this.latestDraftPlan()
    if (existing !== null) return existing
    const now = nowTs()
    const scope = this.cm.planScopeMetadata()
    const record = makePlanRecord({
      id: `plan_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      title: 'Plan Draft',
      summary: 'Plan mode draft',
      status: PlanStatus.DRAFT,
      createdAt: now,
      updatedAt: now,
      sessionId: (scope?.session_id as string | undefined) ?? null,
      draft: { ...emptyDraft(), phase: PlanDraftPhase.EXPLORING },
      metadata: { risk_level: 'medium', ...(scope ? { scope } : {}) },
    })
    this.cm.planStore.save(record)
    return record
  }

  private latestDraftPlan(): PlanRecord | null {
    const plans = this.cm.planStore.list().filter((p) => p.status === PlanStatus.DRAFT && this.cm.planMatchesCurrentScope(p))
    if (!plans.length) return null
    return plans.reduce((a, b) => (b.updatedAt > a.updatedAt ? b : a))
  }

  private planRecordForMeta(meta: Record<string, unknown>): PlanRecord | null {
    const planId = String(meta.plan_id ?? '')
    const record = planId ? this.cm.planStore.get(planId) : null
    return record && this.cm.planMatchesCurrentScope(record) ? record : null
  }

  recordPlanOpenQuestions(interaction: Interaction): void {
    const record = this.planRecordForMeta(interaction.meta)
    if (record === null) return
    const openQuestions = [...record.draft.openQuestions]
    for (const question of interaction.questions) {
      openQuestions.push({
        interaction_id: interaction.id,
        id: question.id,
        header: question.header,
        question: question.question,
        options: question.options.map((o) => o.label),
        context: interaction.context,
      })
    }
    const draft = { ...record.draft, phase: PlanDraftPhase.QUESTIONING, openQuestions }
    this.cm.planStore.save({ ...record, updatedAt: nowTs(), draft })
  }

  recordPlanResolvedQuestions(interaction: Interaction): void {
    const record = this.planRecordForMeta(interaction.meta)
    if (record === null) return
    const questionIds = new Set(interaction.questions.map((q) => q.id))
    const remainingOpen = record.draft.openQuestions.filter(
      (item) => item.interaction_id !== interaction.id || !questionIds.has(item.id as string),
    )
    const resolved = [...record.draft.resolvedQuestions]
    const openById = new Map<string, Record<string, unknown>>()
    for (const item of record.draft.openQuestions) {
      if (item.interaction_id === interaction.id) openById.set(String(item.id), item)
    }
    for (const question of interaction.questions) {
      const answer = (interaction.answers[question.id] as Record<string, unknown>) ?? {}
      const choice = answer && typeof answer === 'object' ? answer.choice : String(answer)
      const freeform = answer && typeof answer === 'object' ? answer.freeform : ''
      const source = openById.get(question.id) ?? {}
      resolved.push({
        interaction_id: interaction.id,
        id: question.id,
        header: question.header,
        question: question.question,
        answer: String(choice ?? '').trim(),
        freeform: String(freeform ?? '').trim(),
        context: String(source.context ?? interaction.context),
      })
    }
    const draft = { ...record.draft, phase: PlanDraftPhase.DESIGNING, openQuestions: remainingOpen, resolvedQuestions: resolved }
    this.cm.planStore.save({ ...record, updatedAt: nowTs(), draft })
  }

  recordPlanComment(interaction: Interaction, comment: string): void {
    const record = this.planRecordForMeta(interaction.meta)
    if (record === null) return
    let metadata = { ...record.metadata }
    const revisions = [...((metadata.revisions as unknown[]) ?? [])]
    revisions.push({
      title: record.title,
      summary: record.summary,
      plan_markdown: record.planMarkdown,
      comment: comment.slice(0, 4000),
      timestamp: nowTs(),
    })
    metadata.revisions = revisions.slice(-20)
    metadata = metadataWithoutPlanPermissionTokens(metadata, { reason: 'plan comment' })
    const draft = { ...record.draft, phase: PlanDraftPhase.REVIEWING }
    this.cm.planStore.save({ ...record, status: PlanStatus.DRAFT, updatedAt: nowTs(), draft, metadata })
  }
}
