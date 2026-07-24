import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { WorkspaceFilesService } from './files'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'emperor-files-'))
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'src', 'main.ts'), 'export const value = 1\n')
  writeFileSync(join(root, '.hidden'), 'hidden\n')
  mkdirSync(join(root, '.git'))
  writeFileSync(join(root, '.git', 'config'), '[core]\n')
  return root
}

describe('WorkspaceFilesService', () => {
  it('lists project-relative entries without exposing .git internals', async () => {
    const root = fixture()
    const service = new WorkspaceFilesService({
      resolveProject: () => ({ sessionId: 's1', projectRoot: root }),
    })

    const result = await service.list({ sessionId: 's1', relativePath: '' })

    expect(result.entries.map((entry) => entry.name)).toEqual(['src'])
    expect(result.projectRoot).toBe(root)

    const withHidden = await service.list({
      sessionId: 's1',
      relativePath: '',
      showHidden: true,
    })
    expect(withHidden.entries.map((entry) => entry.name)).toEqual([
      '.hidden',
      'src',
    ])
    await expect(
      service.list({ sessionId: 's1', relativePath: 'src/..' }),
    ).resolves.toMatchObject({ relativePath: '' })
  })

  it('reads bounded text and rejects traversal and escaping symlinks', async () => {
    const root = fixture()
    const outside = join(tmpdir(), 'emperor-outside-secret.txt')
    writeFileSync(outside, 'secret\n')
    symlinkSync(join(root, 'src'), join(root, 'source-link'))
    const service = new WorkspaceFilesService({
      resolveProject: () => ({ sessionId: 's1', projectRoot: root }),
      maxTextBytes: 8,
    })

    await expect(
      service.read({ sessionId: 's1', relativePath: '../secret' }),
    ).rejects.toMatchObject({ code: 'workspace_path_invalid' })
    await expect(
      service.read({ sessionId: 'other', relativePath: 'src/main.ts' }),
    ).rejects.toMatchObject({ code: 'workspace_session_invalid' })

    const listing = await service.list({
      sessionId: 's1',
      relativePath: '',
    })
    expect(listing.entries).toContainEqual(
      expect.objectContaining({
        name: 'source-link',
        kind: 'symlink',
        targetKind: 'directory',
      }),
    )
    await expect(
      service.list({ sessionId: 's1', relativePath: 'source-link' }),
    ).resolves.toMatchObject({ relativePath: 'src' })

    symlinkSync(outside, join(root, 'escape'))
    await expect(
      service.read({ sessionId: 's1', relativePath: 'escape' }),
    ).rejects.toMatchObject({ code: 'workspace_path_invalid' })

    const text = await service.read({
      sessionId: 's1',
      relativePath: 'src/main.ts',
    })
    expect(text).toMatchObject({ kind: 'text', truncated: true, bytes: 23 })
    expect(text.content).toBe('export c')

    writeFileSync(join(root, 'opaque.bin'), Buffer.from([0xff, 0xfe, 0xfd]))
    await expect(
      service.read({ sessionId: 's1', relativePath: 'opaque.bin' }),
    ).resolves.toMatchObject({ kind: 'binary' })
  })

  it('searches lazily by relative path with stable pagination', async () => {
    const root = fixture()
    writeFileSync(join(root, 'src', 'main.test.ts'), 'test\n')
    const service = new WorkspaceFilesService({
      resolveProject: () => ({ sessionId: 's1', projectRoot: root }),
    })

    const first = await service.search({
      sessionId: 's1',
      query: 'main',
      limit: 1,
    })
    const second = await service.search({
      sessionId: 's1',
      query: 'main',
      limit: 1,
      cursor: first.nextCursor || undefined,
    })

    expect(first.entries).toHaveLength(1)
    expect(second.entries).toHaveLength(1)
    expect(first.entries[0]?.path).not.toBe(second.entries[0]?.path)
  })

  it('hard-bounds repository scans and reuses one scan across cursor pages', async () => {
    const root = fixture()
    for (let index = 0; index < 30; index += 1)
      writeFileSync(join(root, `match-${index}.txt`), 'match\n')
    let classifications = 0
    const service = new WorkspaceFilesService({
      resolveProject: () => ({ sessionId: 's1', projectRoot: root }),
      maxSearchEntries: 7,
      filterIgnored: async () => {
        classifications += 1
        return new Set()
      },
    })

    const first = await service.search({
      sessionId: 's1',
      query: 'match',
      limit: 2,
    })
    await service.search({
      sessionId: 's1',
      query: 'match',
      limit: 2,
      cursor: first.nextCursor || undefined,
    })

    expect(first.entries.length).toBeLessThanOrEqual(2)
    expect(first.truncated).toBe(true)
    expect(classifications).toBe(1)
  })

  it('hard-bounds directory listings and reuses one classified snapshot across pages', async () => {
    const root = fixture()
    for (let index = 0; index < 30; index += 1)
      writeFileSync(join(root, `entry-${index}.txt`), 'entry\n')
    let classifications = 0
    const service = new WorkspaceFilesService({
      resolveProject: () => ({ sessionId: 's1', projectRoot: root }),
      maxDirectoryEntries: 7,
      filterIgnored: async () => {
        classifications += 1
        return new Set()
      },
    })

    const first = await service.list({
      sessionId: 's1',
      relativePath: '',
      limit: 2,
    })
    const second = await service.list({
      sessionId: 's1',
      relativePath: '',
      cursor: first.nextCursor || undefined,
      limit: 2,
    })

    expect(first.truncated).toBe(true)
    expect(first.entries).toHaveLength(2)
    expect(second.entries).toHaveLength(2)
    expect(classifications).toBe(1)
  })

  it('filters ignored paths by default and reveals them only on request', async () => {
    const root = fixture()
    writeFileSync(join(root, 'ignored.log'), 'ignored\n')
    const service = new WorkspaceFilesService({
      resolveProject: () => ({ sessionId: 's1', projectRoot: root }),
      filterIgnored: async (_sessionId, _projectRoot, paths) =>
        new Set(paths.filter((path) => path === 'ignored.log')),
    })

    const hidden = await service.list({ sessionId: 's1', relativePath: '' })
    const visible = await service.list({
      sessionId: 's1',
      relativePath: '',
      showIgnored: true,
    })

    expect(hidden.entries.map((entry) => entry.path)).not.toContain(
      'ignored.log',
    )
    expect(visible.entries.map((entry) => entry.path)).toContain('ignored.log')
  })

  it('keeps file browsing available when ignore classification is unavailable', async () => {
    const root = fixture()
    const service = new WorkspaceFilesService({
      resolveProject: () => ({ sessionId: 's1', projectRoot: root }),
      filterIgnored: async () => {
        throw new Error('not a Git repository')
      },
    })

    await expect(
      service.list({ sessionId: 's1', relativePath: '' }),
    ).resolves.toMatchObject({
      entries: [{ name: 'src' }],
    })
  })
})
