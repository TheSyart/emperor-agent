import { createHash, randomUUID } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { nowIsoUtc8 } from '../memory/time-utc8'

type Row = Record<string, unknown>

const SIDECAR_SCHEMA = 'emperor.message-graph-event.v2' as const
const MAX_SIDECAR_BYTES = 16 * 1024 * 1024
const MAX_SIDECAR_EVENTS = 50_000

export type MessageNodeStatus = 'partial' | 'committed' | 'tombstoned'

export interface MessageGraphNode {
  id: string
  parentId: string | null
  role: string
  content: unknown
  turnId: string | null
  status: MessageNodeStatus
  historySeq: number | null
  createdAt: string
  updatedAt: string
  tombstoneReason: string | null
  legacy: Row
}

export interface MessageCompactBoundary {
  id: string
  parentLeafId: string | null
  compactedUntilHistorySeq: number
  compactionId: string | null
  createdAt: string
}

export interface MessageGraphDiagnostic {
  code: string
  line: number
  message: string
}

export type PromptQueueState =
  'queued' | 'running' | 'interjected' | 'completed' | 'cancelled'

const PROMPT_TRANSITIONS: Record<
  PromptQueueState,
  ReadonlySet<PromptQueueState>
> = {
  queued: new Set(['running', 'interjected', 'cancelled']),
  running: new Set(['completed', 'cancelled']),
  interjected: new Set(['completed', 'cancelled']),
  completed: new Set(),
  cancelled: new Set(),
}

export interface PromptQueueRecord {
  id: string
  turnId: string
  clientMessageId: string
  delivery: 'queue' | 'interject'
  targetCommandId: string | null
  state: PromptQueueState
  reason: string | null
  createdAt: string
  updatedAt: string
}

export interface MessageGraphSnapshot {
  schemaVersion: 'emperor.message-graph.v2'
  revision: string
  leafId: string | null
  nodes: MessageGraphNode[]
  compactBoundaries: MessageCompactBoundary[]
  prompts: PromptQueueRecord[]
  diagnostics: MessageGraphDiagnostic[]
}

export interface MessageGraphStoreOptions {
  legacyRows?: Row[]
}

interface GraphEvent {
  schemaVersion: typeof SIDECAR_SCHEMA
  seq: number
  eventId: string
  type:
    | 'node_added'
    | 'node_committed'
    | 'node_tombstoned'
    | 'leaf_selected'
    | 'compact_boundary'
    | 'prompt_recorded'
    | 'prompt_transition'
  ts: string
  node?: MessageGraphNode
  nodeId?: string
  historySeq?: number
  reason?: string
  leafId?: string | null
  boundary?: MessageCompactBoundary
  legacy?: Row
  prompt?: PromptQueueRecord
  promptId?: string
  promptState?: PromptQueueState
}

export class MessageGraphStore {
  readonly sessionDir: string
  readonly path: string
  private readonly nodes = new Map<string, MessageGraphNode>()
  private readonly compactBoundaries = new Map<string, MessageCompactBoundary>()
  private readonly prompts = new Map<string, PromptQueueRecord>()
  private readonly diagnostics: MessageGraphDiagnostic[] = []
  private leafId: string | null = null
  private nextSeq = 1

  constructor(sessionDir: string, opts: MessageGraphStoreOptions = {}) {
    this.sessionDir = sessionDir
    this.path = join(sessionDir, 'message_graph.v2.jsonl')
    this.ensureSidecar()
    this.replay()
    const legacyRows = Array.isArray(opts.legacyRows) ? opts.legacyRows : []
    if (this.nodes.size === 0 && legacyRows.some(isLegacyMessageRow))
      this.bootstrapLegacy(legacyRows)
    this.reconcile(legacyRows)
  }

