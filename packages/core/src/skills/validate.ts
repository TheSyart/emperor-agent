/**
 * Relaxed Skill validation shared by the loader, the Skill library, import,
 * and the `skill_manage` tool.
 *
 * - Only `SKILL.md` and the files it references by relative path are checked
 *   for content; the rest of the folder is only scanned for unsafe links.
 * - Symbolic links are allowed when they resolve inside the Skill folder;
 *   absolute links and links that escape the folder are errors.
 * - Dependency and VCS folders (`node_modules`, `.venv`, `venv`, `.git`,
 *   `__pycache__`) are neither traversed nor counted.
 * - The Skill name is the frontmatter `name`; a different folder name is a
 *   warning. YAML is parsed leniently (duplicate keys: last wins) and the
 *   leniency is reported as warnings.
 */

import {
  existsSync,
  lstatSync,
  opendirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
} from 'node:fs'
import {
  dirname,
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
  sep,
} from 'node:path'
import { parseDocument } from 'yaml'
import { skillNameError } from './name'

/** Folders never traversed, counted, or copied. */
export const SKIPPED_SKILL_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  '.venv',
  'venv',
  '.git',
  '__pycache__',
])

export const SKILL_FILE = 'SKILL.md'
export const SKILL_DESCRIPTION_MAX_LENGTH = 1_024
const MAX_SKILL_FILE_BYTES = 5 * 1024 * 1024
const MAX_REFERENCED_FILE_BYTES = 20 * 1024 * 1024
const MAX_SCAN_ENTRIES = 5_000
const MAX_SCAN_DEPTH = 32
const MAX_REFERENCES = 200

export interface ParsedSkillFrontmatter {
  /** Whether the file starts with a closed `---` frontmatter block. */
  present: boolean
  data: Record<string, unknown>
  body: string
  errors: string[]
  warnings: string[]
}

export interface SkillContentCheck {
  /** Frontmatter `name` ('' when missing). */
  name: string
  description: string
  frontmatter: Record<string, unknown>
  body: string
  errors: string[]
  warnings: string[]
}

export interface SkillFolderCheck extends SkillContentCheck {
  valid: boolean
  root: string
  skillFile: string
  content: string
  /** Relative paths referenced by SKILL.md that exist inside the folder. */
  references: string[]
}

/** Parse SKILL.md frontmatter leniently; never throws. */
export function parseSkillFrontmatter(content: string): ParsedSkillFrontmatter {
  const normalized = String(content ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
  const lines = normalized.split('\n')
  const fence = /^---[ \t]*$/
  if (!fence.test(lines[0] ?? ''))
    return {
      present: false,
      data: {},
      body: normalized,
      errors: ['SKILL.md must start with YAML frontmatter (---)'],
      warnings: [],
    }
  const end = lines.findIndex((line, index) => index > 0 && fence.test(line))
  if (end < 0)
    return {
      present: false,
      data: {},
      body: normalized,
      errors: ['SKILL.md frontmatter is not closed (missing ---)'],
      warnings: [],
    }
  const parsed = parseYamlLeniently(lines.slice(1, end).join('\n'))
  return { present: true, body: lines.slice(end + 1).join('\n'), ...parsed }
}

function parseYamlLeniently(text: string): {
  data: Record<string, unknown>
  errors: string[]
  warnings: string[]
} {
  const strict = parseDocument(text, {
    prettyErrors: false,
    strict: true,
    uniqueKeys: true,
  })
  if (strict.errors.length === 0) return asMapping(strict.toJS())
  const duplicatesOnly = strict.errors.every(
    (error) => error.code === 'DUPLICATE_KEY',
  )
  const lenient = parseDocument(text, {
    prettyErrors: false,
    strict: false,
    uniqueKeys: false,
  })
  if (lenient.errors.length === 0) {
    const result = asMapping(lenient.toJS())
    const duplicates = duplicateTopLevelKeys(text)
    result.warnings.push(
      duplicatesOnly
        ? `Duplicate frontmatter key${duplicates.length === 1 ? '' : 's'}${duplicates.length ? ` (${duplicates.join(', ')})` : ''}: the last value wins`
        : `Frontmatter YAML is not strictly valid (${firstLine(strict.errors[0]?.message)}); parsed leniently`,
    )
    return result
  }
  const simple = simpleKeyValues(text)
  if (typeof simple.name === 'string' || typeof simple.description === 'string')
    return {
      data: simple,
      errors: [],
      warnings: [
        `Frontmatter YAML could not be parsed (${firstLine(lenient.errors[0]?.message)}); read top-level "key: value" lines instead`,
      ],
    }
  return {
    data: {},
    errors: [
      `Invalid YAML frontmatter: ${firstLine(lenient.errors[0]?.message)}`,
    ],
    warnings: [],
  }
}

function asMapping(value: unknown): {
  data: Record<string, unknown>
  errors: string[]
  warnings: string[]
} {
  if (value === null || value === undefined)
    return { data: {}, errors: [], warnings: [] }
  if (!isRecord(value))
    return {
      data: {},
      errors: ['YAML frontmatter must be a mapping of keys to values'],
      warnings: [],
    }
  return { data: value, errors: [], warnings: [] }
}

function duplicateTopLevelKeys(text: string): string[] {
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const line of text.split('\n')) {
    const key = /^([A-Za-z0-9_.-]+)\s*:/.exec(line)?.[1]
    if (key === undefined) continue
    if (seen.has(key)) duplicates.add(key)
    seen.add(key)
  }
  return [...duplicates]
}

