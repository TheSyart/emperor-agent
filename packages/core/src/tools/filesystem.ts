/**
 * 文件系统工具 (MIG-TOOL-006/007)。
 * 对齐 Python `agent/tools/filesystem.py`：ReadFileTool/WriteFileTool/EditFileTool。
 * 工作区路径禁闭：expanduser + resolve 规范化后 relative_to 检查。
 */
import { existsSync } from 'node:fs'
import {
  lstat,
  mkdir,
  open,
  rename as fsRename,
  stat,
  unlink,
  writeFile as fsWriteFile,
} from 'node:fs/promises'
import { dirname } from 'node:path'
import type { CodeGraphFileEvent } from '../code-intelligence/models'
import {
  formatWorkspacePolicyError,
  workspacePolicyForTool,
} from '../permissions/workspace-policy'
import {
  Tool,
  type ToolExecutionContext,
  type ToolResult,
  okResult,
  errResult,
} from './base'
import { S, toolParamsSchema } from './schema'

const PDF_MAGIC = Buffer.from('%PDF')
const MAX_TEXT_FILE_BYTES = 8 * 1024 * 1024
const TEXT_READ_CHUNK_BYTES = 64 * 1024
const TEXT_FILE_TOO_LARGE_ERROR = '[ERR] file exceeds 8 MiB read limit'

type TextReadResult =
  { ok: true; content: string } | { ok: false; error: string }

export type ManagedFileMutationObserver = (
  events: readonly CodeGraphFileEvent[],
  context?: ToolExecutionContext,
) => void | Promise<void>

async function isPdf(path: string): Promise<boolean> {
  try {
    const buf = Buffer.alloc(4)
    const fh = await open(path, 'r')
    await fh.read(buf, 0, 4, 0)
    await fh.close()
    return buf.equals(PDF_MAGIC)
  } catch {
    return false
  }
}

function throwIfReadAborted(signal?: AbortSignal | null): void {
  if (!signal?.aborted) return
  if (signal.reason instanceof Error) throw signal.reason
  throw new Error('file read cancelled')
}

async function readBoundedText(
  path: string,
  signal?: AbortSignal | null,
): Promise<TextReadResult> {
  throwIfReadAborted(signal)
  const handle = await open(path, 'r').catch(() => null)
  if (!handle) return { ok: false, error: '[ERR] unable to read file' }
  try {
    const chunks: Buffer[] = []
    let total = 0
    while (total <= MAX_TEXT_FILE_BYTES) {
      throwIfReadAborted(signal)
      const remaining = MAX_TEXT_FILE_BYTES + 1 - total
      const buffer = Buffer.allocUnsafe(
        Math.min(TEXT_READ_CHUNK_BYTES, remaining),
      )
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
      throwIfReadAborted(signal)
      if (bytesRead === 0) break
      chunks.push(buffer.subarray(0, bytesRead))
      total += bytesRead
      if (total > MAX_TEXT_FILE_BYTES) {
        return { ok: false, error: TEXT_FILE_TOO_LARGE_ERROR }
      }
    }
    return { ok: true, content: Buffer.concat(chunks, total).toString('utf8') }
  } catch {
    throwIfReadAborted(signal)
    return { ok: false, error: '[ERR] unable to read file' }
  } finally {
    await handle.close().catch(() => undefined)
  }
}

async function readSidecar(
  path: string,
  signal?: AbortSignal | null,
): Promise<TextReadResult | null> {
  try {
    const txt = path + '.txt'
    if (existsSync(txt)) return await readBoundedText(txt, signal)
  } catch {
    throwIfReadAborted(signal)
    /* ignore */
  }
  return null
}

// ── ReadFileTool ──

export class ReadFileTool extends Tool {
  override name = 'read_file'
  override description =
    '安全读取工作区内文本、PDF 或附件 sidecar 内容，支持 offset/limit 分页；输出格式为 行号|内容。' +
    '读取文件内容时优先使用它，不要用 run_command/cat/head/tail/sed 代替；大文件先读相关片段，必要时分页继续。'
  override parameters = toolParamsSchema(
    {
      path: S('文件路径'),
      offset: { type: 'integer', description: '起始行号（1-based）' },
      limit: { type: 'integer', description: '最大行数' },
    },
    ['path'],
  )
  override readOnly = true
  override evidencePolicy = 'eligible' as const
  override maxResultChars = 50_000

