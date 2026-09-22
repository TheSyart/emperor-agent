/**
 * Skill import: pasted SKILL.md text, a local folder, a local zip, or an
 * https link (a GitHub repository / `tree/<ref>/<dir>` link, or a direct
 * zip link). Every source is materialized into a private staging folder,
 * searched for `SKILL.md` folders (the root, or every nested Skill folder),
 * validated with the relaxed rules, and copied into the target Skills
 * folder as `<target>/<frontmatter name>`. Dependency and VCS folders are
 * not copied. One result entry is reported per Skill found.
 */

import { randomBytes } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, relative, resolve, sep } from 'node:path'
import { extractBoundedZip } from '../environment/zip'
import { isPublicHttpRedirectResponse } from '../network/public-http'
import type { WebFetchClient } from '../network/web-fetch-client'
import { SkillError } from './errors'
import { skillNameError } from './name'
import {
  checkSkillFolder,
  parseSkillFrontmatter,
  SKILL_FILE,
  SKIPPED_SKILL_DIRS,
} from './validate'

export type SkillImportSource =
  | { kind: 'content'; content: string; name?: string | null }
  | { kind: 'folder'; path: string }
  | { kind: 'zip'; path: string }
  | { kind: 'url'; url: string }

export type SkillImportScope = 'user' | 'project'

export interface ImportedSkill {
  name: string
  scope: SkillImportScope
  /** Installed Skill folder. */
  path: string
  warnings: string[]
  /** An existing Skill with the same name was replaced (`overwrite`). */
  replaced: boolean
}

/**
 * Why one Skill of an import was not installed:
 * - `skill_invalid`: the Skill failed validation or exceeds the copy limits;
 * - `skill_exists`: a Skill with the same name is already installed in the
 *   target folder (import again with `overwrite` to replace it);
 * - `skill_duplicate`: another Skill of the same import has the same name;
 * - `skill_import_failed`: copying into the target folder failed.
 */
export type SkillImportFailureCode =
  'skill_invalid' | 'skill_exists' | 'skill_duplicate' | 'skill_import_failed'

export interface SkillImportFailure {
  /** Machine-readable failure kind; `reason` is the human-readable text. */
  code: SkillImportFailureCode
  /** Frontmatter name when it could be read. */
  name: string | null
  /** Skill folder relative to the imported source ('.' for its root). */
  path: string
  reason: string
}

export interface SkillImportResult {
  imported: ImportedSkill[]
  errors: SkillImportFailure[]
}

export interface SkillImportOptions {
  source: SkillImportSource
  /** Target Skills folder (must exist). */
  targetDir: string
  scope: SkillImportScope
  overwrite?: boolean
  fetchClient?: WebFetchClient | null
  signal?: AbortSignal
}

const MAX_CONTENT_BYTES = 1024 * 1024
const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024
const MAX_EXTRACTED_BYTES = 200 * 1024 * 1024
const MAX_EXTRACTED_ENTRIES = 10_000
const MAX_FILE_BYTES = 20 * 1024 * 1024
const MAX_SKILL_FILES = 2_000
const MAX_SKILL_BYTES = 100 * 1024 * 1024
const MAX_LOCATE_DEPTH = 6
const MAX_LOCATED_SKILLS = 100
const DOWNLOAD_TIMEOUT_MS = 120_000
/** Never copied into an installed Skill. */
const NOT_COPIED = new Set([...SKIPPED_SKILL_DIRS, '__MACOSX', '.DS_Store'])

