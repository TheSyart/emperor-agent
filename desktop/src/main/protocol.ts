import * as path from 'node:path'

// Map an app:// request pathname to a file inside the bundled renderer.
//
// Rules:
// - root ("/") and any extensionless path (a Vue history-mode route such as
//   "/chat" or "/skills/foo") resolve to index.html (SPA fallback).
// - paths with a file extension resolve to that file under rendererRoot.
// - anything that escapes rendererRoot (directory traversal) falls back to
//   index.html rather than leaking host files.
export function resolveAssetPath(requestPath: string, rendererRoot: string): string {
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
  const rootWithSep = rendererRoot.endsWith(path.sep) ? rendererRoot : rendererRoot + path.sep
  if (resolved !== rendererRoot && !resolved.startsWith(rootWithSep)) {
    return indexHtml
  }

  if (!path.extname(resolved)) return indexHtml
  return resolved
}
