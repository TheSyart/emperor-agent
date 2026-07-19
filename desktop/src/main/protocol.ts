import * as fs from 'node:fs'
import * as path from 'node:path'

const TRUSTED_CROSS_ORIGIN: Readonly<Record<string, string>> = {
  attachments: 'app://bundle',
  media: 'app://bundle',
  bundle: 'app://bundle',
  pet: 'app://pet',
  'pet-assets': 'app://pet',
}

export function appAssetRequestAccess(
  host: string,
  origin: string | null,
): { allowed: boolean; allowOrigin: string | null } {
  if (!origin) return { allowed: true, allowOrigin: null }
  const normalized = origin.trim().replace(/\/+$/, '')
  const expected = TRUSTED_CROSS_ORIGIN[host] ?? null
  if (!expected || normalized !== expected)
    return { allowed: false, allowOrigin: null }
  return { allowed: true, allowOrigin: expected }
}

// Map an app:// request pathname to a file inside the bundled renderer.
//
// Rules:
// - root ("/") and any extensionless path (a Vue history-mode route such as
//   "/chat" or "/skills/foo") resolve to index.html (SPA fallback).
// - paths with a file extension resolve to that file under rendererRoot.
// - anything that escapes rendererRoot (directory traversal) falls back to
//   index.html rather than leaking host files.
export function resolveAssetPath(
  requestPath: string,
  rendererRoot: string,
): string {
  const indexHtml = path.join(rendererRoot, 'index.html')

  let rel: string
  try {
    rel = decodeURIComponent(requestPath)
  } catch {
    return indexHtml
  }
  rel = rel.replace(/^\/+/, '')
  if (rel === '') return indexHtml

  const resolved = path.resolve(rendererRoot, rel)
  const rootWithSep = rendererRoot.endsWith(path.sep)
    ? rendererRoot
    : rendererRoot + path.sep
  if (resolved !== rendererRoot && !resolved.startsWith(rootWithSep)) {
    return indexHtml
  }

  if (!path.extname(resolved)) return indexHtml
  return resolved
}

export function resolveStaticAssetPath(
  requestPath: string,
  resourceRoot: string,
): string | null {
  let rel: string
  try {
    rel = decodeURIComponent(requestPath).replace(/^\/+/, '')
  } catch {
    return null
  }
  if (!rel) return null
  const resolved = path.resolve(resourceRoot, rel)
  const rootWithSep = resourceRoot.endsWith(path.sep)
    ? resourceRoot
    : resourceRoot + path.sep
  if (!resolved.startsWith(rootWithSep) || !path.extname(resolved)) return null
  return resolved
}

export interface RawMediaRoots {
  stateRoot: string
  /** Read-only legacy fallback: pre-global-store installs kept attachments/media under
   * `runtimeRoot/memory/...`. Never written to, never migrated here — Task 7's migration
   * handles the one-time copy; this is just so existing links keep resolving until then. */
  legacyRuntimeRoot?: string | null
}

function findRawFile(
  dir: string,
  hash8: string,
  opts: { excludeTxt?: boolean } = {},
): string | null {
  let names: string[]
  try {
    names = fs.readdirSync(dir).sort()
  } catch {
    return null
  }
  for (const name of names) {
    if (!name.startsWith(`${hash8}-`)) continue
    if (opts.excludeTxt && name.endsWith('.txt')) continue
    const candidate = path.resolve(dir, name)
    const dirWithSep = dir.endsWith(path.sep) ? dir : dir + path.sep
    if (!candidate.startsWith(dirWithSep)) continue
    try {
      if (fs.statSync(candidate).isFile()) return candidate
    } catch {
      // Try the next candidate.
    }
  }
  return null
}

export function resolveAttachmentRawPath(
  requestUrl: string,
  roots: RawMediaRoots,
): string | null {
  let url: URL
  try {
    url = new URL(requestUrl)
  } catch {
    return null
  }
  if (url.protocol !== 'app:' || url.host !== 'attachments') return null
  const parts = url.pathname
    .split('/')
    .filter(Boolean)
    .map((part) => {
      try {
        return decodeURIComponent(part)
      } catch {
        return ''
      }
    })
  if (parts.length !== 2 || parts[1] !== 'raw') return null
  const match = /^att_(\d{4}-\d{2})_([0-9a-f]{8})$/.exec(parts[0] || '')
  if (!match) return null
  const [, month, hash8] = match
  const found = findRawFile(
    path.join(roots.stateRoot, 'memory', 'attachments', month!),
    hash8!,
    { excludeTxt: true },
  )
  if (found) return found
  if (!roots.legacyRuntimeRoot) return null
  return findRawFile(
    path.join(roots.legacyRuntimeRoot, 'memory', 'attachments', month!),
    hash8!,
    { excludeTxt: true },
  )
}

export function resolveMediaRawPath(
  requestUrl: string,
  roots: RawMediaRoots,
): string | null {
  let url: URL
  try {
    url = new URL(requestUrl)
  } catch {
    return null
  }
  if (url.protocol !== 'app:' || url.host !== 'media') return null
  const parts = url.pathname
    .split('/')
    .filter(Boolean)
    .map((part) => {
      try {
        return decodeURIComponent(part)
      } catch {
        return ''
      }
    })
  if (parts.length !== 2 || parts[1] !== 'raw') return null
  const match = /^media_(\d{4}-\d{2})_([0-9a-f]{8})$/.exec(parts[0] || '')
  if (!match) return null
  const [, month, hash8] = match
  const found = findRawFile(
    path.join(roots.stateRoot, 'memory', 'media', month!),
    hash8!,
  )
  if (found) return found
  if (!roots.legacyRuntimeRoot) return null
  return findRawFile(
    path.join(roots.legacyRuntimeRoot, 'memory', 'media', month!),
    hash8!,
  )
}
