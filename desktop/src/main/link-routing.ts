import {
  browserNavigationAllowed,
  isLocalHostname,
} from './browser-view-policy'

/** The part of `settings.json` › `browser` that routes links. */
export interface LinkPreferences {
  readonly enabled: boolean
  readonly linkTarget: 'system' | 'builtin'
}

export type LinkDestination = 'builtin' | 'system' | 'refuse'

/**
 * Where a web link the user clicked in Emperor's own UI opens. Only such
 * links: the Agent's navigations, downloads and the external browser
 * connection never come here.
 * - http(s) without credentials only; anything else is refused;
 * - an address of this machine is never handed to the system browser
 *   (`browser-view-policy`): it opens in the built-in browser when that is
 *   on, and is refused otherwise;
 * - any other link follows the user's choice: the system browser (the
 *   default) or the built-in browser.
 */
export function linkDestination(
  url: string,
  preferences: LinkPreferences,
): LinkDestination {
  if (!browserNavigationAllowed(url)) return 'refuse'
  if (isLocalHostname(new URL(url).hostname))
    return preferences.enabled ? 'builtin' : 'refuse'
  return preferences.enabled && preferences.linkTarget === 'builtin'
    ? 'builtin'
    : 'system'
}
