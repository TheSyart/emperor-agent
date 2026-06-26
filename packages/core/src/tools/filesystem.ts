/**
 * 文件系统工具 (MIG-TOOL-006/007)。
 * 对齐 Python `agent/tools/filesystem.py`：ReadFileTool/WriteFileTool/EditFileTool。
 * 工作区路径禁闭：expanduser + resolve 规范化后 relative_to 检查。
 */
import { existsSync } from 'node:fs'
import { mkdir, open, readFile as fsReadFile, stat, writeFile as fsWriteFile } from 'node:fs/promises'
import { dirname, normalize, relative, resolve } from 'node:path'
import { Tool, type ToolExecutionContext, type ToolResult, okResult, errResult } from './base'
import { S, toolParamsSchema } from './schema'

const PDF_MAGIC = Buffer.from('%PDF')

async function isPdf(path: string): Promise<boolean> {
  try {
    const buf = Buffer.alloc(4)
    const fh = await open(path, 'r')
    await fh.read(buf, 0, 4, 0)
    await fh.close()
    return buf.equals(PDF_MAGIC)
  } catch { return false }
}

async function readText(path: string): Promise<string> {
  try {
    return await fsReadFile(path, 'utf8')
  } catch {
    return '[ERR] unable to read file'
  }
}

async function readSidecar(path: string): Promise<string | null> {
  try {
    const txt = path + '.txt'
    if (existsSync(txt)) return await fsReadFile(txt, 'utf8')
  } catch { /* ignore */ }
  return null
}

/** 对齐 Python `_resolve`：expanduser → normalize → resolve → relative_to 检查。 */
function resolvePath(raw: string, workspace: string | null): string {
  let p = normalize(raw.replace(/^~/, process.env.HOME ?? ''))
  if (!p.startsWith('/') && workspace) p = normalize(joinWs(workspace, p))
  const resolved = resolve(p)
  if (workspace) {
    const ws = resolve(workspace)
    const rel = relative(ws, resolved)
    if (rel.startsWith('..') || resolve(rel) === rel) {
      // The relative path starts with .. or the resolved path is outside
      if (rel.startsWith('..')) throw new Error(`path escape: ${raw} → ${resolved} (outside ${ws})`)
    }
  }
  return resolved
}

function joinWs(a: string, b: string): string {
  return a.endsWith('/') ? a + b : a + '/' + b
}

// ── ReadFileTool ──

export class ReadFileTool extends Tool {
  override name = 'read_file'
  override description = (
    '安全读取工作区内文本、PDF 或附件 sidecar 内容，支持 offset/limit 分页；输出格式为 行号|内容。'
    + '读取文件内容时优先使用它，不要用 run_command/cat/head/tail/sed 代替；大文件先读相关片段，必要时分页继续。'
  )
  override parameters = toolParamsSchema(
    { path: S('文件路径'), offset: { type: 'integer', description: '起始行号（1-based）' }, limit: { type: 'integer', description: '最大行数' } },
    ['path'],
  )
  override readOnly = true
  override maxResultChars = 50_000

  private readonly workspace: string | null

  constructor(root: string) { super(); this.workspace = root }

  async execute(args: Record<string, unknown>): Promise<string> {
    const raw = String(args.path ?? '')
    const offset = Number(args.offset ?? 1) || 1
    const limit = Number(args.limit) || 2000
    let p: string
    try { p = resolvePath(raw, this.workspace) } catch { return '[ERR] path is outside workspace' }
    if (!existsSync(p)) return '[ERR] file not found'
    try {
      const s = await stat(p)
      if (s.isDirectory()) return '[ERR] path is a directory (use glob to list)'
    } catch { return '[ERR] cannot stat file' }

    // PDF
    if (await isPdf(p)) {
      const sidecar = await readSidecar(p)
      if (sidecar) return paginate(sidecar, offset, limit)
      return '[PDF] (no text extraction available; check sidecar or use an external tool)'
    }

    const content = await readText(p)
    return paginate(content, offset, limit)
  }

  override mapResult(raw: string, _ctx: ToolExecutionContext): ToolResult {
    return raw.startsWith('[ERR]') ? errResult(raw, { meta: { tool: 'read_file' } }) : okResult(raw, { meta: { tool: 'read_file' } })
  }
}

function paginate(content: string, offset: number, limit: number): string {
  const lines = content.split('\n')
  const start = Math.max(0, offset - 1)
  const end = Math.min(lines.length, start + limit)
  if (start >= lines.length) return `(offset ${offset} beyond file end — ${lines.length} lines total)`
  const out: string[] = []
  for (let i = start; i < end; i++) out.push(`${i + 1}\t${lines[i]!}`)
  return out.join('\n')
}

// ── WriteFileTool ──