  beginMessage(input: {
    id?: string | null
    parentId?: string | null
    role: string
    content: unknown
    turnId?: string | null
    legacy?: Row | null
  }): MessageGraphNode {
    const id = cleanId(input.id) || randomUUID()
    if (this.nodes.has(id)) throw new Error(`duplicate message id: ${id}`)
    const parentId =
      input.parentId === undefined ? this.leafId : cleanId(input.parentId)
    if (parentId && !this.nodes.has(parentId))
      throw new Error(`unknown parent message: ${parentId}`)
    const now = nowIsoUtc8()
    const turnId = cleanId(input.turnId)
    const node: MessageGraphNode = {
      id,
      parentId,
      role: String(input.role ?? '').trim() || 'unknown',
      content: jsonSafe(input.content),
      turnId,
      status: 'partial',
      historySeq: null,
      createdAt: now,
      updatedAt: now,
      tombstoneReason: null,
      legacy: input.legacy ? jsonSafeRow(input.legacy) : {},
    }
    this.appendEvent({ type: 'node_added', node })
    return cloneNode(node)
  }

  commitMessage(
    nodeId: string,
    opts: { historySeq?: number | null; legacy?: Row | null } = {},
  ): MessageGraphNode {
    const node = this.requiredNode(nodeId)
    if (node.status === 'tombstoned')
      throw new Error(`cannot commit tombstoned message: ${node.id}`)
    if (node.status === 'committed') return cloneNode(node)
    const historySeq = positiveIntOrNull(opts.historySeq)
    this.appendEvent({
      type: 'node_committed',
      nodeId: node.id,
      ...(historySeq === null ? {} : { historySeq }),
      ...(opts.legacy ? { legacy: normalizedLegacyRow(opts.legacy) } : {}),
    })
    return cloneNode(this.requiredNode(node.id))
  }

  appendCommitted(input: {
    id?: string | null
    parentId?: string | null
    role: string
    content: unknown
    turnId?: string | null
    historySeq?: number | null
    legacy?: Row | null
  }): MessageGraphNode {
    const node = this.beginMessage(input)
    return this.commitMessage(node.id, { historySeq: input.historySeq })
  }

  tombstoneMessage(nodeId: string, reason: string): MessageGraphNode {
    const node = this.requiredNode(nodeId)
    if (node.status === 'tombstoned') return cloneNode(node)
    this.appendEvent({
      type: 'node_tombstoned',
      nodeId: node.id,
      reason: safeReason(reason),
    })
    return cloneNode(this.requiredNode(node.id))
  }

  selectLeaf(nodeId: string | null): string | null {
    const id = cleanId(nodeId)
    if (id) {
      const node = this.requiredNode(id)
      if (node.status !== 'committed')
        throw new Error(`message leaf is not committed: ${id}`)
    }
    this.appendEvent({ type: 'leaf_selected', leafId: id })
    return this.leafId
  }

  recordCompactBoundary(input: {
    compactedUntilHistorySeq: number
    compactionId?: string | null
    id?: string | null
  }): MessageCompactBoundary {
    const boundary: MessageCompactBoundary = {
      id: cleanId(input.id) || randomUUID(),
      parentLeafId: this.leafId,
      compactedUntilHistorySeq: nonNegativeInt(input.compactedUntilHistorySeq),
      compactionId: cleanId(input.compactionId),
      createdAt: nowIsoUtc8(),
    }
    if (this.compactBoundaries.has(boundary.id))
      throw new Error(`duplicate compact boundary: ${boundary.id}`)
    this.appendEvent({ type: 'compact_boundary', boundary })
    return cloneBoundary(boundary)
  }

  backtrackToCompactBoundary(boundaryId: string): string | null {
    const boundary = this.compactBoundaries.get(String(boundaryId))
    if (!boundary) throw new Error(`unknown compact boundary: ${boundaryId}`)
    return this.selectLeaf(boundary.parentLeafId)
  }

