/**
 * The model-facing `grep` tool (ported from dsh-tool-fs-search `grep`):
 * search file contents with a ripgrep regex via line-oriented `rg --json`,
 * so path / line number / text parse without colon-splitting ambiguity.
 * Matches are grouped by file; lines are previewed to a byte cap; a result
 * over the inline match cap saves the complete formatted list to a spill
 * file and reports its path.
 */

import { z } from 'zod'
import {
  defineTool,
  ToolError,
  type ToolDefinition,
  type ToolRunContext,
} from '../../definition'
import type { ToolServices } from '../../services'
import { utf8Head, type SpillRef } from '../../spill'
import { jsGrepMatches, type GrepInput, type GrepMatch } from './js-engine'

export type { GrepInput, GrepMatch } from './js-engine'
import {
  isRipgrepUnavailable,
  runRipgrep,
  SEARCH_TIMEOUT_MS,
  SearchError,
  searchWorkdir,
  toWorkdirRelative,
  trySaveFormattedResult,
} from './ripgrep'

/** Cap on flat matches returned inline by one `grep` call. */
export const GREP_MAX_MATCHES = 250
/** Cap in bytes on one matched-line preview (UTF-8 boundary preserved). */
export const GREP_MAX_LINE_BYTES = 2000

/** System-prompt guidance for `grep` (order 104). */
export const GREP_PROMPT_TEXT =
  'Use the grep tool — not shell grep or rg — to search file contents. Use read on a matched file when you need surrounding context.'

export interface GrepToolOptions {
  /** Inline match cap (default {@link GREP_MAX_MATCHES}). */
  maxMatches?: number
  /** Per-line preview cap in bytes (default {@link GREP_MAX_LINE_BYTES}). */
  maxLineBytes?: number
  /** Tool-call timeout in ms (default 30000). */
  timeoutMs?: number
  /** Workdir for host-initiated calls with no calling agent (default `process.cwd()`). */
  defaultWorkdir?: string
}

/** Reject an `include` that is not ONE positive glob (brace alternation is fine). */
function validateInclude(include: string): void {
  if (include.trim().length === 0)
    throw new ToolError(
      'include must be a non-empty glob when given',
      'INVALID_ARGS',
    )
  if (include.startsWith('!'))
    throw new ToolError(
      'include must be a positive glob filter; negated patterns ("!…") are not supported',
      'INVALID_ARGS',
    )
  let braceDepth = 0
  for (const char of include) {
    if (char === '{') braceDepth++
    else if (char === '}') braceDepth = Math.max(0, braceDepth - 1)
    else if (char === ',' && braceDepth === 0) {
      throw new ToolError(
        'include must be one glob, not a comma-separated list (use {a,b} alternation instead)',
        'INVALID_ARGS',
      )
    }
  }
}

/** Reject an empty pattern (whitespace is a legitimate regex), a blank path, or a bad include. */
export function parseGrepArgs(args: {
  pattern: string
  path?: string | undefined
  include?: string | undefined
}): GrepInput {
  if (args.pattern.length === 0)
    throw new ToolError('pattern must be a non-empty string', 'INVALID_ARGS')
  if (args.path !== undefined && args.path.trim().length === 0)
    throw new ToolError(
      'path must be a non-empty string when given',
      'INVALID_ARGS',
    )
  if (args.include !== undefined) validateInclude(args.include)
  return {
    pattern: args.pattern,
    ...(args.path !== undefined ? { path: args.path } : {}),
    ...(args.include !== undefined ? { include: args.include } : {}),
  }
}

/** The fixed `rg --json` argv; pattern and include in `--flag=value` form, target behind `--`. */
export function buildGrepCommand(input: GrepInput): string[] {
  const parts = ['--json', `--regexp=${input.pattern}`]
  if (input.include !== undefined) parts.push(`--glob=${input.include}`)
  if (input.path !== undefined) parts.push('--', input.path)
  return parts
}

function malformed(detail: string, cause?: unknown): SearchError {
  return new SearchError(
    `grep received malformed ripgrep --json output (${detail})`,
    'SEARCH_FAILED',
    cause !== undefined ? { cause } : undefined,
  )
}

function parseRecord(line: string): GrepMatch | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch (error: unknown) {
    throw malformed('a line is not JSON', error)
  }
  if (typeof parsed !== 'object' || parsed === null)
    throw malformed('a record is not an object')
  const record = parsed as { type?: unknown; data?: unknown }
  if (record.type !== 'match') return undefined
  if (typeof record.data !== 'object' || record.data === null)
    throw malformed('a match record has no data')
  const data = record.data as {
    path?: unknown
    line_number?: unknown
    lines?: unknown
  }
  const pathText =
    typeof data.path === 'object' && data.path !== null
      ? (data.path as { text?: unknown }).text
      : undefined
  if (typeof pathText !== 'string')
    throw malformed('a match record has no path text')
  if (typeof data.line_number !== 'number')
    throw malformed('a match record has no line number')
  if (typeof data.lines !== 'object' || data.lines === null)
    throw malformed('a match record has no line content')
  const lines = data.lines as { text?: unknown; bytes?: unknown }
  if (typeof lines.text === 'string')
    return {
      path: pathText,
      lineNumber: data.line_number,
      line: lines.text.replace(/\r?\n$/, ''),
    }
  if (typeof lines.bytes === 'string')
    return {
      path: pathText,
      lineNumber: data.line_number,
      line: '(line is not valid UTF-8)',
    }
  throw malformed('a match record has neither line text nor bytes')
}

