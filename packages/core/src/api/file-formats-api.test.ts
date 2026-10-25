import { afterEach, describe, expect, it } from 'vitest'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CoreApi } from './core-api'
import { invokeCoreOperation } from './operations'
import { makeApi } from './test-helpers'
import type { PreviewToolRunner } from '../workspace/preview-convert'

// BUG-10 through CoreApi: files.preview classifies and enriches (with a
// fake macOS toolbox here; preview-convert.test.ts runs the real tools),
// files.mediaUrl grants what the pane shows — the file, a converted PNG
// or a first page — and names the file itself for 用默认应用打开.

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])
const apis: CoreApi[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const api of apis.splice(0)) await api.close()
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

const tools: PreviewToolRunner = async (command, args) => {
  const name = command.split('/').pop()
  if (name === 'sips' && args[0] === '-g')
    return Buffer.from('  pixelWidth: 400\n  pixelHeight: 300\n')
  if (name === 'sips') {
    writeFileSync(args[args.length - 1]!, PNG)
    return Buffer.alloc(0)
  }
  if (name === 'qlmanage') {
    if (String(args.at(-1)).endsWith('slow.key'))
      throw Object.assign(new Error('timed out'), { killed: true })
    const out = args[args.indexOf('-o') + 1]!
    writeFileSync(join(out, 'page.png'), PNG)
    return Buffer.alloc(0)
  }
  if (name === 'textutil') return Buffer.from('需求说明\n')
  if (name === 'osascript') return Buffer.from('PDF text\n')
  throw new Error(`unexpected ${command}`)
}

async function setup() {
  const { api } = await makeApi({
    extra: { previewTools: tools, previewPlatform: 'darwin' },
  })
  apis.push(api)
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), 'emperor-file-formats-')),
  )
  dirs.push(root)
  mkdirSync(join(root, 'media'), { recursive: true })
  const sessionId = String(
    api.sessions.create({ title: 'Formats', mode: 'build', project_path: root })
      .id,
  )
  const preview = (path: string) =>
    invokeCoreOperation(api, 'files.preview', [
      { source: 'project', sessionId, path },
    ])
  const grantOf = async (path: string) => {
    const { url } = await invokeCoreOperation(api, 'files.mediaUrl', [
      { source: 'project', sessionId, path },
    ])
    return api.files.mediaGrant(url.split('/').pop()!)!
  }
  return { api, root, sessionId, preview, grantOf }
}

describe('file formats through CoreApi (BUG-10)', () => {
  it('1 · a HEIC photo shows as its PNG from the cache; the grant still names the photo', async () => {
    const { api, root, preview, grantOf } = await setup()
    writeFileSync(join(root, 'media/IMG_0001.HEIC'), 'heic')
    const shown = await preview('media/IMG_0001.HEIC')
    expect(shown).toMatchObject({
      kind: 'image',
      mimeType: 'image/heic',
      converted: 'png',
      openable: true,
    })
    expect(shown.dataBase64).toBeUndefined()
    const grant = await grantOf('media/IMG_0001.HEIC')
    expect(grant).toMatchObject({
      mimeType: 'image/png',
      streamable: true,
      filePath: join(root, 'media/IMG_0001.HEIC'),
    })
    expect(
      grant.absPath.startsWith(join(api.paths.stateRoot, 'cache', 'previews')),
    ).toBe(true)
  })

  it('2 · a 10 MiB PNG streams from its own media address', async () => {
    const { root, preview, grantOf } = await setup()
    writeFileSync(join(root, 'media/huge.png'), Buffer.alloc(10 * 1024 * 1024))
    const shown = await preview('media/huge.png')
    expect(shown).toMatchObject({ kind: 'image', truncated: true })
    expect(shown.dataBase64).toBeUndefined()
    expect(await grantOf('media/huge.png')).toMatchObject({
      absPath: join(root, 'media/huge.png'),
      mimeType: 'image/png',
      streamable: true,
    })
  })

  it('3 · an mp3 is audio played from the file', async () => {
    const { root, preview, grantOf } = await setup()
    writeFileSync(join(root, 'media/配音.mp3'), Buffer.from([0xff, 0xfb, 0]))
    await expect(preview('media/配音.mp3')).resolves.toMatchObject({
      kind: 'audio',
      mimeType: 'audio/mpeg',
    })
    expect(await grantOf('media/配音.mp3')).toMatchObject({
      absPath: join(root, 'media/配音.mp3'),
      mimeType: 'audio/mpeg',
      streamable: true,
    })
  })

  it('4–5 · a PDF and a docx are documents with a first page and text', async () => {
    const { root, preview, grantOf } = await setup()
    writeFileSync(join(root, 'spec.pdf'), '%PDF-1.4\n')
    writeFileSync(join(root, '需求说明.docx'), 'PK')
    await expect(preview('spec.pdf')).resolves.toMatchObject({
      kind: 'document',
      thumbnail: true,
      content: 'PDF text\n',
      extractedText: true,
    })
    await expect(preview('需求说明.docx')).resolves.toMatchObject({
      kind: 'document',
      thumbnail: true,
      content: '需求说明\n',
    })
    const page = await grantOf('spec.pdf')
    expect(page).toMatchObject({
      mimeType: 'image/png',
      streamable: true,
      filePath: join(root, 'spec.pdf'),
    })
    expect(page.absPath).not.toBe(join(root, 'spec.pdf'))
  })

  it('12 · a document Quick Look times out on, with no text, is the card', async () => {
    const { root, preview } = await setup()
    writeFileSync(join(root, 'slow.key'), Buffer.from([0x50, 0x4b, 3, 4, 0]))
    await expect(preview('slow.key')).resolves.toMatchObject({
      kind: 'binary',
      openable: true,
    })
  })

  it('11 · anything else is named for 用默认应用打开 but never streamed; programs are not openable', async () => {
    const { root, preview, grantOf } = await setup()
    writeFileSync(join(root, 'assets.zip'), Buffer.from([0x50, 0x4b, 3, 4, 0]))
    writeFileSync(join(root, 'deploy.command'), 'echo hi\n')
    writeFileSync(join(root, 'tool'), Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0]))
    chmodSync(join(root, 'tool'), 0o755)
    await expect(preview('assets.zip')).resolves.toMatchObject({
      kind: 'binary',
      openable: true,
    })
    await expect(preview('deploy.command')).resolves.toMatchObject({
      openable: false,
    })
    await expect(preview('tool')).resolves.toMatchObject({
      kind: 'binary',
      openable: false,
    })
    expect(await grantOf('assets.zip')).toMatchObject({
      filePath: join(root, 'assets.zip'),
      streamable: false,
    })
  })
})