/** Fallback for broken YAML: top-level `key: value` lines as strings. */
function simpleKeyValues(text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const line of text.split('\n')) {
    const match = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line)
    if (match === null) continue
    out[match[1]!] = unquote(match[2]!.trim())
  }
  return out
}

function unquote(value: string): string {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  )
    return value.slice(1, -1)
  return value
}

function firstLine(message: string | undefined): string {
  return String(message ?? 'unknown error')
    .split('\n')[0]!
    .trim()
}

/** Check SKILL.md text: frontmatter, name, and description. */
export function checkSkillContent(
  content: string,
  opts: { folderName?: string | null } = {},
): SkillContentCheck {
  const parsed = parseSkillFrontmatter(content)
  const errors = [...parsed.errors]
  const warnings = [...parsed.warnings]
  const name = stringValue(parsed.data.name)
  const description = stringValue(parsed.data.description)
  if (parsed.present) {
    if (!name) errors.push('Frontmatter field "name" is required')
    else {
      const nameError = skillNameError(name)
      if (nameError) errors.push(`${nameError} (got "${name}")`)
    }
    if (!description) errors.push('Frontmatter field "description" is required')
    else if (description.length > SKILL_DESCRIPTION_MAX_LENGTH)
      warnings.push(
        `Frontmatter description is longer than ${SKILL_DESCRIPTION_MAX_LENGTH} characters; the catalog shows a shortened version`,
      )
  }
  const folderName = String(opts.folderName ?? '').trim()
  if (name && folderName && folderName !== name)
    warnings.push(
      `Folder name "${folderName}" differs from frontmatter name "${name}"; the Skill is named "${name}"`,
    )
  return {
    name,
    description,
    frontmatter: parsed.data,
    body: parsed.body,
    errors,
    warnings,
  }
}

/** Validate a Skill folder (`root/SKILL.md` plus the files it references). */
export function checkSkillFolder(
  root: string,
  opts: { folderName?: string | null } = {},
): SkillFolderCheck {
  const folder = resolve(root)
  const skillFile = join(folder, SKILL_FILE)
  const empty = (errors: string[]): SkillFolderCheck => ({
    valid: false,
    root: folder,
    skillFile,
    content: '',
    name: '',
    description: '',
    frontmatter: {},
    body: '',
    references: [],
    errors,
    warnings: [],
  })
  let rootStat
  try {
    rootStat = lstatSync(folder)
  } catch {
    return empty(['Skill folder does not exist'])
  }
  if (rootStat.isSymbolicLink())
    return empty([
      'Skill folder is a symbolic link; only links inside a Skill folder are allowed',
    ])
  if (!rootStat.isDirectory()) return empty(['Skill path is not a folder'])
  const realRoot = realpathSync(folder)

  const fileError = skillFileProblem(folder, realRoot, skillFile)
  if (fileError) return empty([fileError])
  let content: string
  try {
    content = readFileSync(skillFile, 'utf8')
  } catch (error) {
    return empty([`SKILL.md cannot be read: ${errorMessage(error)}`])
  }
  const check = checkSkillContent(content, opts)
  const errors = [...check.errors]
  const warnings = [...check.warnings]
  const scan = scanFolderLinks(folder, realRoot)
  errors.push(...scan.errors)
  warnings.push(...scan.warnings)
  const references: string[] = []
  for (const ref of referencedPaths(check.body)) {
    const problem = referenceProblem(folder, realRoot, ref)
    if (problem === null) references.push(ref)
    else if (problem.kind === 'error') errors.push(problem.message)
    else warnings.push(problem.message)
  }
  return {
    ...check,
    valid: errors.length === 0,
    root: folder,
    skillFile,
    content,
    references,
    errors: unique(errors),
    warnings: unique(warnings),
  }
}

function skillFileProblem(
  folder: string,
  realRoot: string,
  skillFile: string,
): string {
  let stat
  try {
    stat = lstatSync(skillFile)
  } catch {
    return 'SKILL.md is missing'
  }
  if (stat.isSymbolicLink()) {
    const link = linkProblem(folder, realRoot, skillFile)
    if (link) return `SKILL.md: ${link}`
    try {
      stat = statSync(skillFile)
    } catch {
      return 'SKILL.md is a broken symbolic link'
    }
  }
  if (!stat.isFile()) return 'SKILL.md must be a regular file'
  if (stat.size > MAX_SKILL_FILE_BYTES) return 'SKILL.md exceeds 5 MiB'
  return ''
}

