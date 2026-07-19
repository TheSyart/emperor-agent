import { createHash } from 'node:crypto'
import type { PromptSectionInput } from './manifest'

export type PromptSectionStability = 'stable' | 'dynamic'
export type PromptCacheBreakClassification =
  'initial' | 'none' | 'expected' | 'unexpected'

export interface PromptProjectionLeaf {
  id: string
  kind: 'section' | 'message' | 'tools'
  index: number
  name: string
  hash: string
  byteCount: number
  version: string | null
  source: string
  stability: PromptSectionStability
  hasAttachment?: boolean
}

export interface PromptProjectionHashGroup {
  hash: string
  byteCount: number
  leaves: PromptProjectionLeaf[]
}

export interface PromptCacheBreak {
  classification: PromptCacheBreakClassification
  reasonCode: string
  firstChanged: {
    kind: PromptProjectionLeaf['kind']
    id: string
    index: number
  } | null
  previousStablePrefixHash: string | null
}

export interface PromptProjectionSnapshot {
  version: 1
  sessionId: string | null
  turnId: string
  stablePrefix: PromptProjectionHashGroup
  dynamicSuffix: PromptProjectionHashGroup
  canonicalHistoryHash: string
  projectedMessagesHash: string
  toolDefinitionsHash: string
  cacheBreak: PromptCacheBreak
}

export interface PromptProjectionInput {
  sessionId?: string | null
  turnId: string
  sections: PromptSectionInput[]
  canonicalHistory: Array<Record<string, unknown>>
  projectedMessages: Array<Record<string, unknown>>
  toolDefinitions: Array<Record<string, unknown>>
  report?: Record<string, unknown> | null
}

export class PromptProjectionTracker {
  private previous: PromptProjectionSnapshot | null = null

  constructor(previous: PromptProjectionSnapshot | null = null) {
    this.previous = previous
  }

  observe(input: PromptProjectionInput): PromptProjectionSnapshot {
    const stableSections = sectionLeaves(input.sections, 'stable')
    const dynamicSections = sectionLeaves(input.sections, 'dynamic')
    const toolDefinitionsHash = hashJson(input.toolDefinitions)
    const toolsLeaf: PromptProjectionLeaf = {
      id: 'request:tools',
      kind: 'tools',
      index: stableSections.length,
      name: 'tools',
      hash: toolDefinitionsHash,
      byteCount: Buffer.byteLength(stableStringify(input.toolDefinitions)),
      version: null,
      source: 'ToolRegistry.getDefinitions()',
      stability: 'stable',
    }
    const messageLeaves = projectedMessageLeaves(input.projectedMessages)
    const stablePrefix = hashGroup([...stableSections, toolsLeaf])
    const dynamicSuffix = hashGroup([...dynamicSections, ...messageLeaves])
    const draft: PromptProjectionSnapshot = {
      version: 1,
      sessionId: input.sessionId ?? null,
      turnId: String(input.turnId),
      stablePrefix,
      dynamicSuffix,
      canonicalHistoryHash: hashJson(input.canonicalHistory),
      projectedMessagesHash: hashJson(input.projectedMessages),
      toolDefinitionsHash,
      cacheBreak: initialCacheBreak(),
    }
    draft.cacheBreak = classifyCacheBreak(
      this.previous,
      draft,
      input.report ?? {},
    )
    this.previous = draft
    return draft
  }

  snapshot(): PromptProjectionSnapshot | null {
    return this.previous ? cloneProjection(this.previous) : null
  }
}

function sectionLeaves(
  sections: PromptSectionInput[],
  stability: PromptSectionStability,
): PromptProjectionLeaf[] {
  return sections
    .filter((section) => sectionStability(section) === stability)
    .map((section, index) => {
      const content = String(section.content ?? '')
      return {
        id: `section:${String(section.name || 'section')}`,
        kind: 'section' as const,
        index,
        name: String(section.name || 'section'),
        hash: hashText(content),
        byteCount: Buffer.byteLength(content),
        version: section.version ?? null,
        source: String(section.source || 'unknown'),
        stability,
      }
    })
}