  recordPrompt(input: {
    id: string
    turnId: string
    clientMessageId?: string | null
    delivery: 'queue' | 'interject'
    targetCommandId?: string | null
  }): PromptQueueRecord {
    const id = cleanId(input.id)
    const turnId = cleanId(input.turnId)
    if (!id || !turnId) throw new Error('prompt id and turn id are required')
    const existing = this.prompts.get(id)
    if (existing) return { ...existing }
    const now = nowIsoUtc8()
    const prompt: PromptQueueRecord = {
      id,
      turnId,
      clientMessageId: cleanId(input.clientMessageId) || id,
      delivery: input.delivery,
      targetCommandId: cleanId(input.targetCommandId),
      state: 'queued',
      reason: null,
      createdAt: now,
      updatedAt: now,
    }
    this.appendEvent({ type: 'prompt_recorded', prompt })
    return { ...prompt }
  }

  transitionPrompt(
    promptId: string,
    state: Exclude<PromptQueueState, 'queued'>,
    reason?: string | null,
  ): PromptQueueRecord {
    const prompt = this.prompts.get(String(promptId))
    if (!prompt) throw new Error(`unknown prompt queue record: ${promptId}`)
    if (prompt.state === state) return { ...prompt }
    if (!PROMPT_TRANSITIONS[prompt.state].has(state))
      throw new Error(`illegal prompt transition: ${prompt.state} -> ${state}`)
    this.appendEvent({
      type: 'prompt_transition',
      promptId: prompt.id,
      promptState: state,
      reason: reason ? safeReason(reason) : undefined,
    })
    return { ...this.prompts.get(prompt.id)! }
  }

  project(leafId: string | null = this.leafId): Row[] {
    return projectMessageGraphToLegacy(this.snapshot(), { leafId })
  }

  snapshot(): MessageGraphSnapshot {
    const nodes = [...this.nodes.values()].map(cloneNode)
    const compactBoundaries = [...this.compactBoundaries.values()].map(
      cloneBoundary,
    )
    const prompts = [...this.prompts.values()].map((item) => ({ ...item }))
    const diagnostics = this.diagnostics.map((item) => ({ ...item }))
    return {
      schemaVersion: 'emperor.message-graph.v2',
      revision: digest({
        leafId: this.leafId,
        nodes,
        compactBoundaries,
        prompts,
        diagnostics,
      }),
      leafId: this.leafId,
      nodes,
      compactBoundaries,
      prompts,
      diagnostics,
    }
  }

  reconcile(legacyRows: Row[]): void {
    const byMessageId = new Map<string, Row>()
    for (const row of legacyRows) {
      const id = cleanId(row.message_id)
      if (id && isLegacyMessageRow(row)) byMessageId.set(id, row)
    }
    for (const node of [...this.nodes.values()]) {
      if (node.status !== 'partial') continue
      const landed = byMessageId.get(node.id)
      if (landed) {
        this.commitMessage(node.id, {
          historySeq: positiveIntOrNull(landed.seq),
          legacy: landed,
        })
      } else {
        this.tombstoneMessage(node.id, 'orphan_partial')
      }
    }
  }

  private ensureSidecar(): void {
    mkdirSync(this.sessionDir, { recursive: true })
    if (existsSync(this.path)) {
      const stat = lstatSync(this.path)
      if (stat.isSymbolicLink() || !stat.isFile())
        throw new Error('message graph sidecar must be a regular file')
      if (stat.size > MAX_SIDECAR_BYTES)
        throw new Error('message graph sidecar exceeds capacity')
      return
    }
    writeFileSync(this.path, '', { encoding: 'utf8', flag: 'wx' })
  }

  private replay(): void {
    const raw = readFileSync(this.path, 'utf8')
    const lines = raw.split('\n')
    let accepted = 0
    for (let index = 0; index < lines.length; index += 1) {
      const text = lines[index]!.trim()
      if (!text) continue
      if (accepted >= MAX_SIDECAR_EVENTS) {
        this.addDiagnostic(
          'event_limit_exceeded',
          index + 1,
          'Message graph event limit exceeded.',
        )
        break
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        this.addDiagnostic(
          'invalid_json',
          index + 1,
          'Message graph line is not valid JSON.',
        )
        continue
      }
      const event = normalizeEvent(parsed)
      if (!event) {
        this.addDiagnostic(
          'invalid_event',
          index + 1,
          'Message graph event schema is invalid.',
        )
        continue
      }
      this.nextSeq = Math.max(this.nextSeq, event.seq + 1)
      if (!this.applyEvent(event, index + 1)) continue
      accepted += 1
    }
  }

