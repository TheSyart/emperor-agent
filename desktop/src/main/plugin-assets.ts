/**
 * `app://plugin-assets/<scope>/<encoded plugin id>/logo` — plugin logos for
 * the renderer (plugin contract §6.3). The address names a plugin, never a
 * file: Core finds the package, checks the image and hands over its bytes,
 * so the renderer cannot reach any path through it.
 */

const SCOPES = new Set(['user', 'project', 'local', 'managed'])
const PLUGIN_ID = /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)?$/

export type PluginAssetScope = 'user' | 'project' | 'local' | 'managed'

export function pluginAssetRequest(
  url: URL,
): { scope: PluginAssetScope; pluginId: string } | null {
  const parts = url.pathname.split('/').filter(Boolean)
  if (parts.length !== 3 || parts[2] !== 'logo') return null
  const [scope, encoded] = parts as [string, string]
  if (!SCOPES.has(scope)) return null
  let pluginId: string
  try {
    pluginId = decodeURIComponent(encoded)
  } catch {
    return null
  }
  if (!PLUGIN_ID.test(pluginId)) return null
  return { scope: scope as PluginAssetScope, pluginId }
}

export async function pluginAssetResponse(
  url: URL,
  logo: (input: {
    pluginId: string
    scope: PluginAssetScope
  }) => { mime: string; bytes: Buffer } | null,
): Promise<Response> {
  const request = pluginAssetRequest(url)
  const found = request ? logo(request) : null
  if (!found) return new Response('plugin asset not found', { status: 404 })
  return new Response(new Uint8Array(found.bytes), {
    status: 200,
    headers: {
      'content-type': found.mime,
      'x-content-type-options': 'nosniff',
      // The address carries the package digest (`?v=`), so a cached copy never goes stale.
      'cache-control': 'private, max-age=31536000, immutable',
    },
  })
}
