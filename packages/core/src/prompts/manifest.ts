import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface PromptSectionInput {
  name: string
  content: string
  source: string
  priority: number
  budgetChars: number | null
  version: string | null
  scope?: string | null
}

export interface PromptManifestSection {
  name: string
  source: string
  priority: number
  budgetChars: number | null
  version: string | null
  scope: string | null
  hash: string
  charCount: number
  tokenEstimate: number
  clipped: boolean
  redacted: boolean
}

export interface PromptContextPlanItem {
  id: string
  kind: string
  source: string
  action: 'include' | 'omit'
  reason: string
  priority: number
  hash: string
  charCount: number
  tokenEstimate: number
}

export interface PromptContextPlan {
  version: 1
  mode?: 'chat' | 'build' | null
  policyId?: string | null
  activeMemoryBinding?: Record<string, unknown> | null
  items: PromptContextPlanItem[]
  omitted: Array<{
    kind: string
    source: string
    reason: string
    fromSeq?: number | null
    toSeq?: number | null
    compactionId?: string | null
    targetScopes?: string[]
  }>
  microcompact?: Array<Record<string, unknown>>
}

export interface PromptHistoryRange {
  messageCount: number
  firstSeq: number | null
  lastSeq: number | null
  turnIds: string[]
}

export interface PromptCheckpointSummary {
  status: 'captured' | 'not_captured'
  phase?: string | null
  baseHistorySeq?: number | null
  partialMessages?: number | null
  schemaVersion?: string | null
  updatedAt?: string | null
  turnId?: string | null
}

export interface PromptMemoryVersionSummary {
  target?: string | null
  relPath?: string | null
  contentHash?: string | null
  version?: number | null
  id?: string | null
  createdAt?: number | null
}

export interface PromptSnapshot {
  version: 1
  sessionId: string | null
  turnId: string
  createdAt: string
  model: string
  provider: string | null
  modelRole: string
  estimatedInputTokens: number | null
  finalMessagesHash: string
  historyRange: PromptHistoryRange
  checkpoint: PromptCheckpointSummary
  memoryVersions: PromptMemoryVersionSummary[]
  sections: PromptManifestSection[]
  contextPlan: PromptContextPlan
  totals: {
    charCount: number
    tokenEstimate: number
  }
}

export function toPromptManifestSection(section: PromptSectionInput): PromptManifestSection {
  const content = String(section.content ?? '')
  const budgetChars = section.budgetChars ?? null
  return {
    name: String(section.name || 'section'),
    source: String(section.source || 'unknown'),
    priority: Number(section.priority ?? 0),
    budgetChars,
    version: section.version ?? null,
    scope: section.scope ?? null,
    hash: createHash('sha256').update(content, 'utf8').digest('hex'),
    charCount: content.length,
    tokenEstimate: estimateTokens(content),
    clipped: budgetChars !== null && (content.length >= budgetChars || content.includes('clipped by ContextBuilder')),
    redacted: true,
  }
}

export function writePromptSnapshot(opts: {
  dir: string
  sessionId?: string | null
  turnId: string
  model: string
  provider?: string | null
  modelRole?: string | null
  estimatedInputTokens?: number | null
  sections: PromptSectionInput[]
  contextPlan?: PromptContextPlan | null
  messages?: Array<Record<string, unknown>> | null
  checkpoint?: Record<string, unknown> | null
  memoryVersions?: Array<Record<string, unknown>> | null
}): PromptSnapshot {
  mkdirSync(opts.dir, { recursive: true })
  const sections = opts.sections.map(toPromptManifestSection)
  const messages = Array.isArray(opts.messages) ? opts.messages : []
  const snapshot: PromptSnapshot = {
    version: 1,
    sessionId: opts.sessionId ?? null,
    turnId: opts.turnId,
    createdAt: new Date().toISOString(),
    model: opts.model,
    provider: opts.provider ?? null,
    modelRole: opts.modelRole ?? 'main',
    estimatedInputTokens: opts.estimatedInputTokens ?? null,
    finalMessagesHash: hashJson(messages),
    historyRange: buildHistoryRange(messages),
    checkpoint: summarizeCheckpoint(opts.checkpoint ?? null),
    memoryVersions: summarizeMemoryVersions(opts.memoryVersions ?? null),
    sections,
    contextPlan: buildContextPlan(sections, opts.contextPlan ?? null),
    totals: {
      charCount: sections.reduce((sum, section) => sum + section.charCount, 0),
      tokenEstimate: sections.reduce((sum, section) => sum + section.tokenEstimate, 0),
    },
  }
  writeFileSync(join(opts.dir, `${safeName(opts.turnId)}.json`), JSON.stringify(snapshot, null, 2) + '\n', 'utf8')
  return snapshot
}

