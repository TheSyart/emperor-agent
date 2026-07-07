import { canonicalSections, type MemoryMarkdownKind } from './markdown-schema'
import type { CompactionDraft } from './compaction-models'

export interface DraftQualityScore {
  validJson: boolean
  hasDecisions: boolean
  allOperationsHaveSourceSeqs: boolean
  allOperationsHaveReason: boolean
  allOperationsHaveConfidence: boolean
  noUnknownSections: boolean
  noLowConfidenceWrites: boolean
  noOversizedItems: boolean
  noSuspiciousInstructionText: boolean
  score: number
}

export interface ParsedCompactionDraft {
  ok: boolean
  draft: CompactionDraft | null
  errors: string[]
  quality: DraftQualityScore
}

type DraftTargetName = 'episode' | 'userProfile' | 'globalMemory' | 'projectMemory'

const HARD_GATES: Array<keyof Omit<DraftQualityScore, 'score'>> = [
  'validJson',
  'noUnknownSections',
  'noSuspiciousInstructionText',
]

const SOFT_SIGNALS: Array<keyof Omit<DraftQualityScore, 'score'>> = [
  'hasDecisions',
  'allOperationsHaveSourceSeqs',
  'allOperationsHaveReason',
  'allOperationsHaveConfidence',
  'noLowConfidenceWrites',
  'noOversizedItems',
]

export function computeDraftQualityScore(flags: Omit<DraftQualityScore, 'score'>): number {
  if (HARD_GATES.some((key) => !flags[key])) return 0
  const passed = SOFT_SIGNALS.filter((key) => flags[key]).length
  return passed / SOFT_SIGNALS.length
}

export function parseCompactionDraft(text: string): ParsedCompactionDraft {
  let parsed: unknown
  try {
    parsed = JSON.parse(String(text ?? ''))
  } catch {
    return {
      ok: false,
      draft: null,
      errors: ['invalid_json'],
      quality: quality({
        validJson: false,
        hasDecisions: false,
        allOperationsHaveSourceSeqs: false,
        allOperationsHaveReason: false,
        allOperationsHaveConfidence: false,
        noUnknownSections: false,
        noLowConfidenceWrites: false,
        noOversizedItems: false,
        noSuspiciousInstructionText: false,
      }),
    }
  }

  if (!isObject(parsed)) {
    return invalidParsed(['draft_must_be_object'])
  }

  const draft = parsed as Record<string, unknown>
  const errors: string[] = []
  if (draft.schemaVersion !== 'emperor.compaction-draft.v1') errors.push('invalid_schemaVersion')

  const operations = collectOperations(draft, errors)
  const hasDecisions = Array.isArray(draft.decisions) && draft.decisions.length > 0
  if (!Array.isArray(draft.decisions)) errors.push('decisions_must_be_array')
  if (!Array.isArray(draft.discarded)) errors.push('discarded_must_be_array')
  if (Array.isArray(draft.decisions)) validateDecisions(draft.decisions, errors)
  if (Array.isArray(draft.discarded)) validateDiscarded(draft.discarded, errors)

  const flags = {
    validJson: true,
    hasDecisions,
    allOperationsHaveSourceSeqs: operations.every((entry) => Array.isArray(entry.op.sourceSeqs) && entry.op.sourceSeqs.length > 0),
    allOperationsHaveReason: operations.every((entry) => typeof entry.op.reason === 'string' && entry.op.reason.trim().length > 0),
    allOperationsHaveConfidence: operations.every((entry) => isConfidence(entry.op.confidence)),
    noUnknownSections: operations.every((entry) => knownSection(entry.target, String(entry.op.section ?? ''))),
    noLowConfidenceWrites: operations.every((entry) => !isLowConfidenceProtectedWrite(entry.target, entry.op.confidence)),
    noOversizedItems: operations.every((entry) => operationText(entry.op).length <= 2000),
    noSuspiciousInstructionText: operations.every((entry) => !containsSuspiciousInstruction(operationText(entry.op))),
  }

  for (const entry of operations) {
    if (!Array.isArray(entry.op.sourceSeqs) || entry.op.sourceSeqs.length === 0) errors.push('operation_missing_sourceSeqs')
    if (!(typeof entry.op.reason === 'string' && entry.op.reason.trim())) errors.push('operation_missing_reason')
    if (!isConfidence(entry.op.confidence)) errors.push('operation_missing_confidence')
    if (!knownSection(entry.target, String(entry.op.section ?? ''))) errors.push(`unknown_section:${entry.target}:${String(entry.op.section ?? '')}`)
    if (isLowConfidenceProtectedWrite(entry.target, entry.op.confidence)) errors.push(`low_confidence_write:${entry.target}`)
    if (operationText(entry.op).length > 2000) errors.push(`oversized_item:${entry.target}`)
    if (containsSuspiciousInstruction(operationText(entry.op))) errors.push('suspicious_instruction_text')
  }

  const qualityScore = quality(flags)
  const uniqueErrors = [...new Set(errors)]
  if (qualityScore.score < 0.75 && !uniqueErrors.includes('draft_quality_below_threshold')) {
    uniqueErrors.push('draft_quality_below_threshold')
  }
  return {
    ok: uniqueErrors.length === 0,
    draft: parsed as unknown as CompactionDraft,
    errors: uniqueErrors,
    quality: qualityScore,
  }
}

