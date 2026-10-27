/**
 * `app://skin/<id>/<file>` — a skin's slot pictures for the main window
 * (BRD-05). The address names a skin and a plain picture name; the store
 * decides whether that is one of the skin's slot pictures and hands over
 * checked bytes, so no address reaches any other file. Read-only: only GET.
 */
import { SKIN_ID_PATTERN } from '../../shared/skin-contract'

const FILE = /^[A-Za-z0-9][\w.-]{0,63}\.(?:png|webp)$/

export type SkinAssetLookup = (
  id: string,
  file: string,
) => { mime: string; bytes: Buffer } | null

export function skinAssetRequest(
  url: URL,
): { id: string; file: string } | null {
  if (url.host !== 'skin') return null
  const raw = url.pathname.split('/').filter(Boolean)
  if (raw.length !== 2) return null
  let id: string
  let file: string
  try {
    id = decodeURIComponent(raw[0]!)
    file = decodeURIComponent(raw[1]!)
  } catch {
    return null
  }
  if (!SKIN_ID_PATTERN.test(id) || !FILE.test(file) || file.includes('..'))
    return null
  return { id, file }
}

export async function skinAssetResponse(
  request: Request,
  lookup: SkinAssetLookup,
): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD')
    return new Response('read only', { status: 405 })
  const target = skinAssetRequest(new URL(request.url))
  const found = target ? lookup(target.id, target.file) : null
  if (!found) return new Response('skin asset not found', { status: 404 })
  return new Response(
    request.method === 'HEAD' ? null : new Uint8Array(found.bytes),
    {
      status: 200,
      headers: {
        'content-type': found.mime,
        'x-content-type-options': 'nosniff',
        // The address carries a version of the file (`?v=`).
        'cache-control': 'private, max-age=31536000, immutable',
      },
    },
  )
}