function buildContextPlan(sections: PromptManifestSection[], plan?: PromptContextPlan | null): PromptContextPlan {
  const plannedItems = new Map((plan?.items ?? []).map((item) => [item.id, item]))
  const sectionIds = new Set(sections.map((section) => `section:${section.name}`))
  const dynamicItems = (plan?.items ?? []).filter((item) => !sectionIds.has(item.id))
  return {
    version: 1,
    ...(plan?.mode ? { mode: plan.mode } : {}),
    ...(plan?.policyId ? { policyId: plan.policyId } : {}),
    ...(plan?.activeMemoryBinding ? { activeMemoryBinding: plan.activeMemoryBinding } : {}),
    items: [
      ...sections.map((section) => promptPlanItem(section, plannedItems.get(`section:${section.name}`))),
      ...dynamicItems.map((item) => ({ ...item })),
    ],
    omitted: plan?.omitted ? [...plan.omitted] : [],
    ...(plan?.microcompact ? { microcompact: [...plan.microcompact] } : {}),
  }
}

function promptPlanItem(section: PromptManifestSection, planned: PromptContextPlanItem | undefined): PromptContextPlanItem {
  return {
    id: `section:${section.name}`,
    kind: planned?.kind ?? section.name,
    source: section.source,
    action: planned?.action ?? 'include',
    reason: planned?.reason ?? 'included_by_context_builder',
    priority: section.priority,
    hash: section.hash,
    charCount: section.charCount,
    tokenEstimate: section.tokenEstimate,
  }
}

export function listRecentPromptSnapshots(sessionsRoot: string, limit = 5): { count: number; recent: PromptSnapshot[] } {
  const snapshots: PromptSnapshot[] = []
  if (!existsSync(sessionsRoot)) return { count: 0, recent: [] }
  for (const sessionName of readdirSync(sessionsRoot)) {
    const snapshotDir = join(sessionsRoot, sessionName, 'prompt-snapshots')
    if (!existsSync(snapshotDir) || !statSync(snapshotDir).isDirectory()) continue
    for (const name of readdirSync(snapshotDir)) {
      if (!name.endsWith('.json')) continue
      try {
        const parsed = JSON.parse(readFileSync(join(snapshotDir, name), 'utf8') || '{}')
        if (isPromptSnapshot(parsed)) snapshots.push(parsed)
      } catch {
        // Diagnostics should not fail because one snapshot file is corrupt.
      }
    }
  }
  snapshots.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return { count: snapshots.length, recent: snapshots.slice(0, limit) }
}

function isPromptSnapshot(value: unknown): value is PromptSnapshot {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && Array.isArray((value as PromptSnapshot).sections))
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4))
}

function buildHistoryRange(messages: Array<Record<string, unknown>>): PromptHistoryRange {
  const historyMessages = messages.filter((message) => String(message.role ?? '') !== 'system')
  const seqs = historyMessages
    .map((message) => Number(message.seq ?? message.history_seq ?? message.historySeq))
    .filter((value) => Number.isFinite(value) && value > 0)
    .map((value) => Math.trunc(value))
  const turnIds: string[] = []
  const seen = new Set<string>()
  for (const message of historyMessages) {
    const turnId = String(message.turn_id ?? message.turnId ?? '').trim()
    if (!turnId || seen.has(turnId)) continue
    seen.add(turnId)
    turnIds.push(turnId)
  }
  return {
    messageCount: historyMessages.length,
    firstSeq: seqs.length ? Math.min(...seqs) : null,
    lastSeq: seqs.length ? Math.max(...seqs) : null,
    turnIds,
  }
}

function summarizeCheckpoint(value: Record<string, unknown> | null): PromptCheckpointSummary {
  if (!value) return { status: 'not_captured' }
  return {
    status: 'captured',
    phase: nullableString(value.phase),
    baseHistorySeq: nullableNumber(value.baseHistorySeq ?? value.base_history_seq),
    partialMessages: Array.isArray(value.partialMessages)
      ? value.partialMessages.length
      : nullableNumber(value.partialMessages ?? value.partial_messages),
    schemaVersion: nullableString(value.schemaVersion ?? value.schema_version),
    updatedAt: nullableString(value.updatedAt ?? value.updated_at),
    turnId: nullableString(value.turnId ?? value.turn_id),
  }
}

function summarizeMemoryVersions(value: Array<Record<string, unknown>> | null): PromptMemoryVersionSummary[] {
  if (!Array.isArray(value)) return []
  return value.map((item) => {
    const out: PromptMemoryVersionSummary = {}
    const target = nullableString(item.target)
    const relPath = nullableString(item.relPath ?? item.rel_path)
    const contentHash = nullableString(item.contentHash ?? item.content_hash)
    const version = nullableNumber(item.version)
    const id = nullableString(item.id ?? item.versionId ?? item.version_id)
    const createdAt = nullableNumber(item.createdAt ?? item.created_at)
    if (target !== null) out.target = target
    if (relPath !== null) out.relPath = relPath
    if (contentHash !== null) out.contentHash = contentHash
    if (version !== null) out.version = version
    if (id !== null) out.id = id
    if (createdAt !== null) out.createdAt = createdAt
    return out
  })
}

function hashJson(value: unknown): string {
  return createHash('sha256').update(stableStringify(value), 'utf8').digest('hex')
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function nullableNumber(value: unknown): number | null {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function safeName(value: string): string {
  return String(value || 'turn').replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 120) || 'turn'
}
