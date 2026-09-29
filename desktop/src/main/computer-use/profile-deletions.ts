/**
 * Electron can recreate a profile's Cache directory during shutdown after
 * `session.fromPath` was cleared and its directory removed. A deletion
 * marker survives that process, then the next app launch removes any
 * remnants before that profile path can be used again.
 */
import { mkdir, readdir, rm, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const PROFILE_ID = /^p_[0-9a-f]{12}$/
const MARKER = /^\.delete-(p_[0-9a-f]{12})$/

export class ProfileDeletionQueue {
  constructor(private readonly root: string) {}

  async mark(profileId: string): Promise<void> {
    if (!PROFILE_ID.test(profileId))
      throw new Error('invalid browser profile id')
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    try {
      await writeFile(join(this.root, `.delete-${profileId}`), '', {
        flag: 'wx',
        mode: 0o600,
      })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }

  async reconcile(): Promise<void> {
    let entries: string[]
    try {
      entries = await readdir(this.root)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    for (const entry of entries) {
      const match = MARKER.exec(entry)
      if (match === null) continue
      await rm(join(this.root, match[1]!), { recursive: true, force: true })
      await unlink(join(this.root, entry))
    }
  }
}
