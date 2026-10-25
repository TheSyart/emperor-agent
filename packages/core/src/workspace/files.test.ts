import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { WorkspaceFilesService, trimPartialUtf8 } from './files'

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

  it('keeps truncated Chinese text as text when the cut splits a character', async () => {
    const root = fixture()
    // 7 bytes: "ab" + 设 (3 bytes) + the first 2 bytes of 计.
    writeFileSync(join(root, 'zh.md'), 'ab设计说明')
    const service = new WorkspaceFilesService({
      resolveProject: () => ({ sessionId: 's1', projectRoot: root }),
      maxTextBytes: 7,
    })
    const result = await service.read({
      sessionId: 's1',
      relativePath: 'zh.md',
    })
    expect(result).toMatchObject({
      kind: 'text',
      truncated: true,
      content: 'ab设',
    })
  })

  it('BUG-05 1–2 · names video types and reads none of a video', async () => {
    const root = fixture()
    // Bytes that would read as binary: a video is never opened at all.
    writeFileSync(join(root, 'clip.mp4'), Buffer.from([0x00, 0xff, 0x00, 0x7f]))
    // (Non-empty: an empty file reads as empty text, BUG-10.)
    writeFileSync(join(root, 'take.MOV'), 'x')
    writeFileSync(join(root, 'cut.m4v'), 'x')
    writeFileSync(join(root, 'loop.webm'), 'x')
    const service = new WorkspaceFilesService({
      resolveProject: () => ({ sessionId: 's1', projectRoot: root }),
    })
    const read = (relativePath: string) =>
      service.read({ sessionId: 's1', relativePath })

    const clip = await read('clip.mp4')
    expect(clip).toMatchObject({
      kind: 'video',
      mimeType: 'video/mp4',
      bytes: 4,
      truncated: false,
    })
    expect(clip.content).toBeUndefined()
    expect(clip.dataBase64).toBeUndefined()
    await expect(read('take.MOV')).resolves.toMatchObject({
      kind: 'video',
      mimeType: 'video/quicktime',
    })
    await expect(read('cut.m4v')).resolves.toMatchObject({
      mimeType: 'video/mp4',
    })
    await expect(read('loop.webm')).resolves.toMatchObject({
      mimeType: 'video/webm',
    })
  })

  describe('BUG-10 · formats', () => {
    function service(root: string, maxImageBytes?: number) {
      return new WorkspaceFilesService({
        resolveProject: () => ({ sessionId: 's1', projectRoot: root }),
        ...(maxImageBytes ? { maxImageBytes } : {}),
      })
    }
    const read = (root: string, relativePath: string, maxImageBytes?: number) =>
      service(root, maxImageBytes).read({ sessionId: 's1', relativePath })

    it('3 · audio is kind audio, and nothing of it is read', async () => {
      const root = fixture()
      const types: Record<string, string> = {
        'a.mp3': 'audio/mpeg',
        'a.m4a': 'audio/mp4',
        'a.aac': 'audio/aac',
        'a.wav': 'audio/wav',
        'a.flac': 'audio/flac',
        'a.ogg': 'audio/ogg',
        'a.OPUS': 'audio/ogg',
      }
      for (const name of Object.keys(types))
        writeFileSync(join(root, name), Buffer.from([0, 1, 2, 255]))
      for (const [name, mimeType] of Object.entries(types)) {
        const result = await read(root, name)
        expect(result, name).toMatchObject({
          kind: 'audio',
          mimeType,
          truncated: false,
        })
        expect(result.content).toBeUndefined()
      }
    })

    it('4–5 · PDF, Office, iWork and RTF are kind document, read by the converters', async () => {
      const root = fixture()
      const names = [
        'a.pdf',
        'a.docx',
        'a.doc',
        'a.xlsx',
        'a.xls',
        'a.pptx',
        'a.ppt',
        'a.pages',
        'a.numbers',
        'a.key',
        'a.rtf',
        'a.odt',
      ]
      for (const name of names)
        writeFileSync(
          join(root, name),
          /\.(?:pages|numbers|key)$/.test(name)
            ? Buffer.from([0x50, 0x4b, 3, 4, 0])
            : '%PDF-1.4\n',
        )
      for (const name of names) {
        const result = await read(root, name)
        expect(result.kind, name).toBe('document')
        expect(result.content, name).toBeUndefined()
      }
      // iWork files are zip packages: a PEM `.key` stays text.
      writeFileSync(join(root, 'server.key'), '-----BEGIN PRIVATE KEY-----\n')
      await expect(read(root, 'server.key')).resolves.toMatchObject({
        kind: 'text',
        mimeType: 'text/plain',
      })
      expect((await read(root, 'a.pdf')).mimeType).toBe('application/pdf')
      expect((await read(root, 'a.docx')).mimeType).toBe(
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      )
    })

    it('1–2 · avif, bmp and ico come inline; heic, tiff and big images come without data', async () => {
      const root = fixture()
      const bytes = Buffer.from([1, 2, 3, 4])
      for (const name of ['a.avif', 'a.bmp', 'a.ico', 'a.heic', 'a.HEIF'])
        writeFileSync(join(root, name), bytes)
      writeFileSync(join(root, 'a.tif'), bytes)
      writeFileSync(join(root, 'big.png'), Buffer.alloc(64, 7))
      await expect(read(root, 'a.avif')).resolves.toMatchObject({
        kind: 'image',
        mimeType: 'image/avif',
        dataBase64: bytes.toString('base64'),
      })
      await expect(read(root, 'a.bmp')).resolves.toMatchObject({
        mimeType: 'image/bmp',
        dataBase64: bytes.toString('base64'),
      })
      await expect(read(root, 'a.ico')).resolves.toMatchObject({
        mimeType: 'image/x-icon',
        dataBase64: bytes.toString('base64'),
      })
      for (const [name, mimeType] of [
        ['a.heic', 'image/heic'],
        ['a.HEIF', 'image/heif'],
        ['a.tif', 'image/tiff'],
      ] as const) {
        const result = await read(root, name)
        expect(result, name).toMatchObject({ kind: 'image', mimeType })
        expect(result.dataBase64, name).toBeUndefined()
      }
      // Past the inline limit no data comes inline; the pane streams it.
      const big = await read(root, 'big.png', 16)
      expect(big).toMatchObject({ kind: 'image', truncated: true })
      expect(big.dataBase64).toBeUndefined()
    })

    it('6 · UTF-16 with a byte order mark reads as text', async () => {
      const root = fixture()
      const text = '订单号,客户\nA1023,张三\n'
      writeFileSync(
        join(root, 'le.txt'),
        Buffer.concat([
          Buffer.from([0xff, 0xfe]),
          Buffer.from(text, 'utf16le'),
        ]),
      )
      const be = Buffer.from(text, 'utf16le')
      for (let i = 0; i < be.length; i += 2) {
        const first = be[i]!
        be[i] = be[i + 1]!
        be[i + 1] = first
      }
      writeFileSync(
        join(root, 'be.txt'),
        Buffer.concat([Buffer.from([0xfe, 0xff]), be]),
      )
      await expect(read(root, 'le.txt')).resolves.toMatchObject({
        kind: 'text',
        content: text,
        encoding: 'UTF-16LE',
      })
      await expect(read(root, 'be.txt')).resolves.toMatchObject({
        kind: 'text',
        content: text,
        encoding: 'UTF-16BE',
      })
    })

    it('7 · GB18030 (GBK) text reads as text and names its encoding', async () => {
      const root = fixture()
      // 订单号,客户\nA1023,张三,199.00\n in GBK.
      writeFileSync(
        join(root, 'orders.csv'),
        Buffer.from(
          'b6a9b5a5bac52cbfcdbba70a41313032332cd5c5c8fd2c3139392e30300a',
          'hex',
        ),
      )
      const result = await read(root, 'orders.csv')
      expect(result).toMatchObject({
        kind: 'text',
        mimeType: 'text/csv',
        content: '订单号,客户\nA1023,张三,199.00\n',
        encoding: 'GB18030',
      })
      // UTF-8 stays unmarked.
      writeFileSync(join(root, 'plain.txt'), '订单号\n')
      const plain = await read(root, 'plain.txt')
      expect(plain).toMatchObject({ kind: 'text', content: '订单号\n' })
      expect(plain.encoding).toBeUndefined()
    })

    it('8 · real binary data stays binary', async () => {
      const root = fixture()
      writeFileSync(
        join(root, 'blob.bin'),
        Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x00, 0xff, 0xfe]),
      )
      writeFileSync(
        join(root, 'junk.dat'),
        Buffer.from([0x81, 0x30, 0xff, 0x41]),
      )
      await expect(read(root, 'blob.bin')).resolves.toMatchObject({
        kind: 'binary',
      })
      await expect(read(root, 'junk.dat')).resolves.toMatchObject({
        kind: 'binary',
      })
    })

    it('9–10 · Markdown variants, CSV and TSV have their types; an empty file is empty text', async () => {
      const root = fixture()
      for (const name of ['a.markdown', 'a.mdown', 'a.mkd'])
        writeFileSync(join(root, name), '# Title\n')
      writeFileSync(join(root, 'a.tsv'), 'a\tb\n')
      writeFileSync(join(root, 'empty.pdf'), '')
      for (const name of ['a.markdown', 'a.mdown', 'a.mkd'])
        expect((await read(root, name)).mimeType, name).toBe('text/markdown')
      expect((await read(root, 'a.tsv')).mimeType).toBe(
        'text/tab-separated-values',
      )
      await expect(read(root, 'empty.pdf')).resolves.toMatchObject({
        kind: 'text',
        content: '',
        bytes: 0,
      })
    })
  })

  it('trims only an incomplete UTF-8 tail', () => {
    const text = Buffer.from('a设😀', 'utf8')
    expect(trimPartialUtf8(text)).toEqual(text)
    expect(trimPartialUtf8(text.subarray(0, 6)).toString()).toBe('a设')
    expect(trimPartialUtf8(text.subarray(0, 3)).toString()).toBe('a')
    expect(trimPartialUtf8(Buffer.from('abc'))).toEqual(Buffer.from('abc'))
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

  it('BUG-12 · marks ignored entries when asked, instead of dropping them', async () => {
    const root = fixture()
    mkdirSync(join(root, 'dist'))
    writeFileSync(join(root, 'dist', 'app.js'), 'x\n')
    writeFileSync(join(root, '.env'), 'KEY=1\n')
    const service = new WorkspaceFilesService({
      resolveProject: () => ({ sessionId: 's1', projectRoot: root }),
      filterIgnored: async (_sessionId, _projectRoot, paths) =>
        new Set(paths.filter((path) => path.startsWith('dist'))),
    })
    const listed = await service.list({
      sessionId: 's1',
      relativePath: '',
      showHidden: true,
      showIgnored: true,
    })
    const byName = Object.fromEntries(
      listed.entries.map((entry) => [entry.name, entry]),
    )
    expect(byName.dist).toMatchObject({ ignored: true, hidden: false })
    expect(byName['.env']).toMatchObject({ hidden: true })
    expect(byName['.env']!.ignored).toBeUndefined()
    expect(byName.src!.ignored).toBeUndefined()
    const found = await service.search({
      sessionId: 's1',
      query: 'app',
      showIgnored: true,
    })
    expect(found.entries).toEqual([
      expect.objectContaining({ path: 'dist/app.js', ignored: true }),
    ])
    // Not asked: dropped, as before.
    expect(
      (await service.search({ sessionId: 's1', query: 'app' })).entries,
    ).toEqual([])
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
