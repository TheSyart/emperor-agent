/**
 * Hardening shared by every browser session Emperor creates — the user's
 * embedded browser and the Agent's task profiles: no site permissions, no
 * device access, no downloads (the Agent download inbox opts in per
 * session later), applied once per session.
 */

import type { DownloadItem, Event, Session, WebContents } from 'electron'

const hardenedSessions = new WeakSet<Session>()

export interface HardenOptions {
  /** Agent sessions route downloads to the inbox; the default cancels all. */
  onDownload?(
    event: Event,
    item: DownloadItem,
    contents: WebContents | undefined,
  ): void
  /**
   * Agent sessions: a site permission the user allowed for this origin and
   * profile. `mediaTypes` lists 'video' / 'audio' for `media`. Default: deny.
   */
  allowPermission?(
    contents: WebContents | null,
    permission: string,
    origin: string,
    mediaTypes: readonly string[],
  ): boolean
}

function originOf(url: string | undefined): string {
  try {
    return url === undefined ? '' : new URL(url).origin
  } catch {
    return ''
  }
}

export function hardenSession(
  session: Session,
  options: HardenOptions = {},
): void {
  if (hardenedSessions.has(session)) return
  hardenedSessions.add(session)
  const allow = options.allowPermission
  session.setPermissionRequestHandler(
    (contents, permission, callback, details) => {
      if (allow === undefined) return callback(false)
      const media = 'mediaTypes' in details ? (details.mediaTypes ?? []) : []
      const origin = originOf(details.requestingUrl)
      try {
        callback(allow(contents, permission, origin, media))
      } catch {
        callback(false)
      }
    },
  )
  session.setPermissionCheckHandler(
    (contents, permission, requestingOrigin, details) => {
      if (allow === undefined) return false
      const media =
        'mediaType' in details &&
        details.mediaType !== undefined &&
        details.mediaType !== 'unknown'
          ? [details.mediaType]
          : []
      try {
        return allow(contents, permission, originOf(requestingOrigin), media)
      } catch {
        return false
      }
    },
  )
  session.setDevicePermissionHandler(() => false)
  const onDownload = options.onDownload
  session.on('will-download', (event, item, contents) => {
    if (onDownload === undefined) event.preventDefault()
    else onDownload(event, item, contents)
  })
}

export function isHardened(session: Session): boolean {
  return hardenedSessions.has(session)
}
