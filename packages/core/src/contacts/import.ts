/**
 * 导入 (GRP-04): a Claude Code `agents/*.md` — or any prompt file — as an
 * unsaved draft for the editor. Only the one file the user picked is read
 * (never a scan of `~/.claude`), at most 64 KB; nothing is saved until the
 * user saves in the editor.
 *
 * frontmatter `name` → name, `description` → intro (cut to 60), `model` → a
 * hint only, `tools` → Emperor tools by the table below (anything else is
 * listed as not recognized); the body → the playbook. A broken frontmatter
 * puts the whole text into the playbook and says so. The file's words are
 * data: the tools come from the table, never from what the text asks for.
 */
import { stat, readFile } from 'node:fs/promises'
import { basename, extname, isAbsolute } from 'node:path'
import { parse as parseYaml } from 'yaml'
import {
  ContactImportTooLargeError,
  ContactImportUnreadableError,
} from './errors'
import {
  CONTACT_LIMITS,
  type ContactDraft,
  type ContactPermission,
  type ContactTools,
  type ToolPreset,
} from './types'
import { charCount, permissionAllowed } from './validate'

export const AGENT_FILE_MAX_BYTES = 64 * 1024

/** Claude Code's tool names and the Emperor tools they become. */
export const CLAUDE_CODE_TOOL_MAP: Readonly<Record<string, string>> =
  Object.freeze({
    Read: 'read',
    Grep: 'grep',
    Glob: 'glob',
    Bash: 'bash',
    Edit: 'edit',
    Write: 'write',
    WebSearch: 'web_search',
    WebFetch: 'web_fetch',
  })

const READ_TOOLS = ['glob', 'grep', 'read']
/** The tools that make each preset what it is (its small extras aside). */
const PRESET_CORE: ReadonlyArray<[Exclude<ToolPreset, 'custom'>, string[]]> = [
  ['read_only', READ_TOOLS],
  ['research', [...READ_TOOLS, 'web_fetch', 'web_search']],
  ['writer', [...READ_TOOLS, 'edit', 'web_fetch', 'web_search', 'write']],
  [
    'engineer',
    [...READ_TOOLS, 'bash', 'edit', 'web_fetch', 'web_search', 'write'],
  ],
]
/** Tools that change files: the contact needs to write in its workspace. */
const WRITING_TOOLS = new Set(['bash', 'edit', 'write'])

export interface AgentImportContext {
  /** Every tool name the registry has. */
  registered: Iterable<string>
  /** 设置 › 常规 › 会话 › 新会话的权限. */
  globalPermission: string
}

export interface AgentFileImport {
  draft: ContactDraft
  /** The Emperor tools the file's tools map to, sorted. */
  tools: string[]
  /** The file's tools that have no Emperor tool, as the file names them. */
  unknownTools: string[]
  /** The file's `model`: shown as a hint, never used. */
  modelHint: string | null
  /** What the user should know about the import (Chinese). */
  notes: string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The first `limit` characters (a Chinese character is one). */
function cut(text: string, limit: number): string {
  return Array.from(text).slice(0, limit).join('')
}

/** One line: control characters and runs of blank space become one space. */
function oneLine(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim()
}

/** A name a contact may have: one line, no @ (group chat @-mentions names). */
function contactName(raw: string): string {
  return cut(oneLine(raw.replace(/@/g, '')), CONTACT_LIMITS.name).trim()
}

function fileStem(fileName: string): string {
  const name = basename(fileName)
  return name.slice(0, name.length - extname(name).length) || name
}

/** `tools: Read, Grep` or a YAML list; names as written, once each. */
function toolList(value: unknown): string[] {
  const items = Array.isArray(value)
    ? value.map((item) => String(item))
    : typeof value === 'string'
      ? value.split(/[,\s]+/)
      : []
  return [...new Set(items.map((item) => item.trim()).filter((item) => item))]
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length && left.every((item) => right.includes(item))
  )
}

/** The import without a frontmatter to go by: the whole text is the playbook. */
function wholeText(
  text: string,
  fileName: string,
  note: string,
): AgentFileImport {
  const notes = [note]
  const playbook = playbookOf(text, notes)
  notes.push('没有写工具，先按只读导入，需要时在「能力」里放开。')
  return {
    draft: draftOf(
      contactName(fileStem(fileName)),
      '',
      playbook,
      readOnlyTools(),
      'read_only',
    ),
    tools: [],
    unknownTools: [],
    modelHint: null,
    notes,
  }
}

function playbookOf(text: string, notes: string[]): string {
  const body = text.trim()
  if (charCount(body) <= CONTACT_LIMITS.playbook) return body
  notes.push(
    `正文超过 ${CONTACT_LIMITS.playbook} 字，只导入了前 ${CONTACT_LIMITS.playbook} 字。`,
  )
  return cut(body, CONTACT_LIMITS.playbook)
}

function readOnlyTools(): ContactTools {
  return { preset: 'read_only' }
}

