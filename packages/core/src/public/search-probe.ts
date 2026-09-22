/**
 * Host-side probe over the model-facing `glob` / `grep` tool implementations
 * (ripgrep when it can be spawned, else the pure-JS fallback engine). Used by
 * packaged smoke checks to prove file search works in a shipped build.
 */

import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import {
  createSearchTools,
  SEARCH_TIMEOUT_MS,
} from '../harness/tools/builtin/search/index'
import type { ToolReturn, ToolRunContext } from '../harness/tools/definition'
import type { ToolServices } from '../harness/tools/services'

export interface SearchProbeRequest {
  kind: 'glob' | 'grep'
  pattern: string
  /** Optional ripgrep binary path; omitted → `rg` on PATH, else the JS fallback. */
  ripgrepPath?: string
}

function contentText(result: ToolReturn): string {
  const content =
    typeof result === 'string' || Array.isArray(result)
      ? result
      : result.content
  if (typeof content === 'string') return content
  return content
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('')
}

/** `/`-separate path lines so the probe output is platform-stable. */
function portablePaths(text: string): string {
  if (sep === '/') return text
  return text
    .split('\n')
    .map((line) =>
      line.startsWith('Line ') ||
      line.startsWith('Found ') ||
      line.startsWith('(')
        ? line
        : line.split(sep).join('/'),
    )
    .join('\n')
}

/**
 * Run one `glob` or `grep` call rooted at `workspaceRoot` and return the
 * model-facing text (paths workspace-relative, `/`-separated). A tool failure
 * comes back as an `[ERR] …` line instead of throwing.
 */
export async function searchProbe(
  workspaceRoot: string,
  request: SearchProbeRequest,
): Promise<string> {
  const root = resolve(workspaceRoot)
  const services: ToolServices = {
    spillRoot: join(tmpdir(), 'emperor-search-probe'),
    ...(request.ripgrepPath !== undefined
      ? { resolveBinary: () => request.ripgrepPath }
      : {}),
  } as ToolServices
  const tools = createSearchTools(services, {
    glob: { defaultWorkdir: root },
    grep: { defaultWorkdir: root },
  })
  const tool = request.kind === 'glob' ? tools.glob : tools.grep
  const raw = { pattern: request.pattern }
  const context: ToolRunContext = {
    callId: `search-probe-${request.kind}`,
    name: request.kind,
    arguments: raw,
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    deferContext: () => undefined,
    concludeTurn: () => undefined,
  }
  try {
    const result = await tool.execute(tool.parse(raw), context)
    return portablePaths(contentText(result))
  } catch (error: unknown) {
    return `[ERR] ${error instanceof Error ? error.message : String(error)}`
  }
}