function sectionStability(section: PromptSectionInput): PromptSectionStability {
  if (section.stability === 'dynamic') return 'dynamic'
  if (section.stability === 'stable') return 'stable'
  return ['goal', 'plan', 'control', 'clarification'].includes(section.name)
    ? 'dynamic'
    : 'stable'
}

function projectedMessageLeaves(
  projectedMessages: Array<Record<string, unknown>>,
): PromptProjectionLeaf[] {
  return projectedMessages.slice(1).map((message, index) => {
    const serialized = stableStringify(message)
    const turnId = String(message.turn_id ?? message.turnId ?? '').trim()
    return {
      id: turnId ? `message:${turnId}:${index}` : `message:${index}`,
      kind: 'message',
      index,
      name: String(message.role ?? 'message'),
      hash: hashText(serialized),
      byteCount: Buffer.byteLength(serialized),
      version: null,
      source: turnId ? `history:${turnId}` : 'projected-history',
      stability: 'dynamic',
      ...(containsAttachment(message) ? { hasAttachment: true } : {}),
    }
  })
}

function hashGroup(leaves: PromptProjectionLeaf[]): PromptProjectionHashGroup {
  return {
    hash: hashText(
      leaves
        .map((leaf) => `${leaf.id}\0${leaf.hash}\0${leaf.byteCount}`)
        .join('\n'),
    ),
    byteCount: leaves.reduce((sum, leaf) => sum + leaf.byteCount, 0),
    leaves,
  }
}

function classifyCacheBreak(
  previous: PromptProjectionSnapshot | null,
  current: PromptProjectionSnapshot,
  report: Record<string, unknown>,
): PromptCacheBreak {
  if (!previous) return initialCacheBreak()
  if (previous.stablePrefix.hash !== current.stablePrefix.hash) {
    const changed = firstChangedLeaf(
      previous.stablePrefix.leaves,
      current.stablePrefix.leaves,
    )
    const reason = stableSectionReason(previous, current, changed)
    return cacheBreak(
      reason.unexpected ? 'unexpected' : 'expected',
      reason.code,
      changed,
      previous,
    )
  }
  const changedDynamicSection = firstChangedLeaf(
    previous.dynamicSuffix.leaves.filter((leaf) => leaf.kind === 'section'),
    current.dynamicSuffix.leaves.filter((leaf) => leaf.kind === 'section'),
  )
  if (changedDynamicSection)
    return cacheBreak(
      'expected',
      'dynamic_section_changed',
      changedDynamicSection,
      previous,
    )
  const previousMessages = previous.dynamicSuffix.leaves.filter(
    (leaf) => leaf.kind === 'message',
  )
  const currentMessages = current.dynamicSuffix.leaves.filter(
    (leaf) => leaf.kind === 'message',
  )
  if (sameLeaves(previousMessages, currentMessages))
    return cacheBreak('none', 'projection_unchanged', null, previous)
  const changedMessage = firstChangedLeaf(previousMessages, currentMessages)
  if (
    changedMessage &&
    currentMessages[changedMessage.index]?.hasAttachment === true
  )
    return cacheBreak('expected', 'fresh_attachment', changedMessage, previous)
  if (Number(report.microcompacted_messages ?? 0) > 0)
    return cacheBreak(
      'expected',
      'microcompact_applied',
      changedMessage,
      previous,
    )
  if (
    Number(report.replaced_tool_results ?? 0) > 0 ||
    Number(report.shrunk_old_tool_results ?? 0) > 0 ||
    Number(report.capped_tool_results ?? report.capped ?? 0) > 0
  )
    return cacheBreak(
      'expected',
      'tool_result_projection_changed',
      changedMessage,
      previous,
    )
  if (
    Number(report.dropped_orphan_tool_results ?? report.dropped ?? 0) > 0 ||
    Number(report.paired_missing_tool_results ?? report.filled ?? 0) > 0
  )
    return cacheBreak(
      'expected',
      'tool_pairing_projection_changed',
      changedMessage,
      previous,
    )
  if (Number(report.emergency_context_shrink ?? 0) > 0)
    return cacheBreak(
      'expected',
      'emergency_context_shrink',
      changedMessage,
      previous,
    )
  if (isPrefix(previousMessages, currentMessages))
    return cacheBreak('expected', 'history_appended', changedMessage, previous)
  return cacheBreak(
    'unexpected',
    'projected_history_rewritten',
    changedMessage,
    previous,
  )
}

