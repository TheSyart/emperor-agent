/**
 * ControlStore (MIG-CTRL-001)。对齐 Python `agent/control/store.py`。
 * 磁盘格式: <stateRoot>/control/state.json，indent=2；解析失败回退默认。
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  SCHEMA_VERSION,
  controlStateFromDict,
  controlStateToDict,
  defaultControlState,
  type ControlState,
} from './models'
import { GoalGateMutationLedger } from '../goals/mutation-ledger'

export interface ControlStoreInspection {
  readonly record: ControlState | null
  readonly migrationRequired: boolean
  readonly issue: {
    readonly code: 'control_state_missing' | 'control_state_corrupt'
    readonly path: string
  } | null
}

export class ControlStore {
  readonly root: string
  readonly controlDir: string
  readonly stateFile: string
  private readonly goalMutations: GoalGateMutationLedger

  constructor(root: string) {
    this.root = resolve(root)
    this.controlDir = join(this.root, 'control')
    this.stateFile = join(this.controlDir, 'state.json')
    this.goalMutations = new GoalGateMutationLedger(this.root)
    this.ensure()
  }

  private ensure(): void {
    if (existsSync(this.stateFile)) return
    this.goalMutations.withSynchronousMutation(
      'control',
      'control-store:init',
      () => {
        mkdirSync(this.controlDir, { recursive: true })
        this.copyLegacyStateIfNeeded()
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
    mkdirSync(this.controlDir, { recursive: true })
    const tmp = join(
      this.controlDir,
      `.state.json.${randomUUID().replace(/-/g, '')}.tmp`,
    )
    writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8')
    renameSync(tmp, path)
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