  private readonly workspace: string | null

  constructor(root: string) {
    super()
    this.workspace = root
  }

  override getPath(args: Record<string, unknown>): string | null {
    return String(args.path ?? '').trim() || null
  }

  async execute(
    args: Record<string, unknown>,
    ctx?: ToolExecutionContext,
  ): Promise<string> {
    const raw = String(args.path ?? '')
    const offset = Number(args.offset ?? 1) || 1
    const limit = Number(args.limit) || 2000
    const decision = workspacePolicyForTool(ctx, this.workspace).resolvePath(
      raw,
      'read',
    )
    if (!decision.allowed) return formatWorkspacePolicyError(decision)
    const p = decision.resolvedPath
    if (!existsSync(p)) return '[ERR] file not found'
    try {
      const s = await stat(p)
      if (s.isDirectory()) return '[ERR] path is a directory (use glob to list)'
    } catch {
      return '[ERR] cannot stat file'
    }

    // PDF
    if (await isPdf(p)) {
      throwIfReadAborted(ctx?.signal)
      const sidecar = await readSidecar(p, ctx?.signal)
      if (sidecar?.ok) return paginate(sidecar.content, offset, limit)
      if (sidecar && !sidecar.ok) return sidecar.error
      return '[PDF] (no text extraction available; check sidecar or use an external tool)'
    }

    const content = await readBoundedText(p, ctx?.signal)
    return content.ok ? paginate(content.content, offset, limit) : content.error
  }

  override mapResult(raw: string, _ctx: ToolExecutionContext): ToolResult {
    return raw.startsWith('[ERR]')
      ? errResult(raw, { meta: { tool: 'read_file' } })
      : okResult(raw, { meta: { tool: 'read_file' } })
  }
}

function paginate(content: string, offset: number, limit: number): string {
  const lines = content.split('\n')
  const start = Math.max(0, offset - 1)
  const end = Math.min(lines.length, start + limit)
  if (start >= lines.length)
    return `(offset ${offset} beyond file end — ${lines.length} lines total)`
  const out: string[] = []
  for (let i = start; i < end; i++) out.push(`${i + 1}\t${lines[i]!}`)
  return out.join('\n')
}

// ── WriteFileTool ──

export class WriteFileTool extends Tool {
  override name = 'write_file'
  override description =
    '仅用于创建新文件或整体替换文件内容；对已存在文件做增量修改（追加功能、改片段）必须用 edit_file，' +
    '禁止为了追加内容而全量重写整个文件——那会重复输出全部旧内容，既慢又浪费。' +
    '覆盖已有文件前应先用 read_file 查看现状；不要用 run_command/echo/heredoc 写文件；除非用户明确要求，不要主动创建文档或无关文件。'
  override parameters = toolParamsSchema(
    { path: S('目标路径'), content: S('文件内容') },
    ['path', 'content'],
  )
  override maxResultChars = 5000
  override evidencePolicy = 'eligible' as const
  override workspaceMutation = true

  private readonly workspace: string | null

  constructor(
    root: string,
    private readonly mutationObserver?: ManagedFileMutationObserver,
  ) {
    super()
    this.workspace = root
  }

  override getPath(args: Record<string, unknown>): string | null {
    return String(args.path ?? '').trim() || null
  }

  async execute(
    args: Record<string, unknown>,
    ctx?: ToolExecutionContext,
  ): Promise<string> {
    const raw = String(args.path ?? '')
    const content = String(args.content ?? '')
    const decision = workspacePolicyForTool(ctx, this.workspace).resolvePath(
      raw,
      'write',
    )
    if (!decision.allowed) return formatWorkspacePolicyError(decision)
    const p = decision.resolvedPath
    const overwrote = existsSync(p)
    throwIfToolAborted(ctx)
    await mkdir(dirname(p), { recursive: true })
    throwIfToolAborted(ctx)
    await fsWriteFile(p, content, 'utf8')
    await notifyManagedMutation(
      this.mutationObserver,
      [{ kind: overwrote ? 'modified' : 'created', path: p }],
      ctx,
    )
    const base = `Wrote ${content.length} bytes to ${raw}`
    // B2a：全量覆盖既有文件时提示改用增量编辑（2026-07-05 会话实测同一文件被全量重写 6 次）
    return overwrote
      ? `${base}\n注意：已整体覆盖既有文件；后续增量修改请改用 edit_file，不要再全量重写。`
      : base
  }