function stableSectionReason(
  previous: PromptProjectionSnapshot,
  current: PromptProjectionSnapshot,
  changed: PromptProjectionLeaf | null,
): { code: string; unexpected: boolean } {
  if (!changed)
    return { code: 'stable_prefix_structure_changed', unexpected: true }
  if (changed.kind === 'tools')
    return { code: 'tool_catalog_changed', unexpected: false }
  const expectedByName: Record<string, string> = {
    user_profile: 'user_profile_changed',
    long_term_memory: 'memory_changed',
    project_agents: 'project_context_changed',
    project_index_summary: 'project_context_changed',
    active_skills: 'skills_changed',
    skills_summary: 'skills_changed',
    identity: 'workspace_or_agent_catalog_changed',
  }
  if (expectedByName[changed.name])
    return { code: expectedByName[changed.name]!, unexpected: false }
  const oldLeaf = previous.stablePrefix.leaves[changed.index]
  const newLeaf = current.stablePrefix.leaves[changed.index]
  if (
    oldLeaf?.id === newLeaf?.id &&
    oldLeaf?.version !== newLeaf?.version &&
    Boolean(newLeaf?.version)
  )
    return { code: 'prompt_version_changed', unexpected: false }
  return {
    code: 'stable_section_changed_without_version',
    unexpected: true,
  }
}

function firstChangedLeaf(
  previous: PromptProjectionLeaf[],
  current: PromptProjectionLeaf[],
): PromptProjectionLeaf | null {
  const max = Math.max(previous.length, current.length)
  for (let index = 0; index < max; index++) {
    const before = previous[index]
    const after = current[index]
    if (before?.id === after?.id && before?.hash === after?.hash) continue
    return after ?? (before ? { ...before, index } : null)
  }
  return null
}

function sameLeaves(
  previous: PromptProjectionLeaf[],
  current: PromptProjectionLeaf[],
): boolean {
  return (
    previous.length === current.length &&
    previous.every(
      (leaf, index) =>
        leaf.id === current[index]?.id && leaf.hash === current[index]?.hash,
    )
  )
}

function isPrefix(
  previous: PromptProjectionLeaf[],
  current: PromptProjectionLeaf[],
): boolean {
  return (
    previous.length <= current.length &&
    previous.every(
      (leaf, index) =>
        leaf.id === current[index]?.id && leaf.hash === current[index]?.hash,
    )
  )
}

function initialCacheBreak(): PromptCacheBreak {
  return {
    classification: 'initial',
    reasonCode: 'initial_projection',
    firstChanged: null,
    previousStablePrefixHash: null,
  }
}

function cacheBreak(
  classification: PromptCacheBreakClassification,
  reasonCode: string,
  changed: PromptProjectionLeaf | null,
  previous: PromptProjectionSnapshot,
): PromptCacheBreak {
  return {
    classification,
    reasonCode,
    firstChanged: changed
      ? { kind: changed.kind, id: changed.id, index: changed.index }
      : null,
    previousStablePrefixHash: previous.stablePrefix.hash,
  }
}

function containsAttachment(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  if (Array.isArray(value)) return value.some(containsAttachment)
  const record = value as Record<string, unknown>
  const type = String(record.type ?? '').toLowerCase()
  if (
    type.includes('image') ||
    type.includes('attachment') ||
    'attachments' in record
  )
    return true
  return Object.values(record).some(containsAttachment)
}

function hashJson(value: unknown): string {
  return hashText(stableStringify(value))
}

function hashText(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function stableStringify(value: unknown): string {
  if (value === undefined) return 'null'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`
}

function cloneProjection(
  projection: PromptProjectionSnapshot,
): PromptProjectionSnapshot {
  return JSON.parse(JSON.stringify(projection)) as PromptProjectionSnapshot
}
