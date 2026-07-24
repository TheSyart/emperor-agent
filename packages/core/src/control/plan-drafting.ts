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
import {
  ControlMode,
  InteractionStatus,
  makePlanInteraction,
  type Interaction,
} from './models'
import { PlanDecision } from './plan-policy'
import {
  dedupeStrings,
  metadataWithoutPlanPermissionTokens,
  parsePlanSteps,
  readyForApprovalDraft,
} from './plan-helpers'
import type { ControlManagerHost } from './host'

export class PlanDraftingManager {
  private readonly cm: ControlManagerHost
  constructor(cm: ControlManagerHost) {
    this.cm = cm
  }

  promptContext(): string {
    const record = this.latestDraftPlan()
    if (record === null) {
      return [
        '## Active Plan draft',
        '- phase: exploring',
        '- exploration receipts: 0',
        '- approval gate: blocked until successful read-only exploration is recorded',
      ].join('\n')
    }
    const discoveries = record.draft.discoveries
      .map((item) => {
        const id = String(item.id ?? '').trim()
        const source = String(item.source ?? 'tool').trim()
        const summary = String(item.summary ?? '').trim()
        const files = Array.isArray(item.files)
          ? item.files.map((file) => String(file)).filter(Boolean)
          : []
        return `  - ${id} [${source}] ${summary}${files.length ? ` · files: ${files.join(', ')}` : ''}`
      })
      .filter((line) => !line.startsWith('  -  '))
    return [
      '## Active Plan draft',
      `- phase: ${record.draft.phase}`,
      `- exploration receipts: ${discoveries.length}`,
      ...(discoveries.length ? ['- discoveries:', ...discoveries] : []),
      `- unresolved questions: ${record.draft.openQuestions.length}`,
      `- relevant files: ${record.draft.relevantFiles.join(', ') || '(none)'}`,
      '- approval gate: every submitted plan must cite at least one discovery id and have no unresolved questions',
    ].join('\n')
  }

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
    const activeGoal = this.cm.activeGoalPlanContext()
    const planMeta = { ...(opts.meta ?? {}) }
    delete planMeta.goal_id
    delete planMeta.goalId
    delete planMeta.goal_session_id
    if (activeGoal !== null) {
      planMeta.goal_id = activeGoal.id
      planMeta.goal_session_id = activeGoal.scope.sessionId
    }
    const existing = this.planRecordForMeta(planMeta) ?? this.latestDraftPlan()
    const planId =
      existing !== null
        ? existing.id
        : `plan_${randomUUID().replace(/-/g, '').slice(0, 12)}`
    const now = nowTs()
    const structuredSteps = parsePlanSteps(opts.steps ?? [])
    const approvalGeneration =
      Number(existing?.metadata.approval_generation ?? 0) + 1
    const interaction = makePlanInteraction({
      title: opts.title,
      summary: opts.summary,
      planMarkdown: opts.planMarkdown,
      assumptions: opts.assumptions,
      riskLevel: opts.riskLevel ?? 'medium',
      parentCallId: opts.parentCallId,
      meta: {
        ...planMeta,
        plan_id: planId,
        approval_generation: approvalGeneration,
      },
    })
    const draft = readyForApprovalDraft(
      existing !== null ? existing.draft : emptyDraft(),
      {
        summary: interaction.summary,
        steps: structuredSteps,
      },
    )
    if (opts.enforceQuality) {
      new PlanQualityGate().requireOk({ steps: structuredSteps, draft })
    }
    const discoveryIds = draft.discoveries
      .map((item) => String(item.id ?? '').trim())
      .filter(Boolean)
    const reviewReceipt = {
      version: 1,
      from_phase: existing?.draft.phase ?? PlanDraftPhase.EXPLORING,
      reviewed_phase: PlanDraftPhase.REVIEWING,
      discovery_ids: discoveryIds,
      relevant_files: [...draft.relevantFiles],
      unresolved_questions: draft.openQuestions.length,
      reviewed_at: now,
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
        goalId: activeGoal?.id ?? existing?.goalId ?? null,
        supersedesPlanId: existing?.supersedesPlanId ?? null,
        planMarkdown: interaction.planMarkdown,
        assumptions: [...interaction.assumptions],
        steps: structuredSteps,
        draft,
        metadata: metadataWithoutPlanPermissionTokens({
          ...(existing !== null ? existing.metadata : {}),
          approval_generation: approvalGeneration,
          risk_level: interaction.riskLevel,
          plan_review_receipt: reviewReceipt,
          ...(scope ? { scope } : {}),
        }),
        eventSeq: existing?.eventSeq ?? 0,
      }),
    )
    this.cm.setPending(interaction)
    return interaction
  }

  assessPlanDecision(userMessage: string): PlanDecision {
    const state = this.cm.store.load()
    const hasPending = Boolean(
      state.pending && state.pending.status === InteractionStatus.WAITING,
    )
    if (
      CONTROL_RESUME_RE.test(String(userMessage ?? '')) &&
      this.cm.latestExecutablePlan() !== null
    ) {
      return new PlanDecision(
        'proceed',
        'Approved plan is already executing; continuation control messages do not re-trigger the plan guard.',
        ['executing_plan'],
      )
    }
    return this.cm.planDecisionPolicy.assess(userMessage, {
      mode: state.mode,
      hasPending,
    })
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
      source: String(opts.source ?? 'tool')
        .trim()
        .slice(0, 80),
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
    return this.cm.planStore.save(updated)
  }

  ensurePlanDraft(): PlanRecord {
    const existing = this.latestDraftPlan()
    if (existing !== null) return existing
    return this.cm.planStore.save(this.newPlanModeDraft())
  }

  /** Creates, but does not persist, the fresh draft installed by a Plan-mode entry. */
  newPlanModeDraft(): PlanRecord {
    const activeGoal = this.cm.activeGoalPlanContext()
    const now = nowTs()
    const scope = this.cm.planScopeMetadata()
    return makePlanRecord({
      id: `plan_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      title: 'Plan Draft',
      summary: 'Plan mode draft',
      status: PlanStatus.DRAFT,
      createdAt: now,
      updatedAt: now,
      sessionId: (scope?.session_id as string | undefined) ?? null,
      goalId: activeGoal?.id ?? null,
      draft: { ...emptyDraft(), phase: PlanDraftPhase.EXPLORING },
      metadata: { risk_level: 'medium', ...(scope ? { scope } : {}) },
    })
  }

  private latestDraftPlan(): PlanRecord | null {
    const activeGoalId = this.cm.activeGoalPlanContext()?.id ?? null
    const plans = this.cm.planStore
      .list()
      .filter(
        (p) =>
          p.status === PlanStatus.DRAFT &&
          p.goalId === activeGoalId &&
          this.cm.planMatchesCurrentScope(p),
      )
    if (!plans.length) return null
    return plans.reduce((a, b) => (b.updatedAt > a.updatedAt ? b : a))
  }

  private planRecordForMeta(meta: Record<string, unknown>): PlanRecord | null {
    const planId = String(meta.plan_id ?? '')
    const record = planId ? this.cm.planStore.get(planId) : null
    const activeGoalId = this.cm.activeGoalPlanContext()?.id ?? null
    return record &&
      record.goalId === activeGoalId &&
      this.cm.planMatchesCurrentScope(record)
      ? record
      : null
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
    const draft = {
      ...record.draft,
      phase: PlanDraftPhase.QUESTIONING,
      openQuestions,
    }
    this.cm.planStore.save({ ...record, updatedAt: nowTs(), draft })
  }

  recordPlanResolvedQuestions(interaction: Interaction): void {
    if (
      interaction.meta.goal_manual_evidence_request ||
      interaction.meta.goal_permission_blocker_request ||
      interaction.meta.goal_reviewer_waiver_request
    )
      return
    const record = this.planRecordForMeta(interaction.meta)
    if (record === null) return
    const questionIds = new Set(interaction.questions.map((q) => q.id))
    const remainingOpen = record.draft.openQuestions.filter(
      (item) =>
        item.interaction_id !== interaction.id ||
        !questionIds.has(item.id as string),
    )
    const resolved = [...record.draft.resolvedQuestions]
    const openById = new Map<string, Record<string, unknown>>()
    for (const item of record.draft.openQuestions) {
      if (item.interaction_id === interaction.id)
        openById.set(String(item.id), item)
    }
    for (const question of interaction.questions) {
      const answer =
        (interaction.answers[question.id] as Record<string, unknown>) ?? {}
      const choice =
        answer && typeof answer === 'object' ? answer.choice : String(answer)
      const freeform =
        answer && typeof answer === 'object' ? answer.freeform : ''
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
    const draft = {
      ...record.draft,
      phase: PlanDraftPhase.DESIGNING,
      openQuestions: remainingOpen,
      resolvedQuestions: resolved,
    }
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
    metadata = metadataWithoutPlanPermissionTokens(metadata, {
      reason: 'plan comment',
    })
    const draft = { ...record.draft, phase: PlanDraftPhase.REVIEWING }
    this.cm.planStore.save({
      ...record,
      status: PlanStatus.DRAFT,
      updatedAt: nowTs(),
      draft,
      metadata,
    })
  }
}
