/**
 * Pure-JS fallback search engine for the `glob` / `grep` tools, used when the
 * ripgrep binary cannot be spawned (not bundled, not on PATH). It emulates the
 * exact ripgrep invocations built by `buildGlobCommand` / `buildGrepCommand`
 * and returns RAW results in the shape ripgrep would print them (paths as rg
 * would display them, before workdir relativization), so the tool formatting
 * pipeline stays identical on both paths.
 *
 * Emulated ripgrep semantics:
 * - globs are gitignore-style (`*` / `?` never cross `/`, `**` spans
 *   directories, `{a,b}` alternation, `[...]` classes); a glob without `/`
 *   matches the basename at any depth; globs match the path relative to the
 *   working directory (ripgrep's override root);
 * - symlinks are not followed during traversal (an explicit root is);
 * - `glob` (`--files --no-ignore --hidden`) lists every file except VCS
 *   metadata directories, newest modification first;
 * - `grep` (default filters) skips hidden entries and entries excluded by
 *   `.gitignore` (inside a git repository), `.ignore` and `.rgignore`; a file
 *   matching `include` is searched even when hidden or ignored; binary files
 *   (NUL byte) are skipped; an explicitly given file is always searched.
 */

import type { Dirent, Stats } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { RAW_OUTPUT_MAX_BYTES, SearchError, searchAborted } from './ripgrep'

/** VCS metadata directory names excluded from `glob` (mirrors `GLOB_VCS_EXCLUDES`). */
const VCS_DIRECTORIES: ReadonlySet<string> = new Set([
  '.git',
  '.svn',
  '.hg',
  '.bzr',
  '.jj',
  '.sl',
])
/** Ignore files read per directory, lowest precedence first (ripgrep order). */
const IGNORE_FILES = ['.gitignore', '.ignore', '.rgignore'] as const
/** Files larger than this are not content-searched by the fallback engine. */
export const JS_GREP_MAX_FILE_BYTES = 20 * 1024 * 1024
/** Approximate per-match `rg --json` record overhead counted toward the raw output cap. */
const GREP_RECORD_OVERHEAD_BYTES = 128

export interface JsSearchOptions {
  /** Directory the search runs in (ripgrep's cwd). */
  workdir: string
  signal: AbortSignal
  /** Raw-output cap mirroring ripgrep's stdout cap (default {@link RAW_OUTPUT_MAX_BYTES}). */
  rawOutputMaxBytes?: number
}

// ---------------------------------------------------------------- globbing

/** Expand the first top-level `{a,b}` group recursively into plain patterns. */
export function expandBraces(pattern: string): string[] {
  let depth = 0
  let start = -1
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index]
    if (char === '\\') {
      index++
      continue
    }
    if (char === '{') {
      if (depth === 0) start = index
      depth++
    } else if (char === '}' && depth > 0) {
      depth--
      if (depth === 0 && start >= 0) {
        const body = pattern.slice(start + 1, index)
        const alternatives = splitTopLevelCommas(body)
        if (alternatives.length < 2) {
          start = -1
          continue
        }
        const prefix = pattern.slice(0, start)
        const suffix = pattern.slice(index + 1)
        return alternatives.flatMap((alternative) =>
          expandBraces(`${prefix}${alternative}${suffix}`),
        )
      }
    }
  }
  return [pattern]
}

function splitTopLevelCommas(body: string): string[] {
  const parts: string[] = []
  let depth = 0
  let current = ''
  for (let index = 0; index < body.length; index++) {
    const char = body[index] ?? ''
    if (char === '\\') {
      current += char + (body[index + 1] ?? '')
      index++
      continue
    }
    if (char === '{') depth++
    else if (char === '}') depth = Math.max(0, depth - 1)
    if (char === ',' && depth === 0) {
      parts.push(current)
      current = ''
      continue
    }
    current += char
  }
  parts.push(current)
  return parts
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
}

