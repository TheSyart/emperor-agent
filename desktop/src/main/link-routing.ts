import {
  browserNavigationAllowed,
  isLocalHostname,
} from './browser-view-policy'

/** The part of `settings.json` › `browser` that routes links. */
export interface LinkPreferences {
  readonly linkTarget: 'system' | 'builtin'
  readonly localTarget: 'builtin' | 'system'
}

export type LinkDestination = 'builtin' | 'system' | 'refuse'

/**
 * Where a web link the user clicked in Emperor's own UI opens. Only such
 * links: the Agent's navigations, downloads and the external browser
 * connection never come here.
 * - http(s) without credentials only; anything else is refused;
 * - an address of this machine follows 本地 URL 打开位置 (the built-in
 *   browser by default; the system browser opens it with its own sign-ins);
 * - any other link follows 网页 URL 和链接打开位置: the system browser (the
 *   default) or the built-in browser.
 */
export function linkDestination(
  url: string,
  preferences: LinkPreferences,
): LinkDestination {
  if (!browserNavigationAllowed(url)) return 'refuse'
  if (isLocalHostname(new URL(url).hostname)) return preferences.localTarget
  return preferences.linkTarget
}
