// Atomic-write mechanics: staging outside the target tree, and the
// same-directory fallback that keeps publication a single rename.
import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** One injected rename failure, consumed by the next publication attempt. */
const injected = vi.hoisted(() => ({
  renameCode: null as string | null,
  renamed: [] as string[],
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    async rename(from: string, to: string): Promise<void> {
      injected.renamed.push(from)
      const code = injected.renameCode
      if (code === null) return await actual.rename(from, to)
      injected.renameCode = null
      const error = new Error(`simulated ${code}`) as NodeJS.ErrnoException
      error.code = code
      throw error
    },
  }
})

const { writeFileAtomic } = await import('./fsio')

let root: string
let staging: string

beforeEach(() => {
  injected.renamed = []
  root = realpathSync(mkdtempSync(join(tmpdir(), 'emperor-fsio-')))
  staging = realpathSync(mkdtempSync(join(tmpdir(), 'emperor-fsio-staging-')))
})

afterEach(() => {
  injected.renameCode = null
  rmSync(root, { recursive: true, force: true })
  rmSync(staging, { recursive: true, force: true })
})

const modeOf = (path: string): number => statSync(path).mode & 0o777

describe('writeFileAtomic', () => {
  it('publishes from the staging root without touching the target directory', async () => {
    const path = join(root, 'note.txt')

    await writeFileAtomic(path, 'hello\n', undefined, undefined, {
      stagingRoot: staging,
    })

    expect(readFileSync(path, 'utf8')).toBe('hello\n')
    expect(readdirSync(root)).toEqual(['note.txt'])
    expect(readdirSync(staging)).toEqual([])
    expect(injected.renamed).toEqual([
      expect.stringContaining(join(staging, 'write-')),
    ])
    if (process.platform !== 'win32') expect(modeOf(path)).toBe(0o644)
  })

  it('keeps the permissions of the file it replaces', async () => {
    const path = join(root, 'script.sh')
    writeFileSync(path, 'old\n')
    chmodSync(path, 0o751)

    await writeFileAtomic(path, 'new\n', modeOf(path), undefined, {
      stagingRoot: staging,
    })

    expect(readFileSync(path, 'utf8')).toBe('new\n')
    expect(readdirSync(root)).toEqual(['script.sh'])
    if (process.platform !== 'win32') expect(modeOf(path)).toBe(0o751)
  })

  it('restages beside the target when publication crosses filesystems', async () => {
    const path = join(root, 'cross.txt')
    injected.renameCode = 'EXDEV'

    await writeFileAtomic(path, 'moved\n', 0o600, undefined, {
      stagingRoot: staging,
    })

    expect(injected.renameCode).toBeNull()
    expect(injected.renamed).toEqual([
      expect.stringContaining(join(staging, 'write-')),
      expect.stringContaining(join(root, '.cross.txt.')),
    ])
    expect(readFileSync(path, 'utf8')).toBe('moved\n')
    expect(readdirSync(root)).toEqual(['cross.txt'])
    expect(readdirSync(staging)).toEqual([])
    if (process.platform !== 'win32') expect(modeOf(path)).toBe(0o600)
  })

  it('reports a failed publication and leaves no staging file behind', async () => {
    const path = join(root, 'denied.txt')
    injected.renameCode = 'EACCES'

    await expect(
      writeFileAtomic(path, 'nope\n', undefined, undefined, {
        stagingRoot: staging,
      }),
    ).rejects.toMatchObject({ code: 'EACCES' })

    expect(readdirSync(root)).toEqual([])
    expect(readdirSync(staging)).toEqual([])
  })

  it('defaults to Emperor Home when no staging root is configured', async () => {
    const emperorHome = realpathSync(
      mkdtempSync(join(tmpdir(), 'emperor-fsio-home-')),
    )
    const previous = process.env.EMPEROR_CONFIG_DIR
    process.env.EMPEROR_CONFIG_DIR = emperorHome
    const path = join(root, 'default.txt')
    try {
      await writeFileAtomic(path, 'homed\n', undefined, undefined)
    } finally {
      if (previous === undefined) delete process.env.EMPEROR_CONFIG_DIR
      else process.env.EMPEROR_CONFIG_DIR = previous
    }

    expect(readFileSync(path, 'utf8')).toBe('homed\n')
    expect(readdirSync(root)).toEqual(['default.txt'])
    expect(injected.renamed).toEqual([
      expect.stringContaining(join(emperorHome, 'write-staging', 'write-')),
    ])
    expect(readdirSync(join(emperorHome, 'write-staging'))).toEqual([])
    if (process.platform !== 'win32')
      expect(modeOf(join(emperorHome, 'write-staging'))).toBe(0o700)
    rmSync(emperorHome, { recursive: true, force: true })
  })

  it('still writes atomically when the staging root cannot be used', async () => {
    const unusable = join(root, 'blocked')
    writeFileSync(unusable, 'not a directory\n')
    const path = join(root, 'fallback.txt')

    await writeFileAtomic(path, 'written\n', undefined, undefined, {
      stagingRoot: unusable,
    })

    expect(readFileSync(path, 'utf8')).toBe('written\n')
    expect(readdirSync(root).sort()).toEqual(['blocked', 'fallback.txt'])
  })
})
