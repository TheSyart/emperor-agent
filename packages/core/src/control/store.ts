/**
 * ControlStore。
 * 磁盘格式：
 * - legacy/default: <stateRoot>/control/state.json
 * - session-owned: <stateRoot>/control/sessions/<sessionId>/state.json
 *
 * Session store 只读旧全局文件做一次迁移，不双写。旧 pending 只有在 owner
 * 明确匹配时才会迁入；无 owner 的 pending fail closed。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  SCHEMA_VERSION,
  controlStateFromDict,
  controlStateToDict,
  defaultControlState,
  type ControlState,
} from './models'
import { GoalGateMutationLedger } from '../goals/mutation-ledger'
import {
  AtomicSnapshotSync,
  type SnapshotCodec,
  type SyncPersistenceAdapter,
} from '../store/persistence'

export interface ControlStoreInspection {
  readonly record: ControlState | null
  readonly migrationRequired: boolean
  readonly issue: {
    readonly code: 'control_state_missing' | 'control_state_corrupt'
    readonly path: string
  } | null
}

export interface ControlStoreOptions {
  readonly sessionId?: string | null
  readonly persistenceAdapter?: SyncPersistenceAdapter
}

type PendingMigrationDisposition =
  | 'none'
  | 'migrated'
  | 'foreign'
  | 'ambiguous'
  | 'legacy_missing'
  | 'legacy_corrupt'

export class ControlStore {
  readonly root: string
  readonly controlDir: string
  readonly stateFile: string
  readonly migrationReceiptFile: string
  readonly sessionId: string | null
  private readonly stateDir: string
  private readonly goalMutations: GoalGateMutationLedger
  private readonly persistenceAdapter?: SyncPersistenceAdapter

  constructor(root: string, options: ControlStoreOptions = {}) {
    this.root = resolve(root)
    this.controlDir = join(this.root, 'control')
    this.sessionId = normalizeSessionId(options.sessionId)
    this.stateDir = this.sessionId
      ? join(this.controlDir, 'sessions', encodeURIComponent(this.sessionId))
      : this.controlDir
    this.stateFile = join(this.stateDir, 'state.json')
    this.migrationReceiptFile = join(this.stateDir, 'migration.json')
    this.persistenceAdapter = options.persistenceAdapter
    this.goalMutations = new GoalGateMutationLedger(this.root)
    this.ensure()
  }

  private ensure(): void {
    if (existsSync(this.stateFile)) return
    this.goalMutations.withSynchronousMutation(
      'control',
      'control-store:init',
      () => {
        mkdirSync(this.stateDir, { recursive: true })
        if (this.sessionId) this.migrateLegacySessionState()
        else this.copyLegacyStateIfNeeded()
        if (!existsSync(this.stateFile)) {
          const payload = controlStateToDict(defaultControlState())
          payload.version = SCHEMA_VERSION
          this.atomicWriteJson(this.stateFile, payload)
        }
      },
    )
  }

  load(): ControlState {
    const inspected = this.inspect()
    const record = inspected.record ?? defaultControlState()
    if (inspected.record && inspected.migrationRequired) this.save(record)
    return record
  }

  /** Pure fail-closed read for completion-sensitive callers. */
  inspect(): ControlStoreInspection {
    if (!existsSync(this.stateFile))
      return {
        record: null,
        migrationRequired: false,
        issue: { code: 'control_state_missing', path: this.stateFile },
      }
    try {
      const raw = JSON.parse(readFileSync(this.stateFile, 'utf8') || '{}')
      if (!isValidControlDocument(raw)) throw new Error('invalid Control state')
      const record = controlStateFromDict(raw)
      if (
        (raw.pending !== null &&
          raw.pending !== undefined &&
          !record.pending) ||
        (raw.last_interaction !== null &&
          raw.last_interaction !== undefined &&
          !record.lastInteraction)
      )
        throw new Error('invalid Control interaction')
      return {
        record,
        migrationRequired: Number(raw.version ?? 1) < SCHEMA_VERSION,
        issue: null,
      }
    } catch {
      return {
        record: null,
        migrationRequired: false,
        issue: { code: 'control_state_corrupt', path: this.stateFile },
      }
    }
  }

  save(state: ControlState): void {
    const payload = controlStateToDict(state)
    payload.version =
      Number(payload.version ?? SCHEMA_VERSION) || SCHEMA_VERSION
    this.goalMutations.withSynchronousMutation(
      'control',
      `control:${String(payload.pending?.id ?? payload.last_interaction?.id ?? 'idle')}:${Date.now()}`,
      () => this.atomicWriteJson(this.stateFile, payload),
    )
  }

  private atomicWriteJson(
    path: string,
    payload: Record<string, unknown>,
  ): void {
    new AtomicSnapshotSync({
      path,
      codec: CONTROL_DOCUMENT_CODEC,
      adapter: this.persistenceAdapter,
      fileMode: 0o600,
    }).write(payload)
  }

  private copyLegacyStateIfNeeded(): void {
    const legacy = join(this.root, 'memory', 'control', 'state.json')
    if (existsSync(this.stateFile) || !existsSync(legacy)) return
    try {
      copyFileSync(legacy, this.stateFile)
    } catch {
      /* non-destructive best effort */
    }
  }

  private migrateLegacySessionState(): void {
    if (!this.sessionId || existsSync(this.stateFile)) return
    const legacyPath = join(this.controlDir, 'state.json')
    if (!existsSync(legacyPath)) {
      this.writeMigrationReceipt('legacy_missing', legacyPath, null)
      return
    }
    try {
      const raw = JSON.parse(readFileSync(legacyPath, 'utf8') || '{}')
      if (!isValidControlDocument(raw)) throw new Error('invalid Control state')
      const state = controlStateFromDict(raw)
      const pendingOwner = interactionOwnerSessionId(state.pending)
      const lastOwner = interactionOwnerSessionId(state.lastInteraction)
      const pendingDisposition: PendingMigrationDisposition = !state.pending
        ? 'none'
        : pendingOwner === this.sessionId
          ? 'migrated'
          : pendingOwner
            ? 'foreign'
            : 'ambiguous'
      if (pendingOwner !== this.sessionId) state.pending = null
      if (lastOwner !== this.sessionId) state.lastInteraction = null
      state.updatedAt = Math.max(state.updatedAt, Date.now() / 1000)
      this.atomicWriteJson(this.stateFile, controlStateToDict(state))
      this.writeMigrationReceipt(pendingDisposition, legacyPath, pendingOwner)
    } catch {
      this.writeMigrationReceipt('legacy_corrupt', legacyPath, null)
    }
  }

  private writeMigrationReceipt(
    pendingDisposition: PendingMigrationDisposition,
    legacyPath: string,
    declaredOwnerSessionId: string | null,
  ): void {
    if (!this.sessionId || existsSync(this.migrationReceiptFile)) return
    this.atomicWriteJson(this.migrationReceiptFile, {
      schema_version: 'emperor.control.session-migration.v1',
      session_id: this.sessionId,
      source: legacyPath,
      pending_disposition: pendingDisposition,
      declared_owner_session_id: declaredOwnerSessionId,
      migrated_at: new Date().toISOString(),
    })
  }
}