/** Translate one glob path segment (no `/`, no braces) into a regex fragment. */
function segmentToRegExp(segment: string): string {
  let out = ''
  for (let index = 0; index < segment.length; index++) {
    const char = segment[index] ?? ''
    if (char === '\\') {
      out += escapeRegExp(segment[index + 1] ?? '\\')
      index++
    } else if (char === '*') {
      while (segment[index + 1] === '*') index++
      out += '[^/]*'
    } else if (char === '?') {
      out += '[^/]'
    } else if (char === '[') {
      const close = segment.indexOf(']', index + 2)
      if (close < 0) {
        out += '\\['
        continue
      }
      let body = segment.slice(index + 1, close)
      let negate = false
      if (body.startsWith('!') || body.startsWith('^')) {
        negate = true
        body = body.slice(1)
      }
      body = body.replace(/\\/g, '\\\\').replace(/\]/g, '\\]')
      out += negate ? `[^/${body}]` : `[${body}]`
      index = close
    } else {
      out += escapeRegExp(char)
    }
  }
  return out
}

/** Translate one brace-free glob into an anchored-body regex source. */
function globBodyToRegExp(pattern: string): string {
  const segments = pattern.split('/').filter((segment) => segment.length > 0)
  let out = ''
  let needSeparator = false
  segments.forEach((segment, index) => {
    const last = index === segments.length - 1
    if (segment === '**') {
      if (last) out += index === 0 ? '.*' : '/.*'
      else if (index === 0) out += '(?:.*/)?'
      else out += '(?:/.*)?/'
      needSeparator = false
      return
    }
    if (needSeparator) out += '/'
    out += segmentToRegExp(segment)
    needSeparator = true
  })
  return out
}

export interface CompiledGlob {
  /** Match a `/`-separated path (relative to the glob's base). */
  test(path: string): boolean
  /** The pattern ended with `/`: it only matches directories. */
  dirOnly: boolean
}

/**
 * Compile a gitignore-style glob. A pattern with no `/` (a trailing `/`
 * aside) matches the basename at any depth; a leading `/` or an inner `/`
 * anchors it to the base.
 */
export function compileGlob(rawPattern: string): CompiledGlob {
  let pattern = rawPattern
  const dirOnly = pattern.length > 1 && pattern.endsWith('/')
  if (dirOnly) pattern = pattern.replace(/\/+$/, '')
  const sources = expandBraces(pattern).map((alternative) => {
    let body = alternative
    const anchored =
      body.startsWith('/') || body.replace(/\/+$/, '').includes('/')
    body = body.replace(/^\/+/, '')
    const source = globBodyToRegExp(body)
    return anchored || source.startsWith('(?:.*/)?') || source === '.*'
      ? source
      : `(?:.*/)?${source}`
  })
  const regex = new RegExp(`^(?:${sources.join('|')})$`)
  return { test: (path) => regex.test(path), dirOnly }
}

// ---------------------------------------------------------- ignore handling

interface IgnoreRule {
  /** Absolute directory the rule's ignore file lives in. */
  base: string
  glob: CompiledGlob
  negate: boolean
}

function parseIgnoreFile(text: string, base: string): IgnoreRule[] {
  const rules: IgnoreRule[] = []
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.replace(/(?<!\\)\s+$/, '')
    if (line.length === 0 || line.startsWith('#')) continue
    let negate = false
    if (line.startsWith('!')) {
      negate = true
      line = line.slice(1)
    } else if (line.startsWith('\\!') || line.startsWith('\\#'))
      line = line.slice(1)
    if (line.length === 0) continue
    try {
      rules.push({ base, glob: compileGlob(line), negate })
    } catch {
      // An unparsable ignore line is skipped, as ripgrep warns and continues.
    }
  }
  return rules
}

async function readIgnoreRules(
  directory: string,
  gitAware: boolean,
): Promise<IgnoreRule[]> {
  const rules: IgnoreRule[] = []
  for (const name of IGNORE_FILES) {
    if (name === '.gitignore' && !gitAware) continue
    try {
      rules.push(
        ...parseIgnoreFile(
          await readFile(join(directory, name), 'utf8'),
          directory,
        ),
      )
    } catch {
      // Missing or unreadable ignore file: nothing to apply.
    }
  }
  return rules
}