export async function importSkills(
  opts: SkillImportOptions,
): Promise<SkillImportResult> {
  const staging = mkdtempSync(join(tmpdir(), 'emperor-skill-import-'))
  try {
    const root = await materialize(opts, staging)
    const candidates = locateSkillFolders(root)
    if (candidates.length === 0)
      throw new SkillError(
        'No SKILL.md was found in the imported source',
        'skill_import_failed',
      )
    const result: SkillImportResult = { imported: [], errors: [] }
    const seen = new Set<string>()
    for (const folder of candidates) {
      const rel = toPosix(relative(root, folder)) || '.'
      const check = checkSkillFolder(folder, {
        folderName: opts.source.kind === 'content' ? null : basename(folder),
      })
      if (!check.valid) {
        result.errors.push({
          code: 'skill_invalid',
          name: check.name || null,
          path: rel,
          reason: check.errors.join('; '),
        })
        continue
      }
      if (seen.has(check.name)) {
        result.errors.push({
          code: 'skill_duplicate',
          name: check.name,
          path: rel,
          reason: `Another Skill in this import is also named "${check.name}"`,
        })
        continue
      }
      seen.add(check.name)
      try {
        const installed = installSkillFolder(folder, {
          targetDir: opts.targetDir,
          name: check.name,
          overwrite: opts.overwrite === true,
        })
        result.imported.push({
          name: check.name,
          scope: opts.scope,
          path: installed.path,
          warnings: [...check.warnings, ...installed.warnings],
          replaced: installed.replaced,
        })
      } catch (error) {
        result.errors.push({
          code: installFailureCode(error),
          name: check.name,
          path: rel,
          reason: errorMessage(error),
        })
      }
    }
    return result
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

async function materialize(
  opts: SkillImportOptions,
  staging: string,
): Promise<string> {
  const source = opts.source
  switch (source.kind) {
    case 'content':
      return materializeContent(source.content, source.name ?? null, staging)
    case 'folder': {
      const path = resolve(String(source.path ?? ''))
      let stat
      try {
        stat = statSync(path)
      } catch {
        throw new SkillError(`Folder not found: ${path}`, 'skill_import_failed')
      }
      if (!stat.isDirectory())
        throw new SkillError(`Not a folder: ${path}`, 'skill_import_failed')
      return realpathSync(path)
    }
    case 'zip': {
      const path = resolve(String(source.path ?? ''))
      let stat
      try {
        stat = statSync(path)
      } catch {
        throw new SkillError(
          `Zip file not found: ${path}`,
          'skill_import_failed',
        )
      }
      if (!stat.isFile())
        throw new SkillError(`Not a zip file: ${path}`, 'skill_import_failed')
      return extractZip(realpathSync(path), join(staging, 'extracted'))
    }
    case 'url':
      return await materializeUrl(source.url, opts, staging)
  }
}

function materializeContent(
  content: string,
  requestedName: string | null,
  staging: string,
): string {
  const text = String(content ?? '')
  if (Buffer.byteLength(text, 'utf8') > MAX_CONTENT_BYTES)
    throw new SkillError('SKILL.md exceeds 1 MiB', 'skill_invalid')
  const parsed = parseSkillFrontmatter(text)
  if (!parsed.present)
    throw new SkillError(
      parsed.errors[0] ?? 'SKILL.md must start with YAML frontmatter',
      'skill_invalid',
    )
  const declared =
    typeof parsed.data.name === 'string' ? parsed.data.name.trim() : ''
  const name = String(requestedName ?? '').trim() || declared
  if (!name)
    throw new SkillError(
      'The SKILL.md frontmatter has no "name"; enter a Skill name',
      'skill_invalid',
    )
  const nameError = skillNameError(name)
  if (nameError) throw new SkillError(nameError, 'skill_invalid')
  const folder = join(staging, 'content', name)
  mkdirSync(folder, { recursive: true })
  writeFileSync(
    join(folder, SKILL_FILE),
    `${withFrontmatterName(text, name).trimEnd()}\n`,
    'utf8',
  )
  return folder
}

/** Set (or insert) the frontmatter `name` line. */
export function withFrontmatterName(content: string, name: string): string {
  const lines = String(content)
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
  const fence = /^---[ \t]*$/
  if (!fence.test(lines[0] ?? '')) return content
  const end = lines.findIndex((line, index) => index > 0 && fence.test(line))
  if (end < 0) return content
  const index = lines.findIndex(
    (line, at) => at > 0 && at < end && /^name\s*:/.test(line),
  )
  const line = `name: ${name}`
  if (index >= 0) {
    if (/^name\s*:\s*['"]?([^'"]*)['"]?\s*$/.exec(lines[index]!)?.[1] === name)
      return lines.join('\n')
    lines[index] = line
  } else lines.splice(1, 0, line)
  return lines.join('\n')
}

// ── URL sources ──────────────────────────────────────────────────────────

export type ParsedSkillImportUrl =
  | {
      kind: 'github'
      owner: string
      repo: string
      ref: string | null
      /** Folder inside the repository ('' for its root), posix separators. */
      dir: string
      /** Archive URLs tried in order until one answers 2xx. */
      downloads: string[]
      label: string
    }
  | { kind: 'zip'; url: string; downloads: string[]; label: string }

const GITHUB_HOSTS = new Set(['github.com', 'www.github.com'])
const GITHUB_SEGMENT = /^[A-Za-z0-9_.-]+$/
const GITHUB_REF = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/
const COMMIT_SHA = /^[0-9a-f]{7,40}$/

/** Parse an https import link into archive download candidates. */
export function parseSkillImportUrl(raw: string): ParsedSkillImportUrl {
  let url: URL
  try {
    url = new URL(String(raw ?? '').trim())
  } catch {
    throw new SkillError('Enter a valid https:// link', 'skill_import_failed')
  }
  if (url.protocol !== 'https:')
    throw new SkillError(
      'Only https:// links can be imported',
      'skill_import_failed',
    )
  if (url.username || url.password)
    throw new SkillError(
      'Links with embedded credentials are not allowed',
      'skill_import_failed',
    )
  if (!GITHUB_HOSTS.has(url.hostname.toLowerCase()))
    return {
      kind: 'zip',
      url: url.toString(),
      downloads: [url.toString()],
      label: url.toString(),
    }
  const segments = url.pathname
    .split('/')
    .filter(Boolean)
    .map((segment) => safeDecode(segment))
  const owner = segments[0] ?? ''
  const repo = (segments[1] ?? '').replace(/\.git$/, '')
  if (!GITHUB_SEGMENT.test(owner) || !GITHUB_SEGMENT.test(repo))
    throw new SkillError(
      'Use a GitHub repository link such as https://github.com/owner/repo',
      'skill_import_failed',
    )
  const mode = segments[2]
  if (mode === 'archive' || url.pathname.toLowerCase().endsWith('.zip'))
    return {
      kind: 'zip',
      url: url.toString(),
      downloads: [url.toString()],
      label: url.toString(),
    }
  let ref: string | null = null
  let rest: string[] = []
  if (mode === 'tree' || mode === 'blob') {
    ref = segments[3] ?? null
    rest = segments.slice(4)
    if (mode === 'blob') rest = rest.slice(0, -1)
  } else if (mode !== undefined)
    throw new SkillError(
      'Use a GitHub repository or folder link (…/tree/<branch>/<folder>)',
      'skill_import_failed',
    )
  if (ref !== null && (!GITHUB_REF.test(ref) || ref.includes('..')))
    throw new SkillError(
      'Unsupported GitHub branch or tag',
      'skill_import_failed',
    )
  if (rest.some((part) => part === '..' || part === '.' || part.includes('\\')))
    throw new SkillError(
      'Unsupported GitHub folder path',
      'skill_import_failed',
    )
  const base = `https://codeload.github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/zip`
  const encodedRef = ref?.split('/').map(encodeURIComponent).join('/') ?? ''
  const downloads =
    ref === null
      ? [
          `${base}/HEAD`,
          `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/archive/HEAD.zip`,
        ]
      : COMMIT_SHA.test(ref)
        ? [`${base}/${encodedRef}`]
        : [
            `${base}/refs/heads/${encodedRef}`,
            `${base}/refs/tags/${encodedRef}`,
          ]
  const dir = rest.join('/')
  return {
    kind: 'github',
    owner,
    repo,
    ref,
    dir,
    downloads,
    label: `${owner}/${repo}${ref ? `@${ref}` : ''}${dir ? `/${dir}` : ''}`,
  }
}

async function materializeUrl(
  raw: string,
  opts: SkillImportOptions,
  staging: string,
): Promise<string> {
  const parsed = parseSkillImportUrl(raw)
  if (!opts.fetchClient)
    throw new SkillError(
      'Importing from a link is not available in this environment',
      'skill_import_failed',
    )
  const body = await download(opts.fetchClient, parsed, opts.signal)
  const archive = join(staging, 'download.zip')
  writeFileSync(archive, body, { mode: 0o600 })
  const extracted = extractZip(archive, join(staging, 'extracted'))
  if (parsed.kind !== 'github') return extracted
  const top = readdirSync(extracted).filter((entry) => entry !== '__MACOSX')
  const repoRoot =
    top.length === 1 && statSync(join(extracted, top[0]!)).isDirectory()
      ? join(extracted, top[0]!)
      : extracted
  if (!parsed.dir) return repoRoot
  const folder = join(repoRoot, ...parsed.dir.split('/'))
  if (!existsSync(folder) || !statSync(folder).isDirectory())
    throw new SkillError(
      `Folder "${parsed.dir}" was not found in ${parsed.label}`,
      'skill_import_failed',
    )
  return folder
}

async function download(
  client: WebFetchClient,
  parsed: ParsedSkillImportUrl,
  signal: AbortSignal | undefined,
): Promise<Uint8Array> {
  let lastStatus = 0
  for (const url of parsed.downloads) {
    let response
    try {
      response = await client.get({
        url,
        protocols: ['https:'],
        maxBytes: MAX_ARCHIVE_BYTES,
        signal: signal ?? AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
        redirectMode: 'follow_validated',
        headers: {
          accept: 'application/zip, application/octet-stream',
          'user-agent': 'Emperor-Agent-Skill/1',
        },
      })
    } catch (error) {
      throw new SkillError(
        `Download failed for ${parsed.label}: ${errorMessage(error)}`,
        'skill_import_failed',
        { cause: error },
      )
    }
    if (isPublicHttpRedirectResponse(response)) {
      lastStatus = response.status
      continue
    }
    if (response.status === 404 || response.status === 410) {
      lastStatus = response.status
      continue
    }
    if (response.status < 200 || response.status >= 300)
      throw new SkillError(
        `Download failed for ${parsed.label}: HTTP ${response.status}`,
        'skill_import_failed',
      )
    const body = response.body
    if (
      body.byteLength < 4 ||
      body[0] !== 0x50 ||
      body[1] !== 0x4b ||
      body[2] !== 0x03 ||
      body[3] !== 0x04
    )
      throw new SkillError(
        `The link did not return a zip archive: ${parsed.label}`,
        'skill_import_failed',
      )
    return body
  }
  throw new SkillError(
    `Download failed for ${parsed.label}: ${lastStatus ? `HTTP ${lastStatus}` : 'not found'}`,
    'skill_import_failed',
  )
}

function extractZip(archive: string, destination: string): string {
  try {
    extractBoundedZip({
      archive,
      destination,
      maxArchiveBytes: MAX_ARCHIVE_BYTES,
      maxFiles: MAX_EXTRACTED_ENTRIES,
      maxFileBytes: MAX_FILE_BYTES,
      maxTotalBytes: MAX_EXTRACTED_BYTES,
      maxPathDepth: 32,
    })
  } catch (error) {
    throw new SkillError(
      `The zip archive could not be extracted: ${errorMessage(error)}`,
      'skill_import_failed',
      { cause: error },
    )
  }
  return destination
}

// ── locate + install ─────────────────────────────────────────────────────

/** Folders holding a SKILL.md: the root itself, else every nested Skill folder. */
export function locateSkillFolders(root: string): string[] {
  if (isRegularFileOrLink(join(root, SKILL_FILE))) return [root]
  const found: string[] = []
  const walk = (directory: string, depth: number): void => {
    if (depth > MAX_LOCATE_DEPTH || found.length >= MAX_LOCATED_SKILLS) return
    let entries: string[]
    try {
      entries = readdirSync(directory).sort()
    } catch {
      return
    }
    for (const entry of entries) {
      if (NOT_COPIED.has(entry)) continue
      const path = join(directory, entry)
      let stat
      try {
        stat = lstatSync(path)
      } catch {
        continue
      }
      if (!stat.isDirectory()) continue
      if (isRegularFileOrLink(join(path, SKILL_FILE))) {
        found.push(path)
        if (found.length >= MAX_LOCATED_SKILLS) return
        continue
      }
      walk(path, depth + 1)
    }
  }
  walk(root, 1)
  return found
}

function isRegularFileOrLink(path: string): boolean {
  try {
    const stat = lstatSync(path)
    return stat.isFile() || stat.isSymbolicLink()
  } catch {
    return false
  }
}

/**
 * Copy a validated Skill folder into `<targetDir>/<name>` through a staging
 * folder inside the target (same filesystem, atomic rename).
 */
export function installSkillFolder(
  folder: string,
  opts: { targetDir: string; name: string; overwrite: boolean },
): { path: string; replaced: boolean; warnings: string[] } {
  const target = join(opts.targetDir, opts.name)
  const exists = pathExists(target)
  if (exists) {
    if (safeRealpath(target) === safeRealpath(folder))
      throw new SkillError(
        `The Skill "${opts.name}" is already installed at this location`,
        'skill_exists',
      )
    if (!opts.overwrite)
      throw new SkillError(
        `A Skill named "${opts.name}" already exists; choose overwrite to replace it`,
        'skill_exists',
        { action: 'overwrite' },
      )
  }
  const flat = join(opts.targetDir, `${opts.name}.md`)
  if (!exists && pathExists(flat) && !opts.overwrite)
    throw new SkillError(
      `A Skill file named "${opts.name}.md" already exists; choose overwrite to replace it`,
      'skill_exists',
      { action: 'overwrite' },
    )
  const stage = join(
    opts.targetDir,
    `.import-${process.pid}-${randomBytes(6).toString('hex')}`,
  )
  const warnings: string[] = []
  try {
    copySkillTree(folder, stage, warnings)
    let backup: string | null = null
    if (exists) {
      backup = join(
        opts.targetDir,
        `.replaced-${process.pid}-${randomBytes(6).toString('hex')}`,
      )
      renameSync(target, backup)
    }
    try {
      renameSync(stage, target)
    } catch (error) {
      if (backup !== null) renameSync(backup, target)
      throw error
    }
    if (backup !== null) rmSync(backup, { recursive: true, force: true })
    if (!exists && opts.overwrite && pathExists(flat)) unlinkSync(flat)
    return { path: target, replaced: exists, warnings }
  } catch (error) {
    rmSync(stage, { recursive: true, force: true })
    throw error
  }
}

/** Copy files, folders, and internal relative links; dependency/VCS folders are skipped. */
export function copySkillTree(
  source: string,
  destination: string,
  warnings: string[] = [],
): void {
  let files = 0
  let bytes = 0
  const skipped = new Set<string>()
  const copy = (from: string, to: string, depth: number): void => {
    if (depth > 32)
      throw new SkillError('Skill folder is nested too deeply', 'skill_invalid')
    mkdirSync(to, { recursive: depth === 0 })
    for (const entry of readdirSync(from).sort()) {
      if (NOT_COPIED.has(entry)) {
        if (SKIPPED_SKILL_DIRS.has(entry)) skipped.add(entry)
        continue
      }
      const src = join(from, entry)
      const dest = join(to, entry)
      const stat = lstatSync(src)
      if (stat.isSymbolicLink()) {
        symlinkSync(readlinkSync(src), dest)
        continue
      }
      if (stat.isDirectory()) {
        copy(src, dest, depth + 1)
        continue
      }
      if (!stat.isFile()) continue
      files += 1
      bytes += stat.size
      if (stat.size > MAX_FILE_BYTES)
        throw new SkillError(
          `File exceeds 20 MiB: ${toPosix(relative(source, src))}`,
          'skill_invalid',
        )
      if (files > MAX_SKILL_FILES)
        throw new SkillError(
          `Skill has more than ${MAX_SKILL_FILES} files`,
          'skill_invalid',
        )
      if (bytes > MAX_SKILL_BYTES)
        throw new SkillError('Skill exceeds 100 MiB', 'skill_invalid')
      copyFileSync(src, dest)
    }
  }
  copy(source, destination, 0)
  if (skipped.size)
    warnings.push(
      `Not copied: ${[...skipped].sort().join(', ')} (reinstall dependencies inside the Skill folder if needed)`,
    )
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

function safeRealpath(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function toPosix(path: string): string {
  return path.split(sep).join('/')
}

/** `installSkillFolder` throws `skill_exists` / `skill_invalid`; anything else is an IO failure. */
function installFailureCode(error: unknown): SkillImportFailureCode {
  if (
    error instanceof SkillError &&
    (error.code === 'skill_exists' || error.code === 'skill_invalid')
  )
    return error.code
  return 'skill_import_failed'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