  private bootstrapLegacy(rows: Row[]): void {
    const projected = projectLegacyHistoryToGraph(rows, {
      sessionId: this.sessionDir,
    })
    for (const node of projected.nodes)
      this.appendEvent({ type: 'node_added', node })
    for (const boundary of projected.compactBoundaries)
      this.appendEvent({ type: 'compact_boundary', boundary })
    if (projected.leafId)
      this.appendEvent({ type: 'leaf_selected', leafId: projected.leafId })
  }

  private appendEvent(
    input: Omit<GraphEvent, 'schemaVersion' | 'seq' | 'eventId' | 'ts'>,
  ): void {
    if (statSync(this.path).size >= MAX_SIDECAR_BYTES)
      throw new Error('message graph sidecar exceeds capacity')
    const event: GraphEvent = {
      schemaVersion: SIDECAR_SCHEMA,
      seq: this.nextSeq,
      eventId: randomUUID(),
      ts: nowIsoUtc8(),
      ...jsonSafe(input),
    } as GraphEvent
    const line = `${JSON.stringify(event)}\n`
    if (statSync(this.path).size + Buffer.byteLength(line) > MAX_SIDECAR_BYTES)
      throw new Error('message graph sidecar exceeds capacity')
    appendFileSync(this.path, line, 'utf8')
    this.nextSeq += 1
    if (!this.applyEvent(event, 0))
      throw new Error('message graph rejected its own event')
  }

  private applyEvent(event: GraphEvent, line: number): boolean {
    if (event.type === 'node_added') {
      const node = event.node ? normalizeNode(event.node) : null
      if (!node || this.nodes.has(node.id)) {
        this.addDiagnostic(
          node ? 'duplicate_node' : 'invalid_node',
          line,
          'Message node was rejected.',
        )
        return false
      }
      if (node.parentId && !this.nodes.has(node.parentId)) {
        this.addDiagnostic(
          'unknown_parent',
          line,
          'Message node parent is unavailable.',
        )
        return false
      }
      this.nodes.set(node.id, node)
      if (node.status === 'committed') this.leafId = node.id
      return true
    }
    if (event.type === 'node_committed') {
      const node = event.nodeId ? this.nodes.get(event.nodeId) : null
      if (!node || node.status === 'tombstoned') return false
      node.status = 'committed'
      node.historySeq = positiveIntOrNull(event.historySeq)
      if (event.legacy && isRecord(event.legacy))
        node.legacy = normalizedLegacyRow(event.legacy)
      node.updatedAt = event.ts
      this.leafId = node.id
      return true
    }
    if (event.type === 'node_tombstoned') {
      const node = event.nodeId ? this.nodes.get(event.nodeId) : null
      if (!node) return false
      node.status = 'tombstoned'
      node.tombstoneReason = safeReason(event.reason)
      node.updatedAt = event.ts
      if (this.leafId === node.id) this.leafId = node.parentId
      return true
    }
    if (event.type === 'leaf_selected') {
      const leafId = cleanId(event.leafId)
      if (leafId && this.nodes.get(leafId)?.status !== 'committed') return false
      this.leafId = leafId
      return true
    }
    if (event.type === 'prompt_recorded') {
      const prompt = event.prompt ? normalizePrompt(event.prompt) : null
      if (!prompt || this.prompts.has(prompt.id)) return false
      this.prompts.set(prompt.id, prompt)
      return true
    }
    if (event.type === 'prompt_transition') {
      const prompt = event.promptId ? this.prompts.get(event.promptId) : null
      const state = normalizePromptState(event.promptState)
      if (!prompt || !state || state === 'queued') return false
      if (
        prompt.state !== state &&
        !PROMPT_TRANSITIONS[prompt.state].has(state)
      )
        return false
      prompt.state = state
      prompt.reason = event.reason ? safeReason(event.reason) : null
      prompt.updatedAt = event.ts
      return true
    }
    const boundary = event.boundary ? normalizeBoundary(event.boundary) : null
    if (!boundary || this.compactBoundaries.has(boundary.id)) return false
    if (boundary.parentLeafId && !this.nodes.has(boundary.parentLeafId))
      return false
    this.compactBoundaries.set(boundary.id, boundary)
    return true
  }

