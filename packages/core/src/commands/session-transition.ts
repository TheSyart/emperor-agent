import { randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import type { SessionEntry, SessionStore } from '../sessions/store'

type TransitionState = 'prepared' | 'ended' | 'created' | 'applied'

interface SessionTransitionRecord {
  version: 1
  invocationId: string
  sourceSessionId: string
  targetSessionId: string
  state: TransitionState
  source: Pick<
    SessionEntry,
    'mode' | 'project_id' | 'project_path' | 'project_name' | 'lineage_root_id'
  >
  createdAt: string
  updatedAt: string
}

interface SessionTransitionPayload {
  version: 1
  records: SessionTransitionRecord[]
}

export interface SessionTransitionServiceDeps {
  stateRoot: string
  sessions: SessionStore
  assertBoundary: (sessionId: string) => void | Promise<void>
  runSessionEnd: (sessionId: string, reason: 'clear') => Promise<void>
  activate: (sessionId: string) => unknown
  inheritWorkspaceBinding: (
    sourceSessionId: string,
    targetSessionId: string,
  ) => void
}

export class SessionTransitionService {
  readonly deps: SessionTransitionServiceDeps
  readonly path: string

  constructor(deps: SessionTransitionServiceDeps) {
    this.deps = deps
    this.path = join(deps.stateRoot, 'control', 'session-transitions.json')
  }

  async clear(input: {
    sessionId: string
    invocationId: string
  }): Promise<{ session: SessionEntry; transitionId: string }> {
    const invocationId = requireId(input.invocationId, 'invocationId')
    const sessionId = requireId(input.sessionId, 'sessionId')
    const existing = this.read().records.find(
      (record) => record.invocationId === invocationId,
    )
    if (existing) {
      if (existing.sourceSessionId !== sessionId)
        throw new Error('session transition invocation conflict')
      return await this.apply(existing)
    }
    await this.deps.assertBoundary(sessionId)
    const source = this.deps.sessions.get(sessionId)
    if (!source) throw new Error('session not found')
    const now = new Date().toISOString()
    const record: SessionTransitionRecord = {
      version: 1,
      invocationId,
      sourceSessionId: sessionId,
      targetSessionId: randomUUID().replace(/-/g, '').slice(0, 16),
      state: 'prepared',
      source: {
        mode: source.mode,
        project_id: source.project_id,
        project_path: source.project_path,
        project_name: source.project_name,
        lineage_root_id: source.lineage_root_id,
      },
      createdAt: now,
      updatedAt: now,
    }
    this.upsert(record)
    this.deps.sessions.markTransitioned(sessionId, record.targetSessionId)
    return await this.apply(record)
  }

  async recover(): Promise<SessionEntry[]> {
    const recovered: SessionEntry[] = []
    for (const record of this.read().records) {
      if (record.state === 'applied') continue
      recovered.push((await this.apply(record)).session)
    }
    return recovered
  }

  private async apply(
    record: SessionTransitionRecord,
  ): Promise<{ session: SessionEntry; transitionId: string }> {
    if (record.state === 'prepared') {
      const source = this.deps.sessions.get(record.sourceSessionId)
      if (source?.transitioned_to_session_id !== record.targetSessionId)
        this.deps.sessions.markTransitioned(
          record.sourceSessionId,
          record.targetSessionId,
        )
      await this.deps.runSessionEnd(record.sourceSessionId, 'clear')
      record = this.advance(record, 'ended')
    }
    let session = this.deps.sessions.get(record.targetSessionId)
    if (!session) {
      session = this.deps.sessions.create('Untitled', {
        id: record.targetSessionId,
        titleStatus: 'placeholder',
        mode: record.source.mode,
        project: {
          project_id: record.source.project_id,
          project_path: record.source.project_path,
          project_name: record.source.project_name,
        },
        parentSessionId: record.sourceSessionId,
        lineageRootId: record.source.lineage_root_id || record.sourceSessionId,
        transitionReason: 'clear',
      })
    }
    if (record.state === 'ended') record = this.advance(record, 'created')
    if (record.state === 'created') {
      this.deps.inheritWorkspaceBinding(
        record.sourceSessionId,
        record.targetSessionId,
      )
      this.deps.activate(record.targetSessionId)
      record = this.advance(record, 'applied')
    }
    return { session, transitionId: record.invocationId }
  }

  private advance(
    record: SessionTransitionRecord,
    state: TransitionState,
  ): SessionTransitionRecord {
    const next = { ...record, state, updatedAt: new Date().toISOString() }
    this.upsert(next)
    return next
  }

  private read(): SessionTransitionPayload {
    if (!existsSync(this.path)) return { version: 1, records: [] }
    try {
      const value = JSON.parse(
        readFileSync(this.path, 'utf8'),
      ) as SessionTransitionPayload
      if (value.version !== 1 || !Array.isArray(value.records))
        throw new Error('invalid session transition store')
      return value
    } catch (error) {
      throw new Error('session transition store is corrupt', { cause: error })
    }
  }

  private upsert(record: SessionTransitionRecord): void {
    const payload = this.read()
    const index = payload.records.findIndex(
      (item) => item.invocationId === record.invocationId,
    )
    if (index < 0) payload.records.push(record)
    else payload.records[index] = record
    mkdirSync(dirname(this.path), { recursive: true })
    const tmp = `${this.path}.${process.pid}.tmp`
    writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    renameSync(tmp, this.path)
  }
}

function requireId(value: string, label: string): string {
  const normalized = String(value ?? '').trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(normalized))
    throw new Error(`invalid ${label}`)
  return normalized
}