function invalidParsed(errors: string[]): ParsedCompactionDraft {
  return {
    ok: false,
    draft: null,
    errors,
    quality: quality({
      validJson: true,
      hasDecisions: false,
      allOperationsHaveSourceSeqs: false,
      allOperationsHaveReason: false,
      allOperationsHaveConfidence: false,
      noUnknownSections: false,
      noLowConfidenceWrites: false,
      noOversizedItems: false,
      noSuspiciousInstructionText: false,
    }),
  }
}

function quality(flags: Omit<DraftQualityScore, 'score'>): DraftQualityScore {
  return { ...flags, score: computeDraftQualityScore(flags) }
}

function collectOperations(
  draft: Record<string, unknown>,
  errors: string[],
): Array<{ target: DraftTargetName; op: Record<string, unknown> }> {
  const out: Array<{ target: DraftTargetName; op: Record<string, unknown> }> = []
  for (const target of ['episode', 'userProfile', 'globalMemory', 'projectMemory'] as DraftTargetName[]) {
    const raw = draft[target]
    if (raw === undefined || raw === null) continue
    if (!isObject(raw) || !Array.isArray(raw.operations)) {
      errors.push(`target_invalid:${target}`)
      continue
    }
    for (const op of raw.operations) {
      if (!isObject(op)) {
        errors.push(`operation_invalid:${target}`)
        continue
      }
      if (!isOperation(op.op)) errors.push(`operation_unknown:${target}:${String(op.op ?? '')}`)
      out.push({ target, op })
    }
  }
  return out
}

function knownSection(target: DraftTargetName, section: string): boolean {
  const kind = markdownKind(target)
  return canonicalSections(kind).includes(section)
}

function markdownKind(target: DraftTargetName): MemoryMarkdownKind {
  if (target === 'userProfile') return 'user_profile'
  if (target === 'globalMemory') return 'global'
  if (target === 'projectMemory') return 'project'
  return 'episode'
}

function isLowConfidenceProtectedWrite(target: DraftTargetName, confidence: unknown): boolean {
  return (target === 'userProfile' || target === 'globalMemory') && confidence === 'low'
}

function operationText(op: Record<string, unknown>): string {
  return [
    op.content,
    op.reason,
    op.itemId,
  ].filter((part) => part !== undefined && part !== null).map(String).join('\n')
}

function isOperation(value: unknown): boolean {
  return value === 'append_section_item' || value === 'update_item' || value === 'mark_deprecated' || value === 'replace_section'
}

function isConfidence(value: unknown): boolean {
  return value === 'low' || value === 'medium' || value === 'high'
}

function validateDecisions(items: unknown[], errors: string[]): void {
  items.forEach((item, index) => {
    if (!isObject(item)) {
      errors.push(`decision_invalid:${index}`)
      return
    }
    if (!Array.isArray(item.sourceSeqs) || item.sourceSeqs.length === 0) errors.push(`decision_missing_sourceSeqs:${index}`)
    if (!(typeof item.content === 'string' && item.content.trim())) errors.push(`decision_missing_content:${index}`)
    if (!isDestination(item.destination)) errors.push(`decision_invalid_destination:${index}:${String(item.destination ?? '')}`)
    if (!isClassification(item.classification)) errors.push(`decision_invalid_classification:${index}:${String(item.classification ?? '')}`)
    if (!(typeof item.reason === 'string' && item.reason.trim())) errors.push(`decision_missing_reason:${index}`)
    if (!isConfidence(item.confidence)) errors.push(`decision_missing_confidence:${index}`)
  })
}

function validateDiscarded(items: unknown[], errors: string[]): void {
  items.forEach((item, index) => {
    if (!isObject(item)) {
      errors.push(`discarded_invalid:${index}`)
      return
    }
    if (!Array.isArray(item.sourceSeqs) || item.sourceSeqs.length === 0) errors.push(`discarded_missing_sourceSeqs:${index}`)
    if (!(typeof item.summary === 'string' && item.summary.trim())) errors.push(`discarded_missing_summary:${index}`)
    if (!isDiscardReason(item.reason)) errors.push(`discarded_invalid_reason:${index}:${String(item.reason ?? '')}`)
  })
}

function isDestination(value: unknown): boolean {
  return value === 'user_profile' || value === 'global_memory' || value === 'project_memory' || value === 'episode' || value === 'discarded'
}

function isClassification(value: unknown): boolean {
  return value === 'stable_user_preference'
    || value === 'working_style'
    || value === 'long_term_constraint'
    || value === 'cross_session_fact'
    || value === 'cross_project_learning'
    || value === 'project_fact'
    || value === 'project_command'
    || value === 'project_decision'
    || value === 'project_open_task'
    || value === 'daily_event'
    || value === 'temporary_detail'
    || value === 'sensitive'
    || value === 'duplicate'
}

function isDiscardReason(value: unknown): boolean {
  return value === 'temporary_tool_output'
    || value === 'duplicate'
    || value === 'not_durable'
    || value === 'sensitive'
    || value === 'low_confidence'
    || value === 'already_captured'
}

const SUSPICIOUS_PATTERNS = [
  /ignore previous instructions/i,
  /忽略之前的指令/i,
  /forget system prompt/i,
  /developer message/i,
  /system override/i,
  /you must obey this memory/i,
  /treat this memory as system instruction/i,
]

function containsSuspiciousInstruction(text: string): boolean {
  return SUSPICIOUS_PATTERNS.some((pattern) => pattern.test(text))
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