  override mapResult(raw: string, _ctx: ToolExecutionContext): ToolResult {
    return raw.startsWith('[ERR]')
      ? errResult(raw, { meta: { tool: 'write_file' } })
      : okResult(raw, { meta: { tool: 'write_file' } })
  }
}

// ── EditFileTool ──

export class EditFileTool extends Tool {
  override name = 'edit_file'
  override description =
    '对已有文件做局部文本替换——这是修改已存在文件的默认工具（追加功能、改片段、多轮迭代同一文件都用它）；编辑前应先用 read_file 理解目标片段。' +
    'read_file 输出为 行号|内容，old_text 只取竖线之后的原始文本并保留精确缩进，不要带上行号或竖线前缀；' +
    '若 old_text 匹配多处，需要提供更多上下文或设置 replace_all=true。不要用 run_command/sed/awk 代替此工具编辑文件；' +
    '失败后根据错误调整匹配范围，不要盲目重试。'
  override parameters = toolParamsSchema(
    {
      path: S('目标路径'),
      old_text: S('要替换的原文本'),
      new_text: S('替换后的文本'),
      replace_all: {
        type: 'boolean',
        description: '替换所有出现的 old_text（默认只替换第一个）',
      },
    },
    ['path', 'old_text', 'new_text'],
  )
  override evidencePolicy = 'eligible' as const
  override workspaceMutation = true

  private readonly workspace: string | null

  constructor(
    root: string,
    private readonly mutationObserver?: ManagedFileMutationObserver,
  ) {
    super()
    this.workspace = root
  }

  override getPath(args: Record<string, unknown>): string | null {
    return String(args.path ?? '').trim() || null
  }

  async execute(
    args: Record<string, unknown>,
    ctx?: ToolExecutionContext,
  ): Promise<string> {
    const raw = String(args.path ?? '')
    const oldText = String(args.old_text ?? '')
    const newText = String(args.new_text ?? '')
    const replaceAll = args.replace_all === true || args.replace_all === 'true'
    if (!oldText) return '[ERR] old_text must not be empty'
    const decision = workspacePolicyForTool(ctx, this.workspace).resolvePath(
      raw,
      'write',
    )
    if (!decision.allowed) return formatWorkspacePolicyError(decision)
    const p = decision.resolvedPath
    if (!existsSync(p)) return '[ERR] file not found'
    const read = await readBoundedText(p, ctx?.signal)
    if (!read.ok) return read.error
    const content = read.content

    // Matching order: exact → trimmed → whitespace-normalized source span.
    let next: string
    if (content.includes(oldText)) {
      if (!replaceAll && countOccurrences(content, oldText) > 1) {
        return '[ERR] old_text matches multiple locations — provide more context or set replace_all=true'
      }
      next = replaceLiteral(content, oldText, newText, replaceAll)
    } else {
      const trimmed = oldText.trim()
      if (!trimmed) return '[ERR] old_text not found in file'
      if (content.includes(trimmed)) {
        if (!replaceAll && countOccurrences(content, trimmed) > 1) {
          return '[ERR] trimmed match found but is not unique — provide more context'
        }
        next = replaceLiteral(content, trimmed, newText, replaceAll)
      } else {
        const pattern = whitespaceNormalizedPattern(trimmed)
        const matches = [...content.matchAll(pattern)]
        if (matches.length === 0) return '[ERR] old_text not found in file'
        if (!replaceAll && matches.length > 1) {
          return '[ERR] normalized match found but is not unique — provide more context or set replace_all=true'
        }
        if (replaceAll) {
          next = content.replace(pattern, () => newText)
        } else {
          const match = matches[0]!
          const start = match.index
          next =
            content.slice(0, start) +
            newText +
            content.slice(start + match[0].length)
        }
      }
    }
    if (next === content) return '[ERR] edit would not change file content'
    throwIfToolAborted(ctx)
    const result = await replaceFile(p, next, raw)
    await notifyManagedMutation(
      this.mutationObserver,
      [{ kind: 'modified', path: p }],
      ctx,
    )
    return result
  }

  override mapResult(raw: string, _ctx: ToolExecutionContext): ToolResult {
    return raw.startsWith('[ERR]')
      ? errResult(raw, { meta: { tool: 'edit_file' } })
      : okResult(raw, { meta: { tool: 'edit_file' } })
  }
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) throw new Error('countOccurrences needle must not be empty')
  let c = 0
  let pos = 0
  while ((pos = haystack.indexOf(needle, pos)) >= 0) {
    c++
    pos += needle.length
  }
  return c
}

