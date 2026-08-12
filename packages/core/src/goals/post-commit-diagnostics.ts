import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, open, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { writeJsonAtomic } from '../store/atomic-json'
import { canonicalJson } from './events'
import { syncDirectoryBestEffort } from '../util/fs-durability'
import { GoalGateMutationLedger } from './mutation-ledger'
import type {
  GoalPostCommitDiagnostic,
  GoalPostCommitFailureCode,
} from './contracts/completion'
export type { GoalPostCommitDiagnostic } from './contracts/completion'

export const GOAL_POST_COMMIT_DIAGNOSTIC_SCHEMA_VERSION =
  'emperor.goal.post-commit-diagnostic.v1' as const

export interface GoalPostCommitDiagnosticInspection {
  readonly records: readonly GoalPostCommitDiagnostic[]
  readonly issue: {
    readonly code: 'goal_post_commit_diagnostics_corrupt'
    readonly path: string
  } | null
  readonly recoveryRequired: boolean
}

export class GoalPostCommitDiagnosticsStore {
  readonly path: string
  readonly recoveryPath: string
  private readonly mutations: GoalGateMutationLedger

  constructor(
    stateRoot: string,
    private readonly options: {
      readonly beforeAppend?: (
        diagnostic: GoalPostCommitDiagnostic,
      ) => void | Promise<void>
    } = {},
  ) {
    const goalsRoot = join(stateRoot, 'goals')
    this.path = join(goalsRoot, 'post-commit-diagnostics.jsonl')
    this.recoveryPath = join(goalsRoot, 'post-commit-diagnostics.recovery.json')
    this.mutations = new GoalGateMutationLedger(stateRoot)
  }

  async append(input: {
    readonly goalId: string
    readonly code: Exclude<
      GoalPostCommitFailureCode,
      'diagnostic_persist_failed'
    >
    readonly occurredAt: string
    readonly recordedAt?: string
  }): Promise<GoalPostCommitDiagnostic> {
    const draft = {
      schemaVersion: GOAL_POST_COMMIT_DIAGNOSTIC_SCHEMA_VERSION,
      goalId: requiredText(input.goalId),
      code: input.code,
      occurredAt: requiredTimestamp(input.occurredAt),
      recordedAt: requiredTimestamp(input.recordedAt ?? input.occurredAt),
    }
    const idHash = sha256(canonicalJson(draft))
    const base = { ...draft, id: `goal_diag_${idHash.slice(0, 24)}` }
    const diagnostic: GoalPostCommitDiagnostic = Object.freeze({
      ...base,
      integritySha256: sha256(canonicalJson(base)),
    })
    return await this.mutations.guard.runExclusive('diagnostic', async () => {
      await this.options.beforeAppend?.(diagnostic)
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
      const handle = await open(this.path, 'a', 0o600)
      try {
        await handle.chmod(0o600)
        await handle.writeFile(`${JSON.stringify(diagnostic)}\n`, 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
      await syncDirectoryBestEffort(dirname(this.path))
      return diagnostic
    })
  }

  async markRecoveryRequired(input: {
    readonly goalId: string
    readonly code: Exclude<
      GoalPostCommitFailureCode,
      'diagnostic_persist_failed'
    >
    readonly occurredAt: string
  }): Promise<void> {
    await this.mutations.guard.runExclusive('diagnostic', async () => {
      await writeJsonAtomic(
        this.recoveryPath,
        {
          schemaVersion: 'emperor.goal.post-commit-diagnostic-recovery.v1',
          recoveryRequired: true,
          goalId: requiredText(input.goalId),
          code: input.code,
          occurredAt: requiredTimestamp(input.occurredAt),
        },
        { mode: 0o600 },
      )
      await syncDirectoryBestEffort(dirname(this.recoveryPath))
    })
  }

  async inspect(): Promise<GoalPostCommitDiagnosticInspection> {
    const recoveryRequired = existsSync(this.recoveryPath)
    if (!existsSync(this.path))
      return { records: [], issue: null, recoveryRequired }
    let raw: string
    try {
      raw = await readFile(this.path, 'utf8')
    } catch {
      return {
        records: [],
        issue: {
          code: 'goal_post_commit_diagnostics_corrupt',
          path: this.path,
        },
        recoveryRequired: true,
      }
    }
    const records: GoalPostCommitDiagnostic[] = []
    try {
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue
        records.push(parseDiagnostic(JSON.parse(line)))
      }
      return { records, issue: null, recoveryRequired }
    } catch {
      return {
        records: [],
        issue: {
          code: 'goal_post_commit_diagnostics_corrupt',
          path: this.path,
        },
        recoveryRequired: true,
      }
    }
  }
}

function parseDiagnostic(value: unknown): GoalPostCommitDiagnostic {
  if (!isRecord(value)) throw new Error('invalid diagnostic')
  const base = {
    schemaVersion:
      value.schemaVersion === GOAL_POST_COMMIT_DIAGNOSTIC_SCHEMA_VERSION
        ? value.schemaVersion
        : fail(),
    goalId: requiredText(value.goalId),
    code: validFailureCode(value.code),
    occurredAt: requiredTimestamp(value.occurredAt),
    recordedAt: requiredTimestamp(value.recordedAt),
    id: requiredText(value.id),
  }
  const integritySha256 = String(value.integritySha256 ?? '')
  if (
    !/^[a-f0-9]{64}$/.test(integritySha256) ||
    sha256(canonicalJson(base)) !== integritySha256
  )
    throw new Error('invalid diagnostic')
  return Object.freeze({ ...base, integritySha256 })
}

function validFailureCode(
  value: unknown,
): Exclude<GoalPostCommitFailureCode, 'diagnostic_persist_failed'> {
  if (
    value === 'plan_token_revoke_failed' ||
    value === 'active_run_clear_failed' ||
    value === 'pending_interaction_clear_failed' ||
    value === 'runtime_event_emit_failed'
  )
    return value
  return fail()
}

function requiredText(value: unknown): string {
  const text = String(value ?? '').trim()
  if (!text) throw new Error('invalid diagnostic')
  return text
}

function requiredTimestamp(value: unknown): string {
  const timestamp = String(value ?? '')
  if (!Number.isFinite(Date.parse(timestamp)))
    throw new Error('invalid diagnostic')
  return timestamp
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function fail(): never {
  throw new Error('invalid diagnostic')
}
