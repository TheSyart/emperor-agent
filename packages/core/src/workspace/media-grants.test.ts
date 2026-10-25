import { describe, expect, it } from 'vitest'
import {
  MEDIA_GRANT_TTL_MS,
  WorkspaceMediaGrants,
  workspaceMediaUrl,
} from './media-grants'

// BUG-05: a video in the Files pane plays from app://workspace-media/<token>;
// the token stands for one file Core already resolved, for ten minutes.

const FILE = {
  absPath: '/p/clip.mp4',
  filePath: '/p/clip.mp4',
  streamable: true,
  sessionId: 's1',
  mimeType: 'video/mp4',
}

describe('WorkspaceMediaGrants', () => {
  it('maps a 128-bit random token to the resolved file and reuses it per file', () => {
    let now = 1_000
    const grants = new WorkspaceMediaGrants(() => now)
    const first = grants.grant(FILE)
    expect(first.token).toMatch(/^[0-9a-f]{32}$/)
    expect(first).toEqual({
      ...FILE,
      token: first.token,
      expiresAt: 1_000 + MEDIA_GRANT_TTL_MS,
    })
    expect(grants.lookup(first.token)).toEqual(first)
    now += 60_000
    expect(grants.grant(FILE).token).toBe(first.token)
    // Another file, or the same file for another session: another token.
    const other = grants.grant({ ...FILE, absPath: '/p/other.mp4' })
    expect(other.token).not.toBe(first.token)
    expect(grants.grant({ ...FILE, sessionId: 's2' }).token).not.toBe(
      first.token,
    )
    // The same file named for opening only: a grant of its own.
    expect(grants.grant({ ...FILE, streamable: false }).token).not.toBe(
      first.token,
    )
    expect(workspaceMediaUrl(first.token)).toBe(
      `app://workspace-media/${first.token}`,
    )
  })

  it('BUG-05 4 · forgets a token after ten minutes, then grants a new one', () => {
    let now = 0
    const grants = new WorkspaceMediaGrants(() => now)
    const first = grants.grant(FILE)
    now = MEDIA_GRANT_TTL_MS - 1
    expect(grants.lookup(first.token)).not.toBeNull()
    now = MEDIA_GRANT_TTL_MS
    expect(grants.lookup(first.token)).toBeNull()
    const second = grants.grant(FILE)
    expect(second.token).not.toBe(first.token)
    expect(second.expiresAt).toBe(MEDIA_GRANT_TTL_MS * 2)
  })

  it('knows no token it did not issue', () => {
    const grants = new WorkspaceMediaGrants()
    grants.grant(FILE)
    expect(grants.lookup('0'.repeat(32))).toBeNull()
    expect(grants.lookup('')).toBeNull()
    expect(grants.lookup('../clip.mp4')).toBeNull()
  })
})
