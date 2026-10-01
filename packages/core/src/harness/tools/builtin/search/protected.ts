/**
 * Emperor's private state (sandbox/protected-state.ts) for one `grep` or
 * `glob` call. ripgrep runs outside the Shell sandbox and the JS fallback
 * reads files directly, so the search tools hold the line themselves: a root
 * inside that state is refused, and a wider root (the home directory, Emperor
 * Home itself) keeps everything except what lies in it.
 */

import { resolve } from 'node:path'
import {
  isLexicallyInside,
  isProtectedStatePath,
  PROTECTED_STATE_REASON,
  protectedStateDirsUnder,
} from '../../../sandbox/protected-state'
import type { ToolRunContext } from '../../definition'
import type { ToolServices } from '../../services'
import { SearchError, searchWorkdir } from './ripgrep'

/** Which raw result paths (as the engine printed them) the search may show. */
export async function protectedStateFilter(
  services: Pick<ToolServices, 'protectedStateRoot'>,
  context: Pick<ToolRunContext, 'agent'>,
  defaultWorkdir: string | undefined,
  toolName: 'grep' | 'glob',
  path: string | undefined,
): Promise<(rawPath: string) => boolean> {
  const stateRoot = services.protectedStateRoot
  if (stateRoot === undefined) return () => true
  const workdir = searchWorkdir(context, defaultWorkdir)
  const root = resolve(workdir, path ?? '.')
  if (await isProtectedStatePath(root, stateRoot))
    throw new SearchError(
      `${toolName} cannot search "${root}": ${PROTECTED_STATE_REASON}`,
      'SEARCH_PROTECTED_PATH',
    )
  // Neither engine follows symlinks below the root, so a result lies in a
  // protected directory exactly when its path does, spelled under the root.
  const hidden = await protectedStateDirsUnder(root, stateRoot)
  if (hidden.length === 0) return () => true
  return (rawPath) => {
    const absolute = resolve(workdir, rawPath)
    return !hidden.some((dir) => isLexicallyInside(absolute, dir))
  }
}
