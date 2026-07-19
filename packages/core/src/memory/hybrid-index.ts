import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type {
  HybridMemoryChunkInput,
  HybridMemorySource,
} from './hybrid-retrieval'

export interface HybridMemoryDocument {
  id: string
  content: string
  source: HybridMemorySource
  path: string
  createdAt: number
  projectId?: string | null
  sessionId?: string | null
}

export interface HybridMemoryChunkOptions {
  maxChars?: number
}

export interface HybridMemoryDerivedIndexSnapshot {
  schemaVersion: 1
  status: 'missing' | 'ok' | 'corrupt'
  sourceDigest: string
  chunks: HybridMemoryChunkInput[]
}

export interface HybridMemoryDerivedIndexSync extends HybridMemoryDerivedIndexSnapshot {
  changed: boolean
  added: number
  removed: number
  derivedDiskBytes: number
}

interface StoredIndex {
  schemaVersion: 1
  sourceDigest: string
  chunks: HybridMemoryChunkInput[]
}

interface LineSection {
  heading: string
  startLine: number
  lines: Array<{ number: number; text: string }>
}

export class HybridMemoryDerivedIndexStore {
  readonly root: string
  readonly indexDir: string
  readonly indexPath: string

  constructor(stateRoot: string) {
    this.root = resolve(stateRoot)
    this.indexDir = join(this.root, 'memory', 'hybrid-index')
    this.indexPath = join(this.indexDir, 'index.v1.json')
  }

  load(): HybridMemoryDerivedIndexSnapshot {
    if (!existsSync(this.indexPath)) return emptySnapshot('missing')
    try {
      const parsed = JSON.parse(readFileSync(this.indexPath, 'utf8'))
      if (!isStoredIndex(parsed)) return emptySnapshot('corrupt')
      return {
        schemaVersion: 1,
        status: 'ok',
        sourceDigest: parsed.sourceDigest,
        chunks: parsed.chunks.map(cloneChunk),
      }
    } catch {
      return emptySnapshot('corrupt')
    }
  }

  sync(
    documents: readonly HybridMemoryDocument[],
    options: HybridMemoryChunkOptions = {},
  ): HybridMemoryDerivedIndexSync {
    const normalized = normalizeDocuments(documents)
    const sourceDigest = digestDocuments(normalized, options)
    const current = this.load()
    if (current.status === 'ok' && current.sourceDigest === sourceDigest)
      return {
        ...current,
        changed: false,
        added: 0,
        removed: 0,
        derivedDiskBytes: fileBytes(this.indexPath),
      }

    const chunks = chunkHybridMemoryDocuments(normalized, options)
    const previousIds = new Set(current.chunks.map((chunk) => chunk.id))
    const nextIds = new Set(chunks.map((chunk) => chunk.id))
    const stored: StoredIndex = { schemaVersion: 1, sourceDigest, chunks }
    atomicWriteJson(this.indexPath, stored)
    return {
      schemaVersion: 1,
      status: 'ok',
      sourceDigest,
      chunks: chunks.map(cloneChunk),
      changed: true,
      added: [...nextIds].filter((id) => !previousIds.has(id)).length,
      removed: [...previousIds].filter((id) => !nextIds.has(id)).length,
      derivedDiskBytes: fileBytes(this.indexPath),
    }
  }
}

