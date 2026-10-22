/**
 * The protected-path table (sandbox/protected-state.ts) for one `grep` or
 * `glob` call. ripgrep runs outside the Shell sandbox and the JS fallback
 * reads files directly, so the search tools hold the line themselves: a
 * root inside a protected path is refused, and a wider root (the home
 * directory, Emperor Home itself) keeps everything except what lies in one.
 * Emperor's private state and config files are left out in every mode; the
 * user's credential files only outside danger-full-access (searches offer
 * no escalation: `read` with `sandbox_permissions` reads one file).
 */

import { homedir } from 'node:os'
import { resolve } from 'node:path'
import {
  classifyProtectedPath,
  entryCovers,
  PROTECTED_CONFIG_REASON,
  PROTECTED_STATE_REASON,
  protectedEntriesUnder,
  type ProtectedPathClass,
} from '../../../sandbox/protected-state'
import type { ToolRunContext } from '../../definition'
import type { ToolServices } from '../../services'
import { SearchError, searchWorkdir } from './ripgrep'

const REASONS: Record<ProtectedPathClass, string> = {
  state: PROTECTED_STATE_REASON,
  config: PROTECTED_CONFIG_REASON,
  credential:
    'it holds the user\'s credentials (SSH, cloud, Docker, netrc, Codex or Claude logins), which searches do not read outside danger-full-access; to read one file, use read with sandbox_permissions="danger-full-access" and a justification (the user approves it)',
}

/** Which raw result paths (as the engine printed them) the search may show. */
export async function protectedStateFilter(
  services: Pick<
    ToolServices,
    'protectedStateRoot' | 'protectedHome' | 'sandbox'
  >,
  context: Pick<ToolRunContext, 'agent'>,
  defaultWorkdir: string | undefined,
  toolName: 'grep' | 'glob',
  path: string | undefined,
): Promise<(rawPath: string) => boolean> {
  const stateRoot = services.protectedStateRoot
  if (stateRoot === undefined) return () => true
  const scope = { stateRoot, home: services.protectedHome ?? homedir() }
  const session = context.agent?.session
  const mode = services.sandbox?.resolve(
    session === undefined ? {} : { session },
  ).mode
  const classes: ProtectedPathClass[] =
    mode === 'danger-full-access'
      ? ['state', 'config']
      : ['state', 'config', 'credential']
  const workdir = searchWorkdir(context, defaultWorkdir)
  const root = resolve(workdir, path ?? '.')
  const found = await classifyProtectedPath(root, scope)
  if (found !== null && classes.includes(found))
    throw new SearchError(
      `${toolName} cannot search "${root}": ${REASONS[found]}`,
      'SEARCH_PROTECTED_PATH',
    )
  // Neither engine follows symlinks below the root, so a result lies in a
  // protected path exactly when its path does, spelled under the root.
  const hidden = await protectedEntriesUnder(root, scope, classes)
  if (hidden.length === 0) return () => true
  return (rawPath) => {
    const absolute = resolve(workdir, rawPath)
    return !hidden.some((entry) => entryCovers(entry, absolute))
  }
}