  private requiredNode(nodeId: string): MessageGraphNode {
    const node = this.nodes.get(String(nodeId))
    if (!node) throw new Error(`unknown message: ${nodeId}`)
    return node
  }

  private addDiagnostic(code: string, line: number, message: string): void {
    this.diagnostics.push({ code, line, message })
  }
}

export function projectLegacyHistoryToGraph(
  rows: Row[],
  opts: { sessionId: string },
): MessageGraphSnapshot {
  const nodes: MessageGraphNode[] = []
  const compactBoundaries: MessageCompactBoundary[] = []
  let parentId: string | null = null
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!
    if (row.type === 'compact_event') {
      compactBoundaries.push({
        id: `legacy-boundary-${digest({ sessionId: opts.sessionId, index, row }).slice(0, 24)}`,
        parentLeafId: parentId,
        compactedUntilHistorySeq: nonNegativeInt(row.seq),
        compactionId: cleanId(row.compaction_id),
        createdAt: String(row.ts ?? ''),
      })
      continue
    }
    if (!isLegacyMessageRow(row)) continue
    const legacy = normalizedLegacyRow(row)
    const id: string =
      cleanId(row.message_id) ||
      `legacy-${digest({ sessionId: opts.sessionId, index, parentId, legacy }).slice(0, 32)}`
    const node: MessageGraphNode = {
      id,
      parentId,
      role: String(row.role),
      content: jsonSafe(row.content),
      turnId: cleanId(row.turn_id),
      status: 'committed',
      historySeq: positiveIntOrNull(row.seq),
      createdAt: String(row.ts ?? ''),
      updatedAt: String(row.ts ?? ''),
      tombstoneReason: null,
      legacy,
    }
    nodes.push(node)
    parentId = id
  }
  const snapshot: MessageGraphSnapshot = {
    schemaVersion: 'emperor.message-graph.v2',
    revision: '',
    leafId: parentId,
    nodes,
    compactBoundaries,
    prompts: [],
    diagnostics: [],
  }
  snapshot.revision = digest(snapshot)
  return snapshot
}

export function projectMessageGraphToLegacy(
  snapshot: MessageGraphSnapshot,
  opts: { leafId?: string | null } = {},
): Row[] {
  const byId = new Map(snapshot.nodes.map((node) => [node.id, node]))
  const chain: MessageGraphNode[] = []
  const seen = new Set<string>()
  let cursor = opts.leafId === undefined ? snapshot.leafId : opts.leafId
  while (cursor) {
    if (seen.has(cursor)) throw new Error('message graph contains a cycle')
    seen.add(cursor)
    const node = byId.get(cursor)
    if (!node) throw new Error(`message graph leaf is unavailable: ${cursor}`)
    if (node.status === 'committed') chain.push(node)
    cursor = node.parentId
  }
  return chain.reverse().map((node) => {
    if (Object.keys(node.legacy).length) return jsonSafeRow(node.legacy)
    const row: Row = { role: node.role, content: jsonSafe(node.content) }
    if (node.historySeq !== null) row.seq = node.historySeq
    if (node.turnId) row.turn_id = node.turnId
    return row
  })
}

function normalizeEvent(value: unknown): GraphEvent | null {
  if (!isRecord(value) || value.schemaVersion !== SIDECAR_SCHEMA) return null
  const type = String(value.type ?? '')
  if (
    ![
      'node_added',
      'node_committed',
      'node_tombstoned',
      'leaf_selected',
      'compact_boundary',
      'prompt_recorded',
      'prompt_transition',
    ].includes(type)
  )
    return null
  const seq = positiveIntOrNull(value.seq)
  if (!seq || !cleanId(value.eventId)) return null
  return jsonSafe(value) as unknown as GraphEvent
}