const CONTROL_DOCUMENT_CODEC: SnapshotCodec<Record<string, unknown>> = {
  schemaVersion: SCHEMA_VERSION,
  encode(value) {
    return value
  },
  decode(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw new Error('invalid Control document')
    const value = input as Record<string, unknown>
    return {
      value,
      schemaVersion: Number(value.version ?? 1) || 1,
      migrated: Number(value.version ?? 1) < SCHEMA_VERSION,
    }
  },
}

function normalizeSessionId(value: string | null | undefined): string | null {
  const normalized = String(value ?? '').trim()
  if (!normalized) return null
  if (normalized === '.' || normalized === '..' || normalized.includes('\0'))
    throw new Error('invalid Control session id')
  return normalized
}

function interactionOwnerSessionId(
  interaction: ControlState['pending'],
): string | null {
  if (!interaction) return null
  const meta = interaction.meta ?? {}
  for (const value of [
    meta.control_session_id,
    meta.goal_session_id,
    meta.session_id,
  ]) {
    const normalized = String(value ?? '').trim()
    if (normalized) return normalized
  }
  return null
}

function isValidControlDocument(
  value: unknown,
): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const raw = value as Record<string, unknown>
  return (
    Number.isFinite(raw.version) &&
    typeof raw.mode === 'string' &&
    Number.isFinite(raw.updated_at ?? raw.updatedAt)
  )
}