/** Parse complete `rg --json` stdout into flat matches in output order. */
export function parseGrepMatches(stdout: string): GrepMatch[] {
  const matches: GrepMatch[] = []
  for (const line of stdout.split('\n')) {
    if (line.length === 0) continue
    const match = parseRecord(line)
    if (match !== undefined) matches.push(match)
  }
  return matches
}

/** Bound one matched-line preview to `maxBytes`, marking the cut. */
export function previewLine(line: string, maxBytes: number): string {
  const kept = utf8Head(line, maxBytes)
  return kept.truncated ? `${kept.text} (line truncated)` : kept.text
}

function matchNoun(count: number): string {
  return count === 1 ? 'match' : 'matches'
}

function groupByFile(matches: readonly GrepMatch[]): Map<string, GrepMatch[]> {
  const byFile = new Map<string, GrepMatch[]>()
  for (const match of matches) {
    const group = byFile.get(match.path)
    if (group !== undefined) group.push(match)
    else byFile.set(match.path, [match])
  }
  return byFile
}

/** Group flat matches by file (first-seen order): the path, then `Line N: <text>` rows. */
export function formatGrepMatches(matches: readonly GrepMatch[]): string {
  const sections: string[] = []
  for (const [path, group] of groupByFile(matches)) {
    sections.push(
      `${path}\n${group.map((m) => `Line ${m.lineNumber}: ${m.line}`).join('\n')}`,
    )
  }
  return sections.join('\n\n')
}

/** The model-facing text: found-count header, grouped body, and — when capped — the recovery footer. */
export function formatGrepOutput(
  kept: readonly GrepMatch[],
  seen: number,
  spillRef: SpillRef | undefined,
): string {
  const truncated = kept.length < seen
  const header = truncated
    ? `Found ${kept.length} of ${seen} matches`
    : `Found ${seen} ${matchNoun(seen)}`
  const body = formatGrepMatches(kept)
  if (!truncated) return `${header}\n\n${body}`
  const recovery =
    spillRef !== undefined
      ? `Full grep result stored at: ${spillRef.path}. ${spillRef.retrievalHint}`
      : 'The complete result could not be saved; narrow pattern, path, or include to see more.'
  return `${header}\n\n${body}\n\n(${recovery})`
}

/**
 * Flat matches with workdir-relative paths, in output order: from
 * `rg --json`, or from the pure-JS engine (same raw path shape) when the
 * ripgrep binary cannot be spawned.
 */
async function grepRawMatches(
  services: ToolServices,
  context: ToolRunContext,
  defaultWorkdir: string | undefined,
  input: GrepInput,
): Promise<GrepMatch[]> {
  let raw: GrepMatch[]
  let workdir: string
  try {
    const run = await runRipgrep(
      services,
      context,
      'grep',
      buildGrepCommand(input),
      { defaultWorkdir },
    )
    workdir = run.workdir
    raw = run.noMatches ? [] : parseGrepMatches(run.stdout)
  } catch (error: unknown) {
    if (!isRipgrepUnavailable(error)) throw error
    workdir = searchWorkdir(context, defaultWorkdir)
    raw = await jsGrepMatches(input, { workdir, signal: context.signal })
  }
  return raw.map((match) => ({
    ...match,
    path: toWorkdirRelative(match.path, workdir),
  }))
}

const grepInput = z.object({
  pattern: z
    .string()
    .describe('Regular expression to search for (ripgrep syntax).'),
  path: z
    .string()
    .optional()
    .describe(
      'File or directory to search. Defaults to the session workspace; a relative path resolves against it.',
    ),
  include: z
    .string()
    .optional()
    .describe(
      'One glob filter for which files to search (e.g. "*.ts", "*.{js,jsx}"). Not a list; negation is not supported.',
    ),
})

export function createGrepTool(
  services: ToolServices,
  options: GrepToolOptions = {},
): ToolDefinition<z.output<typeof grepInput>> {
  const maxMatches = options.maxMatches ?? GREP_MAX_MATCHES
  const maxLineBytes = options.maxLineBytes ?? GREP_MAX_LINE_BYTES
  return defineTool({
    name: 'grep',
    description:
      'Search file contents with a ripgrep regular expression. Returns matching lines with line numbers, grouped by file. ' +
      `Returns the first ${maxMatches} matches inline; a capped result reports where the complete match list was saved. ` +
      'Use read on a matched file for surrounding context.',
    input: grepInput,
    timeoutMs: options.timeoutMs ?? SEARCH_TIMEOUT_MS,
    isConcurrencySafe: () => true,
    async execute(args, context) {
      const input = parseGrepArgs(args)
      const all = (
        await grepRawMatches(services, context, options.defaultWorkdir, input)
      ).map((match) => ({
        ...match,
        line: previewLine(match.line, maxLineBytes),
      }))
      if (all.length === 0)
        return {
          content: 'No matches found',
          meta: { matches: 0, truncated: false, files: [] },
        }
      const kept = all.slice(0, maxMatches)
      const truncated = all.length > maxMatches
      const spillRef = truncated
        ? await trySaveFormattedResult(
            services,
            context,
            'grep-results.txt',
            `Found ${all.length} ${matchNoun(all.length)}\n\n${formatGrepMatches(all)}`,
          )
        : undefined
      return {
        content: formatGrepOutput(kept, all.length, spillRef),
        meta: {
          matches: all.length,
          truncated,
          files: [...groupByFile(kept).keys()],
        },
      }
    },
  })
}