/** Why a symbolic link is unsafe ('' when it resolves inside the folder). */
function linkProblem(folder: string, realRoot: string, path: string): string {
  let target: string
  try {
    target = readlinkSync(path)
  } catch (error) {
    return `symbolic link cannot be read: ${errorMessage(error)}`
  }
  if (isAbsolute(target) || /^[A-Za-z]:[\\/]/.test(target))
    return 'symbolic link uses an absolute target'
  if (!isPathInside(folder, resolve(dirname(path), target)))
    return 'symbolic link points outside the Skill folder'
  let real: string
  try {
    real = realpathSync(path)
  } catch {
    return ''
  }
  return isPathInside(realRoot, real)
    ? ''
    : 'symbolic link resolves outside the Skill folder'
}

function scanFolderLinks(
  folder: string,
  realRoot: string,
): { errors: string[]; warnings: string[] } {
  const errors: string[] = []
  const warnings: string[] = []
  let entries = 0
  let truncated = false
  const walk = (directory: string, depth: number): void => {
    if (truncated) return
    if (depth > MAX_SCAN_DEPTH) {
      warnings.push(
        `Skill folder is nested deeper than ${MAX_SCAN_DEPTH} levels; deeper files were not scanned`,
      )
      return
    }
    for (const entry of directoryEntries(directory)) {
      entries += 1
      if (entries > MAX_SCAN_ENTRIES) {
        truncated = true
        warnings.push(
          `Skill folder has more than ${MAX_SCAN_ENTRIES} entries; the rest was not scanned`,
        )
        return
      }
      const path = join(directory, entry)
      const rel = toPosix(relative(folder, path))
      let stat
      try {
        stat = lstatSync(path)
      } catch {
        continue
      }
      if (stat.isSymbolicLink()) {
        const problem = linkProblem(folder, realRoot, path)
        if (problem) errors.push(`${capitalize(problem)}: ${rel}`)
        else if (!existsSync(path))
          warnings.push(`Symbolic link is broken: ${rel}`)
        continue
      }
      if (stat.isDirectory()) {
        if (!SKIPPED_SKILL_DIRS.has(entry)) walk(path, depth + 1)
        continue
      }
      if (!stat.isFile()) warnings.push(`Special file is ignored: ${rel}`)
    }
  }
  walk(folder, 0)
  return { errors, warnings }
}

function directoryEntries(directory: string): string[] {
  const out: string[] = []
  let handle
  try {
    handle = opendirSync(directory)
  } catch {
    return out
  }
  try {
    for (;;) {
      const entry = handle.readSync()
      if (!entry) break
      out.push(entry.name)
      if (out.length > MAX_SCAN_ENTRIES) break
    }
  } finally {
    handle.closeSync()
  }
  return out.sort()
}

/** Relative file paths SKILL.md references through Markdown links and images. */
export function referencedPaths(body: string): string[] {
  const out = new Set<string>()
  const add = (raw: string): void => {
    if (out.size >= MAX_REFERENCES) return
    let value = raw.trim().replace(/^<|>$/g, '')
    if (!value) return
    if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return
    if (/^[#/~\\]/.test(value) || value.includes('{{') || value.includes('${'))
      return
    if (/[*?[\]]/.test(value)) return
    value = value.split('#')[0]!.split('?')[0]!
    try {
      value = decodeURI(value)
    } catch {
      // keep the raw value
    }
    const normalized = posix.normalize(value.replace(/\\/g, '/'))
    if (!normalized || normalized === '.' || normalized === './') return
    out.add(normalized.replace(/^\.\//, '').replace(/\/$/, ''))
  }
  for (const match of body.matchAll(
    /!?\[[^\]\n]*\]\(\s*(<[^>\n]+>|[^)\s]+)(?:\s+["'][^"'\n]*["'])?\s*\)/g,
  ))
    add(match[1]!)
  return [...out]
}

function referenceProblem(
  folder: string,
  realRoot: string,
  ref: string,
): { kind: 'error' | 'warning'; message: string } | null {
  if (ref === '..' || ref.startsWith('../'))
    return {
      kind: 'warning',
      message: `Reference points outside the Skill folder: ${ref}`,
    }
  const path = join(folder, ...ref.split('/'))
  if (!isPathInside(folder, path))
    return {
      kind: 'warning',
      message: `Reference points outside the Skill folder: ${ref}`,
    }
  if (!existsSync(path))
    return { kind: 'warning', message: `Referenced file is missing: ${ref}` }
  let real: string
  try {
    real = realpathSync(path)
  } catch {
    return { kind: 'warning', message: `Referenced file is missing: ${ref}` }
  }
  if (!isPathInside(realRoot, real))
    return {
      kind: 'error',
      message: `Referenced file resolves outside the Skill folder: ${ref}`,
    }
  try {
    const stat = statSync(real)
    if (stat.isFile() && stat.size > MAX_REFERENCED_FILE_BYTES)
      return {
        kind: 'error',
        message: `Referenced file exceeds 20 MiB: ${ref}`,
      }
  } catch {
    return { kind: 'warning', message: `Referenced file is missing: ${ref}` }
  }
  return null
}

export function isPathInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return (
    rel === '' ||
    (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  )
}

function toPosix(path: string): string {
  return path.split(sep).join('/')
}

function capitalize(value: string): string {
  return value ? value[0]!.toUpperCase() + value.slice(1) : value
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
