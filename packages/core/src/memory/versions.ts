/**
 * 记忆版本快照/diff/restore (MIG-MEM-002)。对齐 Python `agent/memory_versions.py`。
 * 磁盘兼容: memory/versions/{index.json, snapshots/<id>.json}；字段 relPath/createdAt/contentHash（camel）。
 */
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path'
import { randomUUID } from 'node:crypto'

export type MemoryVersionTarget = 'memory' | 'user' | 'episode' | 'project'
const DATE_EPISODE_RE = /^\d{4}-\d{2}-\d{2}\.md$/

export interface MemoryVersion {
  id: string
  target: MemoryVersionTarget
  relPath: string
  label: string
  reason: string
  createdAt: number
  contentHash: string
  bytes: number
}

export function memoryVersionFromDict(
  raw: Record<string, unknown>,
): MemoryVersion {
  const target = String(raw.target ?? 'memory')
  if (!isMemoryVersionTarget(target))
    throw new Error(`unknown memory version target: ${target}`)
  return {
    id: String(raw.id ?? ''),
    target: target as MemoryVersionTarget,
    relPath: String(raw.relPath ?? raw.rel_path ?? ''),
    label: String(raw.label ?? ''),
    reason: String(raw.reason ?? ''),
    createdAt: Number(raw.createdAt ?? raw.created_at ?? 0) || 0,
    contentHash: String(raw.contentHash ?? raw.content_hash ?? ''),
    bytes: Number(raw.bytes ?? 0) || 0,
  }
}

function isMemoryVersionTarget(value: string): value is MemoryVersionTarget {
  return (
    value === 'memory' ||
    value === 'user' ||
    value === 'episode' ||
    value === 'project'
  )
}

export function memoryVersionToDict(v: MemoryVersion): Record<string, unknown> {
  return {
    id: v.id,
    target: v.target,
    relPath: v.relPath,
    label: v.label,
    reason: v.reason,
    createdAt: v.createdAt,
    contentHash: v.contentHash,
    bytes: v.bytes,
  }
}

export class MemoryVersionStore {
  readonly root: string
  readonly memoryDir: string
  readonly userFile: string
  readonly maxVersions: number
  readonly versionsDir: string
  readonly snapshotsDir: string
  readonly indexFile: string

  constructor(
    root: string,
    memoryDir: string,
    userFile: string,
    opts?: { maxVersions?: number },
  ) {
    this.root = resolve(root)
    this.memoryDir = resolve(memoryDir)
    this.userFile = resolve(userFile)
    this.maxVersions = Math.max(1, opts?.maxVersions ?? 300)
    this.versionsDir = join(this.memoryDir, 'versions')
    this.snapshotsDir = join(this.versionsDir, 'snapshots')
    this.indexFile = join(this.versionsDir, 'index.json')
  }

  snapshotPath(
    path: string,
    opts?: { target?: MemoryVersionTarget | null; reason?: string },
  ): MemoryVersion | null {
    const real = resolve(path)
    if (!existsSync(real)) return null
    const resolvedTarget = opts?.target ?? this.targetForPath(real)
    if (resolvedTarget === null)
      throw new Error(`memory version path is not allowed: ${real}`)
    const content = readFileSync(real, 'utf8')
    const digest = createHash('sha256').update(content, 'utf8').digest('hex')
    const relPath = this.rel(real)
    const existing = this.loadIndex()
    const latest = existing.find((item) => item.relPath === relPath)
    if (latest && latest.contentHash === digest) return latest
    const stamp = Date.now() / 1000
    const version: MemoryVersion = {
      id: MemoryVersionStore.newId(stamp, digest),
      target: resolvedTarget,
      relPath,
      label: basename(real),
      reason: String(opts?.reason ?? 'manual') || 'manual',
      createdAt: stamp,
      contentHash: digest,
      bytes: Buffer.byteLength(content, 'utf8'),
    }
    this.writeSnapshot(version, content)
    this.writeIndex([version, ...existing].slice(0, this.maxVersions))
    return version
  }

  list(opts?: {
    limit?: number
    target?: MemoryVersionTarget | null
  }): MemoryVersion[] {
    let items = this.loadIndex()
    if (opts?.target)
      items = items.filter((item) => item.target === opts.target)
    return items.slice(0, Math.max(1, opts?.limit ?? 80))
  }