function replaceLiteral(
  content: string,
  needle: string,
  replacement: string,
  replaceAll: boolean,
): string {
  if (replaceAll) return content.split(needle).join(replacement)
  const index = content.indexOf(needle)
  return (
    content.slice(0, index) + replacement + content.slice(index + needle.length)
  )
}

function whitespaceNormalizedPattern(value: string): RegExp {
  const escapedSegments = value
    .split(/\s+/)
    .map((segment) => segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  return new RegExp(escapedSegments.join('\\s+'), 'g')
}

// ── ApplyPatchTool ──

export class ApplyPatchTool extends Tool {
  override name = 'apply_patch'
  override description =
    '对单个工作区文本文件执行精确 patch。old_text 必须逐字存在且默认只能匹配一次；' +
    '需要替换全部精确匹配时显式设置 replace_all=true。不会执行模糊或空白归一化匹配。'
  override parameters = toolParamsSchema(
    {
      path: S('目标路径'),
      old_text: S('必须精确匹配的原文本'),
      new_text: S('替换后的文本'),
      replace_all: {
        type: 'boolean',
        description: '替换全部精确匹配（默认 false）',
      },
    },
    ['path', 'old_text', 'new_text'],
  )
  override evidencePolicy = 'eligible' as const
  override workspaceMutation = true

  constructor(
    private readonly workspace: string | null,
    private readonly mutationObserver?: ManagedFileMutationObserver,
  ) {
    super()
  }

  override getPath(args: Record<string, unknown>): string | null {
    return String(args.path ?? '').trim() || null
  }

  async execute(
    args: Record<string, unknown>,
    ctx?: ToolExecutionContext,
  ): Promise<string> {
    const raw = String(args.path ?? '')
    const oldText = String(args.old_text ?? '')
    const newText = String(args.new_text ?? '')
    const replaceAll = args.replace_all === true
    if (!oldText) return '[ERR] old_text must not be empty'
    const decision = workspacePolicyForTool(ctx, this.workspace).resolvePath(
      raw,
      'write',
    )
    if (!decision.allowed) return formatWorkspacePolicyError(decision)
    const path = decision.resolvedPath
    const info = await regularFileInfo(path)
    if (typeof info === 'string') return info
    const read = await readBoundedText(path, ctx?.signal)
    if (!read.ok) return read.error
    const content = read.content
    const matches = countOccurrences(content, oldText)
    if (!matches) return '[ERR] old_text not found in file'
    if (!replaceAll && matches !== 1)
      return '[ERR] old_text matches multiple locations — provide more context or set replace_all=true'
    const next = replaceAll
      ? content.replaceAll(oldText, newText)
      : content.replace(oldText, newText)
    throwIfToolAborted(ctx)
    await fsWriteFile(path, next, 'utf8')
    await notifyManagedMutation(
      this.mutationObserver,
      [{ kind: 'modified', path }],
      ctx,
    )
    return `Patched ${raw}`
  }

  override mapResult(raw: string, _ctx: ToolExecutionContext): ToolResult {
    return raw.startsWith('[ERR]')
      ? errResult(raw, { meta: { tool: this.name } })
      : okResult(raw, { meta: { tool: this.name } })
  }
}

// ── DeleteFileTool ──

export class DeleteFileTool extends Tool {
  override name = 'delete_file'
  override description =
    '删除一个工作区内的普通文件。拒绝目录和符号链接；目标明确后直接调用，权限层会按当前模式决定是否审批，不要先用普通文字重复确认。'
  override parameters = toolParamsSchema({ path: S('待删除文件路径') }, [
    'path',
  ])
  override evidencePolicy = 'eligible' as const
  override workspaceMutation = true

  constructor(
    private readonly workspace: string | null,
    private readonly mutationObserver?: ManagedFileMutationObserver,
  ) {
    super()
  }

  override getPath(args: Record<string, unknown>): string | null {
    return String(args.path ?? '').trim() || null
  }

  async execute(
    args: Record<string, unknown>,
    ctx?: ToolExecutionContext,
  ): Promise<string> {
    const raw = String(args.path ?? '')
    const decision = workspacePolicyForTool(ctx, this.workspace).resolvePath(
      raw,
      'write',
    )
    if (!decision.allowed) return formatWorkspacePolicyError(decision)
    const info = await regularFileInfo(decision.resolvedPath)
    if (typeof info === 'string') return info
    throwIfToolAborted(ctx)
    await unlink(decision.resolvedPath)
    await notifyManagedMutation(
      this.mutationObserver,
      [{ kind: 'removed', path: decision.resolvedPath }],
      ctx,
    )
    return `Deleted ${raw}`
  }

  override mapResult(raw: string, _ctx: ToolExecutionContext): ToolResult {
    return raw.startsWith('[ERR]')
      ? errResult(raw, { meta: { tool: this.name } })
      : okResult(raw, { meta: { tool: this.name } })
  }
}

// ── RenameFileTool ──

export class RenameFileTool extends Tool {
  override name = 'rename_file'
  override description =
    '把一个工作区内的普通文件移动到另一个工作区路径。拒绝符号链接、目录和覆盖已有目标；路径明确后直接调用，权限层会按当前模式决定是否审批。'
  override parameters = toolParamsSchema(
    {
      source: S('原文件路径'),
      destination: S('目标文件路径'),
    },
    ['source', 'destination'],
  )
  override evidencePolicy = 'eligible' as const
  override workspaceMutation = true

  constructor(
    private readonly workspace: string | null,
    private readonly mutationObserver?: ManagedFileMutationObserver,
  ) {
    super()
  }

  override getPath(args: Record<string, unknown>): string | null {
    return String(args.source ?? '').trim() || null
  }

  override getPaths(args: Record<string, unknown>): string[] {
    return [
      String(args.source ?? '').trim(),
      String(args.destination ?? '').trim(),
    ].filter(Boolean)
  }

  async execute(
    args: Record<string, unknown>,
    ctx?: ToolExecutionContext,
  ): Promise<string> {
    const sourceRaw = String(args.source ?? '')
    const destinationRaw = String(args.destination ?? '')
    const policy = workspacePolicyForTool(ctx, this.workspace)
    const source = policy.resolvePath(sourceRaw, 'write')
    if (!source.allowed) return formatWorkspacePolicyError(source)
    const destination = policy.resolvePath(destinationRaw, 'write')
    if (!destination.allowed) return formatWorkspacePolicyError(destination)
    const sourceInfo = await regularFileInfo(source.resolvedPath)
    if (typeof sourceInfo === 'string') return sourceInfo
    if (existsSync(destination.resolvedPath))
      return '[ERR] rename destination already exists'
    throwIfToolAborted(ctx)
    await mkdir(dirname(destination.resolvedPath), { recursive: true })
    throwIfToolAborted(ctx)
    await fsRename(source.resolvedPath, destination.resolvedPath)
    await notifyManagedMutation(
      this.mutationObserver,
      [
        {
          kind: 'renamed',
          path: source.resolvedPath,
          nextPath: destination.resolvedPath,
        },
      ],
      ctx,
    )
    return `Renamed ${sourceRaw} to ${destinationRaw}`
  }

  override mapResult(raw: string, _ctx: ToolExecutionContext): ToolResult {
    return raw.startsWith('[ERR]')
      ? errResult(raw, { meta: { tool: this.name } })
      : okResult(raw, { meta: { tool: this.name } })
  }
}

async function regularFileInfo(
  path: string,
): Promise<Awaited<ReturnType<typeof lstat>> | string> {
  const info = await lstat(path).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  })
  if (!info) return '[ERR] file not found'
  if (info.isSymbolicLink()) return '[ERR] symbolic links are not supported'
  if (!info.isFile()) return '[ERR] path is not a regular file'
  return info
}

async function replaceFile(
  p: string,
  newContent: string,
  label: string,
): Promise<string> {
  await fsWriteFile(p, newContent, 'utf8')
  return `Edited ${label}`
}

function throwIfToolAborted(context?: ToolExecutionContext): void {
  const signal = context?.signal
  if (!signal?.aborted) return
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException('The operation was aborted', 'AbortError')
}

async function notifyManagedMutation(
  observer: ManagedFileMutationObserver | undefined,
  events: readonly CodeGraphFileEvent[],
  context?: ToolExecutionContext,
): Promise<void> {
  if (!observer) return
  await Promise.resolve(observer(events, context)).catch(() => undefined)
}