function normalizeNode(value: unknown): MessageGraphNode | null {
  if (!isRecord(value)) return null
  const id = cleanId(value.id)
  const role = String(value.role ?? '').trim()
  const status = String(value.status ?? '')
  if (!id || !role || !['partial', 'committed', 'tombstoned'].includes(status))
    return null
  return {
    id,
    parentId: cleanId(value.parentId),
    role,
    content: jsonSafe(value.content),
    turnId: cleanId(value.turnId),
    status: status as MessageNodeStatus,
    historySeq: positiveIntOrNull(value.historySeq),
    createdAt: String(value.createdAt ?? ''),
    updatedAt: String(value.updatedAt ?? ''),
    tombstoneReason: value.tombstoneReason
      ? safeReason(value.tombstoneReason)
      : null,
    legacy: isRecord(value.legacy) ? jsonSafeRow(value.legacy) : {},
  }
}

function normalizeBoundary(value: unknown): MessageCompactBoundary | null {
  if (!isRecord(value)) return null
  const id = cleanId(value.id)
  if (!id) return null
  return {
    id,
    parentLeafId: cleanId(value.parentLeafId),
    compactedUntilHistorySeq: nonNegativeInt(value.compactedUntilHistorySeq),
    compactionId: cleanId(value.compactionId),
    createdAt: String(value.createdAt ?? ''),
  }
}

function normalizePrompt(value: unknown): PromptQueueRecord | null {
  if (!isRecord(value)) return null
  const id = cleanId(value.id)
  const turnId = cleanId(value.turnId)
  const clientMessageId = cleanId(value.clientMessageId)
  const state = normalizePromptState(value.state)
  const delivery = String(value.delivery ?? '')
  if (
    !id ||
    !turnId ||
    !clientMessageId ||
    !state ||
    (delivery !== 'queue' && delivery !== 'interject')
  )
    return null
  return {
    id,
    turnId,
    clientMessageId,
    delivery,
    targetCommandId: cleanId(value.targetCommandId),
    state,
    reason: value.reason ? safeReason(value.reason) : null,
    createdAt: String(value.createdAt ?? ''),
    updatedAt: String(value.updatedAt ?? ''),
  }
}

function normalizePromptState(value: unknown): PromptQueueState | null {
  const state = String(value ?? '') as PromptQueueState
  return [
    'queued',
    'running',
    'interjected',
    'completed',
    'cancelled',
  ].includes(state)
    ? state
    : null
}

function normalizedLegacyRow(row: Row): Row {
  const out = jsonSafeRow(row)
  delete out.message_id
  return out
}

function isLegacyMessageRow(row: Row): boolean {
  return (
    typeof row.role === 'string' &&
    'content' in row &&
    row.type !== 'model_call'
  )
}

function cleanId(value: unknown): string | null {
  const text = String(value ?? '').trim()
  if (!text || text.length > 256) return null
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) < 32) return null
  }
  return text
}

function safeReason(value: unknown): string {
  const text = String(value ?? '').trim()
  return (text || 'unspecified').slice(0, 256)
}

function positiveIntOrNull(value: unknown): number | null {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : null
}

function nonNegativeInt(value: unknown): number {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : 0
}

function isRecord(value: unknown): value is Row {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function jsonSafeRow(value: Row): Row {
  return jsonSafe(value) as Row
}

function jsonSafe<T>(value: T): T {
  return JSON.parse(JSON.stringify(value ?? null)) as T
}

function cloneNode(node: MessageGraphNode): MessageGraphNode {
  return jsonSafe(node)
}

function cloneBoundary(
  boundary: MessageCompactBoundary,
): MessageCompactBoundary {
  return { ...boundary }
}

function digest(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(value), 'utf8')
    .digest('hex')
}
