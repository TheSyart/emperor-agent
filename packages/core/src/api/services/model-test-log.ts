import { join } from 'node:path'
import { readJson, writeJsonAtomic } from '../../store/atomic-json'

/**
 * The last connection test of each saved model (MOD-05): Settings › 模型
 * shows a connection as 「已连接」, 「Key 无效 · N 天前测试」 or 「未测试」 from
 * it. Kept beside model_config.json as `model_tests.json` (runtime state,
 * not configuration: the file is never copied into model_config.json), by
 * entry id; entries that are gone are dropped on the next write.
 */
export interface ModelTestRecord {
  ok: boolean
  kind: 'text' | 'vision'
  testedAt: string
  /** Why it failed: the key was refused, or anything else. */
  failure?: 'auth' | 'error'
}

const FILE = 'model_tests.json'

function isRecord(value: unknown): value is ModelTestRecord {
  if (!value || typeof value !== 'object') return false
  const data = value as Record<string, unknown>
  return (
    typeof data.ok === 'boolean' &&
    (data.kind === 'text' || data.kind === 'vision') &&
    typeof data.testedAt === 'string' &&
    (data.failure === undefined ||
      data.failure === 'auth' ||
      data.failure === 'error')
  )
}

export class ModelTestLog {
  private readonly path: string

  constructor(root: string) {
    this.path = join(root, FILE)
  }

  async all(): Promise<Record<string, ModelTestRecord>> {
    const raw = await readJson<Record<string, unknown>>(this.path, {})
    const result: Record<string, ModelTestRecord> = {}
    if (!raw || typeof raw !== 'object') return result
    for (const [entryId, record] of Object.entries(raw))
      if (isRecord(record)) result[entryId] = record
    return result
  }

  /** Record `entryId`'s test, keeping only the ids in `keep`. */
  async record(
    entryId: string,
    record: ModelTestRecord,
    keep: ReadonlySet<string>,
  ): Promise<void> {
    const current = await this.all()
    const next: Record<string, ModelTestRecord> = {}
    for (const [id, value] of Object.entries(current))
      if (keep.has(id)) next[id] = value
    next[entryId] = record
    await writeJsonAtomic(this.path, next)
  }
}

/** A failed test whose error says the key was refused. */
export function testFailureKind(error: unknown): 'auth' | 'error' {
  const data =
    error && typeof error === 'object'
      ? (error as { code?: unknown; failure?: { status?: unknown } })
      : {}
  const code = String(data.code ?? '')
  const status = Number(data.failure?.status)
  if (code === 'AUTH' || code === 'INVALID_CREDENTIAL') return 'auth'
  if (status === 401 || status === 403) return 'auth'
  const message = error instanceof Error ? error.message : String(error)
  return /\b(?:401|403)\b|unauthori[sz]ed|invalid api key|incorrect api key/i.test(
    message,
  )
    ? 'auth'
    : 'error'
}