  nextVersionForPath(
    path: string,
    opts?: { target?: MemoryVersionTarget | null },
  ): number {
    const real = resolve(path)
    const resolvedTarget = opts?.target ?? this.targetForPath(real)
    if (resolvedTarget === null)
      throw new Error(`memory version path is not allowed: ${real}`)
    const relPath = this.rel(real)
    const currentCount = this.loadIndex().filter(
      (item) => item.relPath === relPath && item.target === resolvedTarget,
    ).length
    return currentCount + 1
  }

  detail(versionId: string): Record<string, unknown> {
    const [version, content] = this.readSnapshot(versionId)
    const current = this.currentContent(version.relPath)
    const diff = unifiedDiff(
      content.split('\n'),
      current.split('\n'),
      `${version.relPath}@${version.id}`,
      version.relPath,
    )
    return {
      version: memoryVersionToDict(version),
      content,
      currentContent: current,
      diff,
    }
  }

  restore(versionId: string): Record<string, unknown> {
    const [version, content] = this.readSnapshot(versionId)
    const target = this.resolveRel(version.relPath)
    const resolvedTarget = this.targetForPath(target)
    if (resolvedTarget === null)
      throw new Error(`memory version path is not allowed: ${version.relPath}`)
    this.snapshotPath(target, {
      target: resolvedTarget,
      reason: `pre_restore:${version.id}`,
    })
    MemoryVersionStore.atomicWriteText(
      target,
      content.replace(/\s+$/, '') + '\n',
    )
    return {
      version: memoryVersionToDict(version),
      path: version.relPath,
      content: readFileSync(target, 'utf8'),
    }
  }

  payload(opts?: { limit?: number }): Record<string, unknown> {
    const allItems = this.loadIndex()
    return {
      versions: allItems
        .slice(0, Math.max(1, opts?.limit ?? 30))
        .map(memoryVersionToDict),
      count: allItems.length,
      path: this.rel(this.indexFile),
    }
  }

  private loadIndex(): MemoryVersion[] {
    if (!existsSync(this.indexFile)) return []
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(this.indexFile, 'utf8') || '{}')
    } catch {
      const corrupt = join(
        this.versionsDir,
        `index.corrupt-${Math.trunc(Date.now() / 1000)}.json`,
      )
      try {
        renameSync(this.indexFile, corrupt)
      } catch {
        /* ignore */
      }
      return []
    }
    const rows =
      raw && typeof raw === 'object' && !Array.isArray(raw)
        ? (raw as Record<string, unknown>).versions
        : []
    const out: MemoryVersion[] = []
    for (const row of (rows as unknown[]) ?? []) {
      if (!row || typeof row !== 'object') continue
      const version = memoryVersionFromDict(row as Record<string, unknown>)
      if (version.id) out.push(version)
    }
    return out
  }

  private writeIndex(versions: MemoryVersion[]): void {
    MemoryVersionStore.atomicWriteJson(this.indexFile, {
      schemaVersion: 1,
      updatedAt: Date.now() / 1000,
      versions: versions.map(memoryVersionToDict),
    })
  }

  private writeSnapshot(version: MemoryVersion, content: string): void {
    MemoryVersionStore.atomicWriteJson(
      join(this.snapshotsDir, `${version.id}.json`),
      { version: memoryVersionToDict(version), content },
    )
  }

  private readSnapshot(versionId: string): [MemoryVersion, string] {
    const safeId = String(versionId ?? '').trim()
    if (!/^[a-zA-Z0-9_.-]{8,80}$/.test(safeId))
      throw new Error('invalid memory version id')
    const path = join(this.snapshotsDir, `${safeId}.json`)
    if (!existsSync(path))
      throw new Error(`memory version not found: ${safeId}`)
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    if (!raw || typeof raw !== 'object' || typeof raw.version !== 'object')
      throw new Error('memory version snapshot is invalid')
    return [memoryVersionFromDict(raw.version), String(raw.content ?? '')]
  }

  private targetForPath(path: string): MemoryVersionTarget | null {
    const real = resolve(path)
    if (real === resolve(join(this.memoryDir, 'MEMORY.local.md')))
      return 'memory'
    if (real === this.userFile) return 'user'
    if (
      dirname(real) === this.memoryDir &&
      DATE_EPISODE_RE.test(basename(real))
    )
      return 'episode'
    if (
      basename(real) === 'AGENTS.local.md' &&
      isProjectMemoryRelPath(relative(this.root, real))
    )
      return 'project'
    return null
  }

  private resolveRel(relPath: string): string {
    const target = resolve(join(this.root, relPath))
    if (this.targetForPath(target) === null)
      throw new Error(`memory version path is not allowed: ${relPath}`)
    return target
  }

  private currentContent(relPath: string): string {
    const target = this.resolveRel(relPath)
    return existsSync(target) ? readFileSync(target, 'utf8') : ''
  }

  private rel(path: string): string {
    const r = relative(this.root, resolve(path))
    return r.startsWith('..') ? resolve(path) : r
  }

  private static newId(stamp: number, digest: string): string {
    return `memv_${Math.trunc(stamp * 1000)}_${digest.slice(0, 8)}_${randomUUID().replace(/-/g, '').slice(0, 6)}`
  }

  static atomicWriteText(path: string, content: string): void {
    mkdirSync(dirname(path), { recursive: true })
    const tmp = join(
      dirname(path),
      `.${basename(path)}.${randomUUID().replace(/-/g, '')}.tmp`,
    )
    try {
      writeFileSync(tmp, content, 'utf8')
      renameSync(tmp, path)
    } catch (e) {
      try {
        unlinkSync(tmp)
      } catch {
        /* ignore */
      }
      throw e
    }
  }

  static atomicWriteJson(path: string, payload: Record<string, unknown>): void {
    MemoryVersionStore.atomicWriteText(
      path,
      JSON.stringify(payload, null, 2) + '\n',
    )
  }
}