/** Last matching rule wins; `true` = ignored. */
function isIgnored(
  rules: readonly IgnoreRule[],
  absolutePath: string,
  isDirectory: boolean,
): boolean {
  let ignored = false
  for (const rule of rules) {
    if (rule.glob.dirOnly && !isDirectory) continue
    const rel = relative(rule.base, absolutePath)
    if (
      rel.length === 0 ||
      rel === '..' ||
      rel.startsWith(`..${sep}`) ||
      isAbsolute(rel)
    )
      continue
    if (rule.glob.test(toPosix(rel))) ignored = !rule.negate
  }
  return ignored
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * The ignore rules in effect at `root` from its ancestors: `.gitignore` only
 * applies inside a git repository (ripgrep's require-git default), and
 * ancestor ignore files are read up to the repository root.
 */
async function ancestorIgnoreRules(
  root: string,
): Promise<{ rules: IgnoreRule[]; gitAware: boolean }> {
  const chain: string[] = []
  let gitRoot: string | undefined
  let current = root
  for (;;) {
    chain.push(current)
    if (await exists(join(current, '.git'))) {
      gitRoot = current
      break
    }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  const gitAware = gitRoot !== undefined
  const ancestors = gitAware ? chain.slice(1) : []
  const rules: IgnoreRule[] = []
  for (const directory of ancestors.reverse())
    rules.push(...(await readIgnoreRules(directory, gitAware)))
  return { rules, gitAware }
}

// ------------------------------------------------------------------ walking

interface WalkedFile {
  /** Absolute path. */
  absolute: string
  /** Path as ripgrep would print it (root prefix + native-separator relative path). */
  display: string
  stats: Stats
}

interface WalkOptions {
  root: string
  displayRoot: string | undefined
  workdir: string
  signal: AbortSignal
  toolName: string
  /** Skip this directory subtree entirely. */
  pruneDirectory(
    absolute: string,
    name: string,
    display: string,
    rules: readonly IgnoreRule[],
  ): boolean
  /** Keep this file. */
  acceptFile(
    absolute: string,
    name: string,
    display: string,
    rules: readonly IgnoreRule[],
  ): boolean
  /** Per-directory ignore rules (undefined → none). */
  ignore?: { rules: IgnoreRule[]; gitAware: boolean }
}

function toPosix(path: string): string {
  return sep === '/' ? path : path.split(sep).join('/')
}

function joinDisplay(displayRoot: string | undefined, rel: string): string {
  if (displayRoot === undefined) return rel
  return displayRoot.endsWith('/') || displayRoot.endsWith(sep)
    ? `${displayRoot}${rel}`
    : `${displayRoot}${sep}${rel}`
}

/** The path a glob override is matched against: workdir-relative when inside it. */
function overridePath(display: string, workdir: string): string {
  let path = display
  if (isAbsolute(path)) {
    const rel = relative(workdir, path)
    if (
      rel.length > 0 &&
      rel !== '..' &&
      !rel.startsWith(`..${sep}`) &&
      !isAbsolute(rel)
    )
      path = rel
  }
  return toPosix(path).replace(/^(?:\.\/)+/, '')
}

async function* walk(options: WalkOptions): AsyncGenerator<WalkedFile> {
  const pending: Array<{ absolute: string; rel: string; rules: IgnoreRule[] }> =
    []
  const rootRules =
    options.ignore !== undefined
      ? [
          ...options.ignore.rules,
          ...(await readIgnoreRules(options.root, options.ignore.gitAware)),
        ]
      : []
  pending.push({ absolute: options.root, rel: '', rules: rootRules })
  while (pending.length > 0) {
    const directory = pending.pop()
    if (directory === undefined) break
    if (options.signal.aborted) throw searchAborted(options.toolName)
    let entries: Dirent[]
    try {
      entries = await readdir(directory.absolute, { withFileTypes: true })
    } catch {
      // Unreadable directory: ripgrep warns and continues; so do we.
      continue
    }
    entries.sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    )
    const subdirectories: Array<{
      absolute: string
      rel: string
      rules: IgnoreRule[]
    }> = []
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const absolute = join(directory.absolute, entry.name)
      const rel =
        directory.rel.length > 0
          ? `${directory.rel}${sep}${entry.name}`
          : entry.name
      const display = joinDisplay(options.displayRoot, rel)
      if (entry.isDirectory()) {
        if (
          options.pruneDirectory(absolute, entry.name, display, directory.rules)
        )
          continue
        const rules =
          options.ignore !== undefined
            ? [
                ...directory.rules,
                ...(await readIgnoreRules(absolute, options.ignore.gitAware)),
              ]
            : directory.rules
        subdirectories.push({ absolute, rel, rules })
        continue
      }
      if (!entry.isFile()) continue
      if (!options.acceptFile(absolute, entry.name, display, directory.rules))
        continue
      let stats: Stats
      try {
        stats = await stat(absolute)
      } catch {
        continue
      }
      yield { absolute, display, stats }
    }
    // Depth-first in sorted order: push children reversed so the first pops first.
    for (let index = subdirectories.length - 1; index >= 0; index--) {
      const subdirectory = subdirectories[index]
      if (subdirectory !== undefined) pending.push(subdirectory)
    }
  }
}

async function statRoot(
  toolName: string,
  path: string,
  display: string,
): Promise<Stats> {
  try {
    return await stat(path)
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code
    const reason =
      code === 'ENOENT'
        ? 'No such file or directory (os error 2)'
        : error instanceof Error
          ? error.message
          : String(error)
    throw new SearchError(
      `${toolName} search failed (exit 2): rg: ${display}: ${reason}`,
      'SEARCH_FAILED',
      { cause: error },
    )
  }
}

function overflow(toolName: string, cap: number): SearchError {
  return new SearchError(
    `${toolName} produced more than ${cap} bytes of raw output, over the cap; narrow pattern, path, or include and retry`,
    'SEARCH_RAW_OUTPUT_OVERFLOW',
  )
}

// --------------------------------------------------------------------- glob

/**
 * Emulate `rg --files --glob=<pattern> --sortr=modified --no-ignore --hidden`
 * with the VCS excludes: raw display paths, newest modification first
 * (ties by path).
 */
/** Arguments of the `glob` tool. */
export interface GlobInput {
  pattern: string
  path?: string
}

/** Arguments of the `grep` tool. */
export interface GrepInput {
  pattern: string
  path?: string
  include?: string
}

/** One matching line reported by `grep`. */
export interface GrepMatch {
  path: string
  lineNumber: number
  line: string
}

export async function jsGlobFiles(
  input: GlobInput,
  options: JsSearchOptions,
): Promise<string[]> {
  const toolName = 'glob'
  const cap = options.rawOutputMaxBytes ?? RAW_OUTPUT_MAX_BYTES
  if (options.signal.aborted) throw searchAborted(toolName)
  const glob = compileGlob(input.pattern)
  const root = resolve(options.workdir, input.path ?? '.')
  const rootStats = await statRoot(toolName, root, input.path ?? '.')
  const vcsExcluded = (display: string): boolean =>
    overridePath(display, options.workdir)
      .split('/')
      .some((segment) => VCS_DIRECTORIES.has(segment))

  if (rootStats.isFile()) {
    const display = input.path ?? root
    return vcsExcluded(display) ? [] : [display]
  }

  const found: Array<{ path: string; mtimeMs: number }> = []
  let bytes = 0
  for await (const file of walk({
    root,
    displayRoot: input.path,
    workdir: options.workdir,
    signal: options.signal,
    toolName,
    pruneDirectory: (_absolute, name) => VCS_DIRECTORIES.has(name),
    acceptFile: (_absolute, _name, display) => {
      if (vcsExcluded(display)) return false
      return glob.test(overridePath(display, options.workdir))
    },
  })) {
    bytes += Buffer.byteLength(file.display) + 1
    if (bytes > cap) throw overflow(toolName, cap)
    found.push({ path: file.display, mtimeMs: file.stats.mtimeMs })
  }
  if (options.signal.aborted) throw searchAborted(toolName)
  found.sort(
    (left, right) =>
      right.mtimeMs - left.mtimeMs ||
      (left.path < right.path ? -1 : left.path > right.path ? 1 : 0),
  )
  return found.map((entry) => entry.path)
}

// --------------------------------------------------------------------- grep

/**
 * Compile a ripgrep-style regex into a JS RegExp. A leading inline flag
 * group such as `(?i)` becomes RegExp flags; Unicode mode is preferred and
 * dropped only when the pattern needs legacy syntax.
 */
export function compileGrepRegex(pattern: string): RegExp {
  let source = pattern
  let flags = ''
  const inline = /^\(\?([a-zA-Z]+)\)/.exec(source)
  if (inline !== null && /^[imsxU]+$/.test(inline[1] ?? '')) {
    for (const flag of inline[1] ?? '')
      if ('ims'.includes(flag) && !flags.includes(flag)) flags += flag
    source = source.slice(inline[0].length)
  }
  try {
    return new RegExp(source, `${flags}u`)
  } catch {
    try {
      return new RegExp(source, flags)
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      throw new SearchError(
        `grep pattern rejected: regex parse error: ${message}`,
        'SEARCH_INVALID_PATTERN',
        { cause: error },
      )
    }
  }
}

const fatalDecoder = new TextDecoder('utf-8', { fatal: true })
const lossyDecoder = new TextDecoder('utf-8')

function splitLines(buffer: Buffer): Buffer[] {
  const lines: Buffer[] = []
  let start = 0
  for (;;) {
    const newline = buffer.indexOf(0x0a, start)
    if (newline < 0) break
    lines.push(buffer.subarray(start, newline))
    start = newline + 1
  }
  if (start < buffer.length) lines.push(buffer.subarray(start))
  return lines
}

function searchBuffer(
  buffer: Buffer,
  regex: RegExp,
  display: string,
  into: GrepMatch[],
): number {
  let bytes = 0
  let whole: string | undefined
  try {
    whole = fatalDecoder.decode(buffer)
  } catch {
    whole = undefined
  }
  if (whole !== undefined) {
    const lines = whole.split('\n')
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
    lines.forEach((raw, index) => {
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
      regex.lastIndex = 0
      if (!regex.test(line)) return
      into.push({ path: display, lineNumber: index + 1, line })
      bytes += Buffer.byteLength(line) + GREP_RECORD_OVERHEAD_BYTES
    })
    return bytes
  }
  splitLines(buffer).forEach((rawLine, index) => {
    const lineBytes =
      rawLine.length > 0 && rawLine[rawLine.length - 1] === 0x0d
        ? rawLine.subarray(0, -1)
        : rawLine
    let text: string
    let valid = true
    try {
      text = fatalDecoder.decode(lineBytes)
    } catch {
      text = lossyDecoder.decode(lineBytes)
      valid = false
    }
    regex.lastIndex = 0
    if (!regex.test(text)) return
    const line = valid ? text : '(line is not valid UTF-8)'
    into.push({ path: display, lineNumber: index + 1, line })
    bytes += lineBytes.length + GREP_RECORD_OVERHEAD_BYTES
  })
  return bytes
}

/**
 * Emulate `rg --json --regexp=<pattern> [--glob=<include>] [-- <path>]`:
 * raw flat matches (display paths as rg prints them, full untruncated lines)
 * in traversal order.
 */
export async function jsGrepMatches(
  input: GrepInput,
  options: JsSearchOptions,
): Promise<GrepMatch[]> {
  const toolName = 'grep'
  const cap = options.rawOutputMaxBytes ?? RAW_OUTPUT_MAX_BYTES
  if (options.signal.aborted) throw searchAborted(toolName)
  const regex = compileGrepRegex(input.pattern)
  const include =
    input.include !== undefined ? compileGlob(input.include) : undefined
  const root = resolve(options.workdir, input.path ?? '.')
  const rootStats = await statRoot(toolName, root, input.path ?? '.')
  const matches: GrepMatch[] = []
  let bytes = 0

  const searchFile = async (
    absolute: string,
    display: string,
    size: number,
  ): Promise<void> => {
    if (size > JS_GREP_MAX_FILE_BYTES) return
    let buffer: Buffer
    try {
      buffer = await readFile(absolute, { signal: options.signal })
    } catch {
      if (options.signal.aborted) throw searchAborted(toolName)
      return
    }
    if (buffer.includes(0)) return
    bytes += searchBuffer(buffer, regex, display, matches)
    if (bytes > cap) throw overflow(toolName, cap)
  }

  if (rootStats.isFile()) {
    await searchFile(root, input.path ?? root, rootStats.size)
    if (options.signal.aborted) throw searchAborted(toolName)
    return matches
  }

  const includeMatches = (display: string): boolean =>
    include !== undefined &&
    include.test(overridePath(display, options.workdir))
  const ignore = await ancestorIgnoreRules(root)
  for await (const file of walk({
    root,
    displayRoot: input.path,
    workdir: options.workdir,
    signal: options.signal,
    toolName,
    ignore,
    pruneDirectory: (absolute, name, display, rules) => {
      if (include !== undefined && !include.dirOnly && includeMatches(display))
        return false
      if (name.startsWith('.')) return true
      return isIgnored(rules, absolute, true)
    },
    acceptFile: (absolute, name, display, rules) => {
      if (include !== undefined) {
        if (include.dirOnly || !includeMatches(display)) return false
        return true
      }
      if (name.startsWith('.')) return false
      return !isIgnored(rules, absolute, false)
    },
  })) {
    await searchFile(file.absolute, file.display, file.stats.size)
  }
  if (options.signal.aborted) throw searchAborted(toolName)
  return matches
}
