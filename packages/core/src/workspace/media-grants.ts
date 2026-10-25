import { randomBytes } from 'node:crypto'

/**
 * Playback grants for videos in the Files pane (BUG-05). files.mediaUrl
 * resolves a file under the same checks as files.preview and hands the
 * renderer `app://workspace-media/<token>`; main looks the token up
 * (files.mediaGrant, main only) and streams that exact path. The address
 * carries no path, so nothing the renderer puts in a request can name
 * another file. A grant lasts ten minutes; asking again for the same file
 * of the same session returns the grant still running.
 */

export const MEDIA_GRANT_TTL_MS = 10 * 60_000

export interface MediaGrant {
  /** 128 random bits, hex. */
  token: string
  /** The canonical absolute path resolved when the grant was made. */
  absPath: string
  sessionId: string
  mimeType: string
  expiresAt: number
}

export function workspaceMediaUrl(token: string): string {
  return `app://workspace-media/${token}`
}

export class WorkspaceMediaGrants {
  private readonly byToken = new Map<string, MediaGrant>()
  /** `${sessionId}\0${absPath}` → token. */
  private readonly byFile = new Map<string, string>()

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly ttlMs = MEDIA_GRANT_TTL_MS,
  ) {}

  grant(input: {
    absPath: string
    sessionId: string
    mimeType: string
  }): MediaGrant {
    this.prune()
    const key = `${input.sessionId}\0${input.absPath}`
    const running = this.byToken.get(this.byFile.get(key) ?? '')
    if (running) return running
    const grant: MediaGrant = {
      token: randomBytes(16).toString('hex'),
      absPath: input.absPath,
      sessionId: input.sessionId,
      mimeType: input.mimeType,
      expiresAt: this.now() + this.ttlMs,
    }
    this.byToken.set(grant.token, grant)
    this.byFile.set(key, grant.token)
    return grant
  }

  /** The grant behind a token; null once it expired or was never made. */
  lookup(token: string): MediaGrant | null {
    this.prune()
    return this.byToken.get(token) ?? null
  }

  private prune(): void {
    const now = this.now()
    for (const [token, grant] of this.byToken) {
      if (grant.expiresAt > now) continue
      this.byToken.delete(token)
      this.byFile.delete(`${grant.sessionId}\0${grant.absPath}`)
    }
  }
}