/** unified diff（对齐 Python difflib.unified_diff 的输出格式）。 */
function unifiedDiff(
  a: string[],
  b: string[],
  fromFile: string,
  toFile: string,
): string {
  const lines: string[] = []
  const ops = diffOps(a, b)
  if (!ops.length) return ''
  lines.push(`--- ${fromFile}`)
  lines.push(`+++ ${toFile}`)
  // 简化的 hunk 输出：difflib 按组分块；此处输出单一聚合 hunk（语义等价于全文 diff）。
  let aStart = -1
  let bStart = -1
  let aCount = 0
  let bCount = 0
  const body: string[] = []
  ops.forEach((op, i) => {
    if (aStart < 0) {
      aStart = op.aIdx
      bStart = op.bIdx
    }
    if (op.tag === 'equal') {
      body.push(` ${op.line}`)
      aCount++
      bCount++
    } else if (op.tag === 'delete') {
      body.push(`-${op.line}`)
      aCount++
    } else {
      body.push(`+${op.line}`)
      bCount++
    }
    void i
  })
  lines.push(`@@ -${aStart + 1},${aCount} +${bStart + 1},${bCount} @@`)
  lines.push(...body)
  return lines.join('\n')
}

interface DiffOp {
  tag: 'equal' | 'delete' | 'insert'
  line: string
  aIdx: number
  bIdx: number
}

function diffOps(a: string[], b: string[]): DiffOp[] {
  // LCS-based minimal diff
  const n = a.length
  const m = b.length
  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    new Array(m + 1).fill(0),
  )
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] =
        a[i] === b[j]
          ? dp[i + 1]![j + 1]! + 1
          : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!)
    }
  }
  const ops: DiffOp[] = []
  let i = 0
  let j = 0
  let changed = false
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ tag: 'equal', line: a[i]!, aIdx: i, bIdx: j })
      i++
      j++
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      ops.push({ tag: 'delete', line: a[i]!, aIdx: i, bIdx: j })
      i++
      changed = true
    } else {
      ops.push({ tag: 'insert', line: b[j]!, aIdx: i, bIdx: j })
      j++
      changed = true
    }
  }
  while (i < n) {
    ops.push({ tag: 'delete', line: a[i]!, aIdx: i, bIdx: j })
    i++
    changed = true
  }
  while (j < m) {
    ops.push({ tag: 'insert', line: b[j]!, aIdx: i, bIdx: j })
    j++
    changed = true
  }
  return changed ? ops : []
}

function isProjectMemoryRelPath(relPath: string): boolean {
  if (!relPath || relPath.startsWith('..') || isAbsolute(relPath)) return false
  const parts = relPath.split(/[\\/]+/)
  return (
    parts.length === 3 &&
    parts[0] === 'projects' &&
    parts[2] === 'AGENTS.local.md' &&
    Boolean(parts[1])
  )
}