function draftOf(
  name: string,
  intro: string,
  playbook: string,
  tools: ContactTools,
  permission: Exclude<ContactPermission, 'inherit'>,
): ContactDraft {
  return {
    name,
    intro,
    domains: [],
    role: {
      mission: '',
      deliverable: '',
      playbook,
      boundaries: '',
      knowledge: [],
    },
    capabilities: { model: 'inherit', tools, permission },
    groupHabit: { speak: 'relevant', length: 'brief' },
  }
}

/** The contents of one agent or prompt file as a draft (no file access). */
export function parseAgentFile(
  source: string,
  fileName: string,
  context: AgentImportContext,
): AgentFileImport {
  const text = source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  if (!text.startsWith('---\n'))
    return wholeText(
      text,
      fileName,
      '没有 frontmatter，整个文件作为工作方法导入。',
    )
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/.exec(text)
  let data: unknown = null
  try {
    data = match ? parseYaml(match[1]!) : null
  } catch {
    data = null
  }
  if (!match || !isRecord(data))
    return wholeText(
      text,
      fileName,
      'frontmatter 格式不对，整个文件作为工作方法导入，请检查名字、简介和工具。',
    )

  const notes: string[] = []
  const name =
    (typeof data.name === 'string' ? contactName(data.name) : '') ||
    contactName(fileStem(fileName))
  const intro =
    typeof data.description === 'string'
      ? cut(oneLine(data.description), CONTACT_LIMITS.intro)
      : ''
  const modelHint =
    typeof data.model === 'string' && data.model.trim()
      ? cut(oneLine(data.model), 64)
      : null
  if (modelHint)
    notes.push(
      `原文件写的模型是「${modelHint}」，只作参考；联系人先用默认模型，可以在「能力」里换。`,
    )

  const written = toolList(data.tools)
  const mapped = [
    ...new Set(
      written
        .map((tool) => CLAUDE_CODE_TOOL_MAP[tool])
        .filter((tool): tool is string => tool !== undefined),
    ),
  ].sort()
  const unknownTools = written.filter(
    (tool) => CLAUDE_CODE_TOOL_MAP[tool] === undefined,
  )
  if (unknownTools.length)
    notes.push(`这些工具没有对应的，没有导入：${unknownTools.join('、')}。`)

  let tools: ContactTools = readOnlyTools()
  if (mapped.length === 0)
    notes.push(
      written.length
        ? '没有认得的工具，先按只读导入，需要时在「能力」里放开。'
        : '原文件没写工具（在 Claude Code 里等于全部工具），先按只读导入，需要时在「能力」里放开。',
    )
  else {
    const preset = PRESET_CORE.find(([, core]) => sameSet(core, mapped))?.[0]
    if (preset) tools = { preset }
    else {
      const registered = new Set(context.registered)
      const missing = mapped.filter((tool) => !registered.has(tool))
      if (missing.length)
        notes.push(
          `这些工具在这台电脑上用不了，没有导入：${missing.join('、')}。`,
        )
      const allow = mapped.filter((tool) => registered.has(tool))
      tools = allow.length ? { preset: 'custom', allow } : readOnlyTools()
    }
  }

  let permission: Exclude<ContactPermission, 'inherit'> = 'read_only'
  if (mapped.some((tool) => WRITING_TOOLS.has(tool))) {
    if (permissionAllowed('workspace_write', context.globalPermission))
      permission = 'workspace_write'
    else
      notes.push(
        '新会话的权限是只读（「设置 › 常规」），联系人先按只读导入，改文件的工具用不了。',
      )
  }

  return {
    draft: draftOf(
      name,
      intro,
      playbookOf(match[2]!, notes),
      tools,
      permission,
    ),
    tools: mapped,
    unknownTools,
    modelHint,
    notes,
  }
}

export interface AgentImportOptions extends AgentImportContext {
  /** Reads the picked file as text (tests watch it). */
  readText?: (path: string) => Promise<string>
}

/** `contacts.importAgentFile`: the one file at `path`, as a draft. */
export async function importAgentFile(
  path: string,
  options: AgentImportOptions,
): Promise<AgentFileImport> {
  if (typeof path !== 'string' || !isAbsolute(path))
    throw new ContactImportUnreadableError('要选一个文件')
  let info: Awaited<ReturnType<typeof stat>>
  try {
    info = await stat(path)
  } catch {
    throw new ContactImportUnreadableError(`读不到这个文件：${path}`)
  }
  if (!info.isFile())
    throw new ContactImportUnreadableError(`不是文件：${path}`)
  if (info.size > AGENT_FILE_MAX_BYTES)
    throw new ContactImportTooLargeError(info.size)
  const read = options.readText ?? ((file: string) => readFile(file, 'utf8'))
  let text: string
  try {
    text = await read(path)
  } catch {
    throw new ContactImportUnreadableError(`读不到这个文件：${path}`)
  }
  // It may have grown since it was measured.
  const bytes = Buffer.byteLength(text)
  if (bytes > AGENT_FILE_MAX_BYTES) throw new ContactImportTooLargeError(bytes)
  if (text.includes('\u0000') || text.includes('\uFFFD'))
    throw new ContactImportUnreadableError(`不是文本文件：${path}`)
  return parseAgentFile(text, path, options)
}
