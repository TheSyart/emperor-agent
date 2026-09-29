/**
 * URL policy for Agent-controlled tabs (spec 00 §7.4). Pure functions; the
 * browser session manager applies them at three points so no navigation
 * slips through: before the Agent's own loads and history moves, in the
 * page's `will-*` navigation events, and in `webRequest` for main-frame
 * and sub-frame requests (redirects included).
 *
 * - Main frames: credential-free http(s) only; loopback and LAN are ordinary
 *   origins (decision D3). Whether the origin is allowed is the kernel's
 *   call (grants / full access), passed in as `kernel`.
 * - Sub-frames: web content plus `about:blank`, `about:srcdoc`, `data:` and
 *   `blob:` documents; never local files or browser-internal pages. A page
 *   may load any frame, but actions on an element inside a cross-origin
 *   frame are authorised for that frame's origin (the snapshot tags such
 *   elements with `frameOrigin`).
 */

import type { NavigationPolicy } from '@emperor/core/host-capabilities'
import { browserNavigationAllowed } from '../browser-view-policy'

const SUBFRAME_SCHEMES = new Set(['http:', 'https:', 'data:', 'blob:'])

/** Sub-frame documents a page may load. */
export function subframeNavigationAllowed(target: unknown): boolean {
  if (typeof target !== 'string') return false
  if (target === 'about:blank' || target === 'about:srcdoc') return true
  let url: URL
  try {
    url = new URL(target)
  } catch {
    return false
  }
  if (!SUBFRAME_SCHEMES.has(url.protocol)) return false
  if (url.protocol === 'http:' || url.protocol === 'https:')
    return browserNavigationAllowed(target)
  return true
}

export interface AgentNavigation {
  readonly targetId: string
  readonly url: string
  readonly frame: 'main' | 'sub'
  readonly initiator: 'agent' | 'page'
  readonly ownerSessionId?: string
  readonly profileId?: string
}

/** Combine the fixed URL rules with the kernel's origin verdict. */
export function decideAgentNavigation(
  navigation: AgentNavigation,
  kernel: NavigationPolicy | null,
): 'allow' | 'block' {
  if (navigation.frame === 'sub')
    return subframeNavigationAllowed(navigation.url) ? 'allow' : 'block'
  if (!browserNavigationAllowed(navigation.url)) return 'block'
  if (kernel === null) return 'block'
  try {
    return kernel(navigation) === 'allow' ? 'allow' : 'block'
  } catch {
    return 'block'
  }
}
