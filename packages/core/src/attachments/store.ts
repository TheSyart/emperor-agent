import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join, relative, sep } from 'node:path'
import {
  extractDocumentText,
  type PdfTextExtractor,
  SIDECAR_SUFFIX,
} from './extract'

export const ALLOWED_IMAGE_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'image/gif',
])
export const ALLOWED_DOC_MIMES = new Set([
  'application/pdf',
  'application/json',
  'text/csv',
  'text/plain',
  'text/markdown',
  'text/x-markdown',
])

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024
export const MAX_DOC_BYTES = 25 * 1024 * 1024
export const TEXT_INLINE_LIMIT = 50_000

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'application/pdf': 'pdf',
  'application/json': 'json',
  'text/csv': 'csv',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'text/x-markdown': 'md',
}

export type AttachmentKind = 'image' | 'document' | 'text'

export interface AttachmentRef {
  id: string
  name: string
  mime: string
  size: number
  kind: AttachmentKind
  has_text: boolean
  has_image: boolean
  rel_path: string
  text_rel_path: string | null
}

export interface AttachmentStoreOptions {
  now?: () => Date
  pdfTextExtractor?: PdfTextExtractor | null
}

export class AttachmentStore {
  readonly root: string
  readonly base: string
  private readonly now: () => Date
  private readonly pdfTextExtractor: PdfTextExtractor | null
  private readonly cache = new Map<string, AttachmentRef>()
  private readonly cacheMax = 64

  constructor(root: string, opts: AttachmentStoreOptions = {}) {
    this.root = root
    this.base = join(root, 'memory', 'attachments')
    this.now = opts.now ?? (() => new Date())
    this.pdfTextExtractor = opts.pdfTextExtractor ?? null
    mkdirSync(this.base, { recursive: true })
  }

  save(opts: {
    raw: Buffer | Uint8Array
    name: string
    mime: string
  }): AttachmentRef {
    const raw = Buffer.from(opts.raw)
    const mime = String(opts.mime || '')
      .toLowerCase()
      .trim()
    const isImage = ALLOWED_IMAGE_MIMES.has(mime)
    const isDoc = ALLOWED_DOC_MIMES.has(mime)
    if (!isImage && !isDoc)
      throw new Error(`unsupported mime: ${JSON.stringify(mime)}`)

    const limit = isImage ? MAX_IMAGE_BYTES : MAX_DOC_BYTES
    if (raw.length > limit)
      throw new Error(
        `file too large: ${raw.length} bytes (limit ${limit} for ${isImage ? 'image' : 'document'})`,
      )

    const hash8 = createHash('sha256').update(raw).digest('hex').slice(0, 8)
    const month = utc8Month(this.now())
    const ext = EXT_BY_MIME[mime] ?? extFromName(opts.name) ?? 'bin'
    const safe = safeName(opts.name)
    const relDir = ['memory', 'attachments', month].join('/')
    const absDir = join(this.root, 'memory', 'attachments', month)
    mkdirSync(absDir, { recursive: true })
    const fileName = safe.toLowerCase().endsWith(`.${ext}`)
      ? `${hash8}-${safe}`
      : `${hash8}-${safe}.${ext}`
    const absPath = join(absDir, fileName)
    const relPath = `${relDir}/${fileName}`
    if (!existsSync(absPath)) writeFileSync(absPath, raw)

    let textRelPath: string | null = null
    let hasText = false
    const kind: AttachmentKind = isImage
      ? 'image'
      : mime === 'application/pdf'
        ? 'document'
        : 'text'
    if (!isImage) {
      const text = extractDocumentText(raw, mime, {
        pdfTextExtractor: this.pdfTextExtractor,
      })
      if (text && text.trim()) {
        const sidecarName = fileName + SIDECAR_SUFFIX
        writeFileSync(join(absDir, sidecarName), text, 'utf8')
        textRelPath = `${relDir}/${sidecarName}`
        hasText = true
      }
    }

    const ref: AttachmentRef = {
      id: `att_${month}_${hash8}`,
      name: opts.name || fileName,
      mime,
      size: raw.length,
      kind,
      has_text: hasText,
      has_image: isImage,
      rel_path: relPath,
      text_rel_path: textRelPath,
    }
    this.cachePut(ref)
    return ref
  }

  get(attId: string): AttachmentRef | null {
    if (!attId || !attId.startsWith('att_')) return null
    const cached = this.cache.get(attId)
    if (cached) {
      this.cache.delete(attId)
      this.cache.set(attId, cached)
      return cached
    }
    const match = /^att_(\d{4}-\d{2})_([0-9a-f]{8})$/.exec(attId)
    if (!match) return null
    const [, month, hash8] = match
    const monthDir = join(this.base, month!)
    if (!existsSync(monthDir)) return null
    const names = readDirSafe(monthDir).sort()
    for (const name of names) {
      if (!name.startsWith(`${hash8}-`)) continue
      if (
        name.endsWith(SIDECAR_SUFFIX) &&
        existsSync(join(monthDir, name.slice(0, -SIDECAR_SUFFIX.length)))
      )
        continue
      const path = join(monthDir, name)
      let isFile = false
      try {
        isFile = statSync(path).isFile()
      } catch {
        isFile = false
      }
      if (!isFile) continue
      const ref = this.buildRefFromPath(attId, path)
      this.cachePut(ref)
      return ref
    }
    return null
  }