export function chunkHybridMemoryDocuments(
  documents: readonly HybridMemoryDocument[],
  options: HybridMemoryChunkOptions = {},
): HybridMemoryChunkInput[] {
  const maxChars = clampInteger(options.maxChars ?? 1_200, 120, 8_000)
  const chunks: HybridMemoryChunkInput[] = []
  for (const document of normalizeDocuments(documents)) {
    for (const section of markdownSections(document.content)) {
      for (const part of splitSection(section, maxChars)) {
        if (!hasSubstantiveContent(part.text)) continue
        chunks.push({
          id: chunkId(document, part),
          text: part.text,
          source: document.source,
          path: document.path,
          createdAt: document.createdAt,
          projectId: document.projectId ?? null,
          sessionId: document.sessionId ?? null,
          startLine: part.startLine,
          endLine: part.endLine,
          accessCount: 0,
        })
      }
    }
  }
  return chunks.sort(
    (left, right) =>
      left.source.localeCompare(right.source) ||
      String(left.projectId ?? '').localeCompare(
        String(right.projectId ?? ''),
      ) ||
      left.path.localeCompare(right.path) ||
      Number(left.startLine) - Number(right.startLine) ||
      left.id.localeCompare(right.id),
  )
}

function normalizeDocuments(
  documents: readonly HybridMemoryDocument[],
): HybridMemoryDocument[] {
  return documents
    .map((document) => {
      const id = String(document.id ?? '').trim()
      const path = String(document.path ?? '').trim()
      const content = String(document.content ?? '').replace(/\r\n?/g, '\n')
      if (!id || !path) throw new Error('memory document requires id and path')
      if (
        document.source !== 'global' &&
        document.source !== 'project' &&
        document.source !== 'session'
      )
        throw new Error(`unsupported memory source: ${String(document.source)}`)
      return {
        id,
        content,
        source: document.source,
        path,
        createdAt: Math.max(0, Number(document.createdAt) || 0),
        projectId: nullableString(document.projectId),
        sessionId: nullableString(document.sessionId),
      }
    })
    .sort(
      (left, right) =>
        left.id.localeCompare(right.id) || left.path.localeCompare(right.path),
    )
}

function markdownSections(content: string): LineSection[] {
  const lines = content.split('\n')
  const sections: LineSection[] = []
  let current: LineSection = { heading: '', startLine: 1, lines: [] }
  const flush = () => {
    if (current.lines.length) sections.push(current)
  }
  for (let index = 0; index < lines.length; index += 1) {
    const text = lines[index]!
    if (/^#{2,6}\s+\S/.test(text)) {
      flush()
      current = {
        heading: text.trimEnd(),
        startLine: index + 1,
        lines: [{ number: index + 1, text }],
      }
    } else {
      current.lines.push({ number: index + 1, text })
    }
  }
  flush()
  return sections
}

function splitSection(
  section: LineSection,
  maxChars: number,
): Array<{ text: string; startLine: number; endLine: number }> {
  const trimmed = trimBlankLines(section.lines)
  if (!trimmed.length) return []
  const fullText = trimmed
    .map((line) => line.text)
    .join('\n')
    .trim()
  if (fullText.length <= maxChars)
    return [
      {
        text: fullText,
        startLine: trimmed[0]!.number,
        endLine: trimmed.at(-1)!.number,
      },
    ]

  const heading = /^#{2,6}\s+/.test(trimmed[0]!.text)
    ? trimmed[0]!.text.trimEnd()
    : ''
  const body = heading ? trimmed.slice(1) : trimmed
  const paragraphs = paragraphGroups(body)
  const parts: Array<{ text: string; startLine: number; endLine: number }> = []
  let group: Array<{ number: number; text: string }> = []
  const flush = () => {
    const lines = trimBlankLines(group)
    if (!lines.length) return
    const bodyText = lines
      .map((line) => line.text)
      .join('\n')
      .trim()
    parts.push({
      text: heading ? `${heading}\n\n${bodyText}` : bodyText,
      startLine: heading ? section.startLine : lines[0]!.number,
      endLine: lines.at(-1)!.number,
    })
    group = []
  }
  for (const paragraph of paragraphs) {
    const candidate = [...group, ...paragraph]
    const text = candidate.map((line) => line.text).join('\n')
    const size = text.length + (heading ? heading.length + 2 : 0)
    if (group.length && size > maxChars) flush()
    group.push(...paragraph)
  }
  flush()
  return parts
}

