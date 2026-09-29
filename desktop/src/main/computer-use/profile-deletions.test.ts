import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ProfileDeletionQueue } from './profile-deletions'

describe('ProfileDeletionQueue', () => {
  it('removes a deleted profile that Electron recreated after the previous process exited', async () => {
    const root = mkdtempSync(join(tmpdir(), 'emperor-profile-deletions-'))
    const id = 'p_0123456789ab'
    const queue = new ProfileDeletionQueue(root)
    await queue.mark(id)
    const path = join(root, id)
    mkdirSync(join(path, 'Cache'), { recursive: true })
    writeFileSync(join(path, 'Cache', 'remaining'), 'cache')

    await new ProfileDeletionQueue(root).reconcile()

    expect(existsSync(path)).toBe(false)
    expect(existsSync(join(root, `.delete-${id}`))).toBe(false)
  })

  it('only follows valid deletion markers and leaves other profiles intact', async () => {
    const root = mkdtempSync(join(tmpdir(), 'emperor-profile-deletions-'))
    const live = join(root, 'p_aaaaaaaaaaaa')
    mkdirSync(live)
    writeFileSync(join(live, 'data'), 'keep')
    writeFileSync(join(root, '.delete-p_invalid'), 'ignored')

    await new ProfileDeletionQueue(root).reconcile()

    expect(readFileSync(join(live, 'data'), 'utf8')).toBe('keep')
    expect(existsSync(join(root, '.delete-p_invalid'))).toBe(true)
  })
})
