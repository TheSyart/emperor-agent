/**
 * The model-facing `glob` tool (ported from dsh-tool-fs-search `glob`):
 * discover files whose paths match a glob pattern via `rg --files`, newest
 * modification first. A result over the inline cap keeps the
 * modification-time head (the dsh preset `sampleOverCapGlobResults: false`)
 * and reports where the complete sorted list was saved.
 */

import { z } from 'zod'
import {
  defineTool,
  ToolError,
  type ToolDefinition,
  type ToolRunContext,
} from '../../definition'
import type { ToolServices } from '../../services'
import type { SpillRef } from '../../spill'
import { jsGlobFiles, type GlobInput } from './js-engine'

export type { GlobInput } from './js-engine'
import {
  isRipgrepUnavailable,
  runRipgrep,
  SEARCH_TIMEOUT_MS,
  searchWorkdir,
  toWorkdirRelative,
  trySaveFormattedResult,
} from './ripgrep'

/** Cap on paths returned inline by one `glob` call. */
export const GLOB_MAX_RESULTS = 100

/** VCS metadata directories never listed (`--no-ignore --hidden` would otherwise surface them). */
export const GLOB_VCS_EXCLUDES: readonly string[] = [
  '.git',
  '.svn',
  '.hg',
  '.bzr',
  '.jj',
  '.sl',
]

/** System-prompt guidance for `glob` (order 103). */
export const GLOB_PROMPT_TEXT =
  'Use the glob tool — not shell find — to discover files by path pattern. A pattern with no "/" matches basenames at any depth, so "*" matches every file in the tree rather than its top level. ' +
  'Results are files only, never directories, and include hidden and ignored files: a result that fits comes back in modification-time order, while a larger one keeps the modification-time-ordered head.'

export interface GlobToolOptions {
  /** Inline path cap (default {@link GLOB_MAX_RESULTS}). */
  maxResults?: number
  /** Tool-call timeout in ms (default 30000). */
  timeoutMs?: number
  /** Workdir for host-initiated calls with no calling agent (default `process.cwd()`). */
  defaultWorkdir?: string
}

/** Reject a blank pattern or a blank path. */
export function parseGlobArgs(args: {
  pattern: string
  path?: string | undefined
}): GlobInput {
  if (args.pattern.trim().length === 0)
    throw new ToolError('pattern must be a non-empty string', 'INVALID_ARGS')
  if (args.path !== undefined && args.path.trim().length === 0)
    throw new ToolError(
      'path must be a non-empty string when given',
      'INVALID_ARGS',
    )
  return {
    pattern: args.pattern,
    ...(args.path !== undefined ? { path: args.path } : {}),
  }
}

/**
 * The fixed `rg --files` argv. Model values are plain argv elements (no
 * shell); the search root rides behind `--`. `--sortr=modified` lists newest
 * first; two negated globs per VCS name prune the directory and still exclude
 * its contents when the search root is at or inside it.
 */
export function buildGlobCommand(input: GlobInput): string[] {
  const parts = [
    '--files',
    `--glob=${input.pattern}`,
    '--sortr=modified',
    '--no-ignore',
    '--hidden',
    ...GLOB_VCS_EXCLUDES.flatMap((name) => [
      `--glob=!**/${name}`,
      `--glob=!**/${name}/**`,
    ]),
  ]
  if (input.path !== undefined) parts.push('--', input.path)
  return parts
}

/** Format one bounded page and the recovery path for its complete sorted result. */
export function formatGlobPage(
  items: readonly string[],
  seen: number,
  spillRef: SpillRef | undefined,
): string {
  const recovery =
    spillRef !== undefined
      ? `Full sorted result stored at: ${spillRef.path}. ${spillRef.retrievalHint}`
      : 'The complete result could not be saved; narrow pattern or path to see more.'
  return `${items.join('\n')}\n\n(Showing ${items.length} of ${seen} paths. ${recovery})`
}

/**
 * Matching paths, workdir-relative, newest first: from `rg --files`, or from
 * the pure-JS engine (same raw path shape and order) when the ripgrep binary
 * cannot be spawned.
 */
async function globPaths(
  services: ToolServices,
  context: ToolRunContext,
  defaultWorkdir: string | undefined,
  input: GlobInput,
): Promise<string[]> {
  let raw: string[]
  let workdir: string
  try {
    const run = await runRipgrep(
      services,
      context,
      'glob',
      buildGlobCommand(input),
      { defaultWorkdir },
    )
    workdir = run.workdir
    raw = run.noMatches
      ? []
      : run.stdout.split('\n').filter((line) => line.length > 0)
  } catch (error: unknown) {
    if (!isRipgrepUnavailable(error)) throw error
    workdir = searchWorkdir(context, defaultWorkdir)
    raw = await jsGlobFiles(input, { workdir, signal: context.signal })
  }
  return raw.map((line) => toWorkdirRelative(line, workdir))
}

const globInput = z.object({
  pattern: z
    .string()
    .describe(
      'Glob pattern to match file paths against (e.g. "**/*.ts", "src/**/*.test.js"). ' +
        'A pattern with no "/" matches the basename at any depth, so "*" and "*.ts" both search the whole tree; include a separator to anchor the depth.',
    ),
  path: z
    .string()
    .optional()
    .describe(
      'Directory to search in. Defaults to the session workspace; a relative path resolves against it.',
    ),
})

export function createGlobTool(
  services: ToolServices,
  options: GlobToolOptions = {},
): ToolDefinition<z.output<typeof globInput>> {
  const maxResults = options.maxResults ?? GLOB_MAX_RESULTS
  return defineTool({
    name: 'glob',
    description:
      'Find files whose paths match a glob pattern. Returns matching file paths — never directories — ' +
      'including hidden and ignored files (VCS metadata directories are excluded). ' +
      `Up to ${maxResults} paths come back in modification-time order (newest first); a larger result returns the first ${maxResults} paths in modification-time order, ` +
      'says so, and reports where the complete sorted list was saved. This tool does not enumerate directory entries.',
    input: globInput,
    timeoutMs: options.timeoutMs ?? SEARCH_TIMEOUT_MS,
    isConcurrencySafe: () => true,
    async execute(args, context) {
      const input = parseGlobArgs(args)
      const paths = await globPaths(
        services,
        context,
        options.defaultWorkdir,
        input,
      )
      if (paths.length === 0)
        return {
          content: 'No files found',
          meta: { matches: 0, truncated: false, files: [] },
        }
      if (paths.length <= maxResults) {
        return {
          content: paths.join('\n'),
          meta: { matches: paths.length, truncated: false, files: paths },
        }
      }
      const page = paths.slice(0, maxResults)
      const spillRef = await trySaveFormattedResult(
        services,
        context,
        'glob-results.txt',
        paths.join('\n'),
      )
      return {
        content: formatGlobPage(page, paths.length, spillRef),
        meta: { matches: paths.length, truncated: true, files: page },
      }
    },
  })
}