function paragraphGroups(
  lines: Array<{ number: number; text: string }>,
): Array<Array<{ number: number; text: string }>> {
  const groups: Array<Array<{ number: number; text: string }>> = []
  let group: Array<{ number: number; text: string }> = []
  for (const line of lines) {
    if (!line.text.trim()) {
      if (group.length) groups.push(group)
      group = []
      continue
    }
    group.push(line)
  }
  if (group.length) groups.push(group)
  return groups
}

function trimBlankLines(
  lines: Array<{ number: number; text: string }>,
): Array<{ number: number; text: string }> {
  let start = 0
  let end = lines.length
  while (start < end && !lines[start]!.text.trim()) start += 1
  while (end > start && !lines[end - 1]!.text.trim()) end -= 1
  return lines.slice(start, end)
}

function hasSubstantiveContent(text: string): boolean {
  const withoutComments = text.replace(/<!--[\s\S]*?-->/g, '')
  return withoutComments
    .split('\n')
    .some((line) => line.trim() && !/^#{1,6}\s+/.test(line.trim()))
}

function chunkId(
  document: HybridMemoryDocument,
  part: { text: string; startLine: number; endLine: number },
): string {
  return sha256(
    [
      document.id,
      document.source,
      document.projectId ?? '',
      document.sessionId ?? '',
      document.path,
      part.startLine,
      part.endLine,
      part.text,
    ].join('\0'),
  )
}

function digestDocuments(
  documents: readonly HybridMemoryDocument[],
  options: HybridMemoryChunkOptions,
): string {
  return sha256(
    stableJson({
      maxChars: clampInteger(options.maxChars ?? 1_200, 120, 8_000),
      documents: documents.map((document) => ({
        ...document,
        contentSha256: sha256(document.content),
        content: undefined,
      })),
    }),
  )
}

function atomicWriteJson(path: string, value: StoredIndex): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = join(dirname(path), `.index.${randomUUID()}.tmp`)
  const payload = `${JSON.stringify(value, null, 2)}\n`
  let fileDescriptor: number | null = null
  try {
    writeFileSync(tmp, payload, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    fileDescriptor = openSync(tmp, 'r')
    fsyncSync(fileDescriptor)
    closeSync(fileDescriptor)
    fileDescriptor = null
    renameSync(tmp, path)
    const directoryDescriptor = openSync(dirname(path), 'r')
    try {
      fsyncSync(directoryDescriptor)
    } finally {
      closeSync(directoryDescriptor)
    }
  } finally {
    if (fileDescriptor !== null) closeSync(fileDescriptor)
  }
}

function isStoredIndex(value: unknown): value is StoredIndex {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    record.schemaVersion === 1 &&
    typeof record.sourceDigest === 'string' &&
    /^[a-f0-9]{64}$/.test(record.sourceDigest) &&
    Array.isArray(record.chunks) &&
    record.chunks.every(isChunk)
  )
}

function isChunk(value: unknown): value is HybridMemoryChunkInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.id === 'string' &&
    /^[a-f0-9]{64}$/.test(record.id) &&
    typeof record.text === 'string' &&
    typeof record.path === 'string' &&
    (record.source === 'global' ||
      record.source === 'project' ||
      record.source === 'session') &&
    Number.isFinite(Number(record.createdAt))
  )
}

function cloneChunk(chunk: HybridMemoryChunkInput): HybridMemoryChunkInput {
  return { ...chunk }
}

function emptySnapshot(
  status: 'missing' | 'corrupt',
): HybridMemoryDerivedIndexSnapshot {
  return { schemaVersion: 1, status, sourceDigest: '', chunks: [] }
}

function fileBytes(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

function nullableString(value: unknown): string | null {
  const normalized = String(value ?? '').trim()
  return normalized || null
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Math.trunc(Number(value) || 0)))
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object')
    return `{${Object.keys(value as Record<string, unknown>)
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`,
      )
      .join(',')}}`
  return JSON.stringify(value) ?? 'null'
}