  /**
   * Delete a stored attachment and its text sidecar (Computer Use
   * screenshot quota and "clear screenshots"). Returns the bytes freed;
   * 0 when it was already gone.
   */
  remove(attId: string): number {
    this.cache.delete(attId)
    const match = /^att_(\d{4}-\d{2})_([0-9a-f]{8})$/.exec(attId)
    if (!match) return 0
    const [, month, hash8] = match
    const monthDir = join(this.base, month!)
    // The id names the content, but each save names its file: the same
    // bytes saved twice (two identical screenshots) are two files under one
    // id. Remove them all, sidecars included, or a copy outlives the clear.
    let freed = 0
    for (const name of readDirSafe(monthDir)) {
      if (!name.startsWith(`${hash8}-`)) continue
      const path = join(monthDir, name)
      try {
        const stats = statSync(path)
        if (!stats.isFile()) continue
        unlinkSync(path)
        freed += stats.size
      } catch {
        // already gone
      }
    }
    return freed
  }

  readBytes(ref: AttachmentRef): Buffer {
    return readFileSync(join(this.root, ref.rel_path))
  }

  readText(ref: AttachmentRef, limit = TEXT_INLINE_LIMIT): string {
    if (!ref.has_text || !ref.text_rel_path) return ''
    let text: string
    try {
      text = readFileSync(join(this.root, ref.text_rel_path), 'utf8')
    } catch {
      return ''
    }
    if (text.length <= limit) return text
    const head = text.slice(0, Math.max(0, limit - 200))
    const tail = text.slice(-200)
    return `${head}\n...[truncated, total ${text.length} chars]...\n${tail}`
  }

  private buildRefFromPath(attId: string, absPath: string): AttachmentRef {
    const relPath = toPosix(relative(this.root, absPath))
    const sidecar = absPath + SIDECAR_SUFFIX
    const hasText = existsSync(sidecar)
    const textRelPath = hasText ? toPosix(relative(this.root, sidecar)) : null
    const ext = (absPath.split('.').pop() ?? '').toLowerCase()
    const mime = mimeFromExt(ext) ?? 'application/octet-stream'
    const isImage = ALLOWED_IMAGE_MIMES.has(mime)
    const kind: AttachmentKind = isImage
      ? 'image'
      : mime === 'application/pdf'
        ? 'document'
        : 'text'
    const name = absPath
      .split(/[\\/]/)
      .pop()!
      .replace(/^[0-9a-f]{8}-/, '')
    return {
      id: attId,
      name,
      mime,
      size: existsSync(absPath) ? statSync(absPath).size : 0,
      kind,
      has_text: hasText,
      has_image: isImage,
      rel_path: relPath,
      text_rel_path: textRelPath,
    }
  }

  private cachePut(ref: AttachmentRef): void {
    if (this.cache.has(ref.id)) this.cache.delete(ref.id)
    this.cache.set(ref.id, ref)
    while (this.cache.size > this.cacheMax) {
      const oldest = this.cache.keys().next().value
      if (oldest === undefined) break
      this.cache.delete(oldest)
    }
  }
}

export function safeName(name: string): string {
  if (!name) return 'unnamed'
  let cleaned = name.replace(/[\\/]/g, '_')
  cleaned = Array.from(cleaned)
    .filter((ch) => ch === '\t' || ch.codePointAt(0)! >= 32)
    .join('')
  cleaned = cleaned.trim().replace(/^[. ]+|[. ]+$/g, '')
  if (!cleaned) return 'unnamed'
  if (cleaned.length > 80) {
    const idx = cleaned.lastIndexOf('.')
    if (idx > 0) {
      const stem = cleaned.slice(0, idx)
      const ext = cleaned.slice(idx + 1)
      cleaned =
        ext.length <= 8
          ? `${stem.slice(0, 80 - ext.length - 1)}.${ext}`
          : cleaned.slice(0, 80)
    } else {
      cleaned = cleaned.slice(0, 80)
    }
  }
  return cleaned
}

export function extFromName(name: string): string | null {
  const idx = name.lastIndexOf('.')
  if (idx < 0) return null
  const ext = name.slice(idx + 1).toLowerCase()
  return ext.length >= 1 && ext.length <= 8 && /^[a-z0-9]+$/.test(ext)
    ? ext
    : null
}

export function mimeFromExt(ext: string): string | null {
  const normalized = ext.toLowerCase()
  for (const [mime, value] of Object.entries(EXT_BY_MIME)) {
    if (value === normalized) return mime
  }
  return null
}

function utc8Month(date: Date): string {
  return new Date(date.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 7)
}

function toPosix(path: string): string {
  return sep === '/' ? path : path.split(sep).join('/')
}

function readDirSafe(path: string): string[] {
  try {
    return readdirSync(path)
  } catch {
    return []
  }
}
