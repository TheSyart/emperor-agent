/**
 * Filesystem discovery tools `glob` and `grep` over ripgrep (ported from
 * dsh-tool-fs-search). The binary is `services.resolveBinary('rg')` when the
 * host provides one (bundled or managed ripgrep), else `rg` on PATH; when it
 * cannot be spawned the tools fall back to the pure-JS engine in
 * `js-engine.ts` with identical output formatting.
 */

import type { SystemPromptAssembler } from '../../../prompt/assembler'
import type { ToolDefinition } from '../../definition'
import type { ToolServices } from '../../services'
import { createGlobTool, GLOB_PROMPT_TEXT, type GlobToolOptions } from './glob'
import { createGrepTool, GREP_PROMPT_TEXT, type GrepToolOptions } from './grep'

export * from './glob'
export * from './grep'
export {
  compileGlob,
  compileGrepRegex,
  jsGlobFiles,
  jsGrepMatches,
  JS_GREP_MAX_FILE_BYTES,
  type JsSearchOptions,
} from './js-engine'
export {
  RAW_OUTPUT_MAX_BYTES,
  isRipgrepUnavailable,
  ripgrepBinary,
  runRipgrep,
  searchAborted,
  SEARCH_GRACE_MS,
  SEARCH_STDERR_MAX_BYTES,
  SEARCH_TIMEOUT_MS,
  SearchError,
  searchWorkdir,
  toWorkdirRelative,
  type RipgrepRun,
  type SearchErrorCode,
} from './ripgrep'

export interface SearchTools {
  glob: ToolDefinition<{ pattern: string; path?: string | undefined }>
  grep: ToolDefinition<{
    pattern: string
    path?: string | undefined
    include?: string | undefined
  }>
}

/** Build both search tools over one set of services. */
export function createSearchTools(
  services: ToolServices,
  options: { glob?: GlobToolOptions; grep?: GrepToolOptions } = {},
): SearchTools {
  return {
    glob: createGlobTool(services, options.glob),
    grep: createGrepTool(services, options.grep),
  }
}

/** Register the `tool:glob` (103) and `tool:grep` (104) prompt sections; returns one disposer. */
export function installSearchPromptSections(
  prompt: SystemPromptAssembler,
): () => void {
  const disposers = [
    prompt.section({ name: 'tool:glob', order: 103, text: GLOB_PROMPT_TEXT }),
    prompt.section({ name: 'tool:grep', order: 104, text: GREP_PROMPT_TEXT }),
  ]
  return () => {
    for (const dispose of disposers) dispose()
  }
}