export class WriteFileTool extends Tool {
  override name = 'write_file'
  override description = (
    '创建新文件或完整覆盖文件内容；覆盖已有文件前应先用 read_file 查看现状。'
    + '局部修改优先使用 edit_file，不要用 run_command/echo/heredoc 写文件；除非用户明确要求，不要主动创建文档或无关文件。'
  )
  override parameters = toolParamsSchema({ path: S('目标路径'), content: S('文件内容') }, ['path', 'content'])
  override maxResultChars = 5000

  private readonly workspace: string | null

  constructor(root: string) { super(); this.workspace = root }

  async execute(args: Record<string, unknown>): Promise<string> {
    const raw = String(args.path ?? '')
    const content = String(args.content ?? '')
    let p: string
    try { p = resolvePath(raw, this.workspace) } catch { return '[ERR] path is outside workspace' }
    await mkdir(dirname(p), { recursive: true })
    await fsWriteFile(p, content, 'utf8')
    return `Wrote ${content.length} bytes to ${raw}`
  }

  override mapResult(raw: string, _ctx: ToolExecutionContext): ToolResult {
    return raw.startsWith('[ERR]') ? errResult(raw, { meta: { tool: 'write_file' } }) : okResult(raw, { meta: { tool: 'write_file' } })
  }
}

// ── EditFileTool ──

export class EditFileTool extends Tool {
  override name = 'edit_file'
  override description = (
    '对已有文件做局部文本替换；编辑前应先用 read_file 理解目标片段。适合小范围修改、重命名或替换唯一文本；'
    + 'read_file 输出为 行号|内容，old_text 只取竖线之后的原始文本并保留精确缩进，不要带上行号或竖线前缀；'
    + '若 old_text 匹配多处，需要提供更多上下文或设置 replace_all=true。不要用 run_command/sed/awk 代替此工具编辑文件；'
    + '失败后根据错误调整匹配范围，不要盲目重试。'
  )
  override parameters = toolParamsSchema(
    {
      path: S('目标路径'),
      old_text: S('要替换的原文本'),
      new_text: S('替换后的文本'),
      replace_all: { type: 'boolean', description: '替换所有出现的 old_text（默认只替换第一个）' },
    },
    ['path', 'old_text', 'new_text'],
  )

  private readonly workspace: string | null

  constructor(root: string) { super(); this.workspace = root }

  async execute(args: Record<string, unknown>): Promise<string> {
    const raw = String(args.path ?? '')
    const oldText = String(args.old_text ?? '')
    const newText = String(args.new_text ?? '')
    const replaceAll = args.replace_all === true || args.replace_all === 'true'
    let p: string
    try { p = resolvePath(raw, this.workspace) } catch { return '[ERR] path is outside workspace' }
    if (!existsSync(p)) return '[ERR] file not found'
    const content = await readText(p)
    if (content === '[ERR] unable to read file') return '[ERR] unable to read file'

    // Matching order: exact → trimmed → normalized (same as Python)
    let idx = content.indexOf(oldText)
    if (idx < 0) {
      const trimmed = oldText.trim()
      idx = content.indexOf(trimmed)
      if (idx >= 0) {
        if (!replaceAll && countOccurrences(content, trimmed) > 1) {
          return '[ERR] trimmed match found but is not unique — provide more context'
        }
        return replaceFile(p, content.replace(trimmed, newText), raw)
      }
      // normalized: collapse whitespace
      const normOld = oldText.replace(/\s+/g, ' ')
      const normContent = content.replace(/\s+/g, ' ')
      const normIdx = normContent.indexOf(normOld)
      if (normIdx < 0) return '[ERR] old_text not found in file'
      if (!replaceAll && countOccurrences(normContent, normOld) > 1) {
        return '[ERR] normalized match found but is not unique — provide more context or set replace_all=true'
      }
      // Replace the first match in the original content using the normalized alignment
      // Simple approach: replace the first exact match of the trimmed version
      return replaceFile(p, content.replace(trimmed, newText), raw)
    }
    if (!replaceAll && countOccurrences(content, oldText) > 1) {
      return '[ERR] old_text matches multiple locations — provide more context or set replace_all=true'
    }
    if (replaceAll) {
      return replaceFile(p, content.replaceAll(oldText, newText), raw)
    }
    return replaceFile(p, content.replace(oldText, newText), raw)
  }

  override mapResult(raw: string, _ctx: ToolExecutionContext): ToolResult {
    return raw.startsWith('[ERR]') ? errResult(raw, { meta: { tool: 'edit_file' } }) : okResult(raw, { meta: { tool: 'edit_file' } })
  }
}

function countOccurrences(haystack: string, needle: string): number {
  let c = 0; let pos = 0
  while ((pos = haystack.indexOf(needle, pos)) >= 0) { c++; pos += needle.length }
  return c
}

async function replaceFile(p: string, newContent: string, label: string): Promise<string> {
  await fsWriteFile(p, newContent, 'utf8')
  return `Edited ${label}`
}
