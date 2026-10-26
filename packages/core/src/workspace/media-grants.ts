import { randomBytes } from 'node:crypto'

/**
 * Grants for the Files pane (BUG-05, BUG-10). files.mediaUrl resolves a
 * file under the same checks as files.preview and hands the renderer
 * `app://workspace-media/<token>`; main looks the token up (files.mediaGrant,
 * main only). A streamable grant serves `absPath` — the file, or the PNG or
 * first page Core made of it; every grant names `filePath`, the file itself,
 * for 用默认应用打开 and 在访达中显示. The address carries no path, so nothing
 * the renderer puts in a request can name another file. A grant lasts ten
 * minutes; asking again for the same thing returns the grant still running.
 */

export const MEDIA_GRANT_TTL_MS = 10 * 60_000

export interface MediaGrant {
  /** 128 random bits, hex. */
  token: string
  /** What is served: the file, or a preview Core made of it. */
  absPath: string
  /** The canonical path of the file itself, resolved when the grant was made. */
  filePath: string
  /** Whether main serves `absPath`; otherwise the grant only names the file. */
  streamable: boolean
  sessionId: string
  mimeType: string
  expiresAt: number
}

export function workspaceMediaUrl(token: string): string {
  return `app://workspace-media/${token}`
}

export class WorkspaceMediaGrants {
  private readonly byToken = new Map<string, MediaGrant>()
  /** What a grant is for → its token. */
  private readonly byFile = new Map<string, string>()

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly ttlMs = MEDIA_GRANT_TTL_MS,
  ) {}

  grant(input: Omit<MediaGrant, 'token' | 'expiresAt'>): MediaGrant {
    this.prune()
    const key = keyOf(input)
    const running = this.byToken.get(this.byFile.get(key) ?? '')
    if (running) return running
    const grant: MediaGrant = {
      token: randomBytes(16).toString('hex'),
      absPath: input.absPath,
      filePath: input.filePath,
      streamable: input.streamable,
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
      this.byFile.delete(keyOf(grant))
    }
  }
}

function keyOf(grant: Omit<MediaGrant, 'token' | 'expiresAt'>): string {
  return [
    grant.sessionId,
    grant.absPath,
    grant.filePath,
    grant.streamable,
    grant.mimeType,
  ].join('\0')
}
