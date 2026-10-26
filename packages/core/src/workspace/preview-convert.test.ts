import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  enrichFilePreview,
  PreviewConverter,
  type PreviewToolRunner,
} from './preview-convert'
import { isOpenableFile } from './open-policy'
import type { FilePreviewResult } from './file-preview'

// BUG-10: HEIC/TIFF become PNG (sips), documents get a first-page picture
// (qlmanage) and text (PDFKit through osascript, textutil); results are
// cached under Emperor's state by realpath + mtime + size + method.

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  dirs.push(dir)
  return dir
}

interface Call {
  command: string
  args: readonly string[]
  cwd: string
  timeoutMs: number
}

/** A fake toolbox: writes what each tool would and records the calls. */
function fakeTools(
  overrides: Partial<Record<string, (call: Call) => Promise<Buffer>>> = {},
) {
  const calls: Call[] = []
  const run: PreviewToolRunner = async (command, args, options) => {
    const call = { command, args, ...options }
    calls.push(call)
    const name = command.split('/').pop()!
    const override = overrides[name]
    if (override) return override(call)
    if (name === 'sips' && args[0] === '-g')
      return Buffer.from('/x\n  pixelWidth: 3000\n  pixelHeight: 2000\n')
    if (name === 'sips') {
      writeFileSync(args[args.length - 1]!, PNG)
      return Buffer.alloc(0)
    }
    if (name === 'qlmanage') {
      const out = args[args.indexOf('-o') + 1]!
      writeFileSync(
        join(out, `${args[args.length - 1]!.split('/').pop()}.png`),
        PNG,
      )
      return Buffer.from('produced one thumbnail\n')
    }
    if (name === 'textutil') return Buffer.from('需求说明\n第一段\n')
    if (name === 'osascript') return Buffer.from('Requirements\n')
    throw new Error(`unexpected ${command}`)
  }
  return { run, calls }
}

function setup(tools = fakeTools()) {
  const cacheDir = join(tempDir('emperor-preview-cache-'), 'cache', 'previews')
  const project = tempDir('emperor-preview-project-')
  const converter = new PreviewConverter({
    cacheDir,
    run: tools.run,
    platform: 'darwin',
  })
  return { cacheDir, project, converter, tools }
}

describe('PreviewConverter (BUG-10)', () => {
  it('1 · converts HEIC with sips to a cached PNG, shrinking only what is larger than 2400', async () => {
    const { cacheDir, project, converter, tools } = setup()
    const photo = join(project, 'IMG 0001.HEIC')
    writeFileSync(photo, 'heic')
    const png = await converter.imagePng(photo)
    expect(png).not.toBeNull()
    expect(png!.startsWith(cacheDir)).toBe(true)
    expect(readFileSync(png!).subarray(0, 8)).toEqual(PNG.subarray(0, 8))
    const [probe, convert] = tools.calls
    expect(probe!.command).toBe('/usr/bin/sips')
    expect(probe!.args).toEqual([
      '-g',
      'pixelWidth',
      '-g',
      'pixelHeight',
      photo,
    ])
    expect(convert!.args).toEqual([
      '-s',
      'format',
      'png',
      '--resampleHeightWidthMax',
      '2400',
      photo,
      '--out',
      join(convert!.cwd, 'preview.png'),
    ])
    // Its own private temp folder, gone afterwards; ten seconds at most.
    expect(convert!.cwd.startsWith(cacheDir)).toBe(false)
    expect(existsSync(convert!.cwd)).toBe(false)
    expect(convert!.timeoutMs).toBe(10_000)
    // The same file again: from the cache, no tool runs.
    expect(await converter.imagePng(photo)).toBe(png)
    expect(tools.calls).toHaveLength(2)
    // Changed on disk: converted again.
    writeFileSync(photo, 'heic, edited')
    const later = new Date(Date.now() + 5_000)
    utimesSync(photo, later, later)
    expect(await converter.imagePng(photo)).not.toBe(png)
    expect(tools.calls).toHaveLength(4)
  })

  it('leaves a small picture at its size', async () => {
    const tools = fakeTools({
      sips: async (call) => {
        if (call.args[0] === '-g')
          return Buffer.from('  pixelWidth: 640\n  pixelHeight: 480\n')
        writeFileSync(call.args[call.args.length - 1]!, PNG)
        return Buffer.alloc(0)
      },
    })
    const { project, converter } = setup(tools)
    const scan = join(project, 'scan.tiff')
    writeFileSync(scan, 'tiff')
    expect(await converter.imagePng(scan)).not.toBeNull()
    expect(tools.calls[1]!.args).not.toContain('--resampleHeightWidthMax')
  })

  it('4 · makes the first page with qlmanage (paths after --) and reads PDF text through PDFKit', async () => {
    const { project, converter, tools } = setup()
    const pdf = join(project, '需求 说明.pdf')
    writeFileSync(pdf, '%PDF-1.4\n')
    const page = await converter.thumbnail(pdf)
    expect(page).not.toBeNull()
    const quicklook = tools.calls[0]!
    expect(quicklook.command).toBe('/usr/bin/qlmanage')
    expect(quicklook.args).toEqual([
      '-t',
      '-s',
      '1600',
      '-o',
      quicklook.cwd,
      '--',
      pdf,
    ])
    expect(await converter.text(pdf)).toBe('Requirements\n')
    const script = tools.calls[1]!
    expect(script.command).toBe('/usr/bin/osascript')
    expect(script.args.slice(0, 2)).toEqual(['-l', 'JavaScript'])
    expect(script.args.at(-1)).toBe(pdf)
  })

  it('5 · reads Word and RTF text with textutil, and none from a spreadsheet', async () => {
    const { project, converter, tools } = setup()
    const docx = join(project, 'spec.docx')
    const xlsx = join(project, 'sheet.xlsx')
    writeFileSync(docx, 'docx')
    writeFileSync(xlsx, 'xlsx')
    expect(await converter.text(docx)).toBe('需求说明\n第一段\n')
    expect(tools.calls[0]!.command).toBe('/usr/bin/textutil')
    expect(tools.calls[0]!.args).toEqual([
      '-convert',
      'txt',
      '-stdout',
      '-encoding',
      'UTF-8',
      '--',
      docx,
    ])
    expect(await converter.text(xlsx)).toBeNull()
    expect(tools.calls).toHaveLength(1)
  })

  it('12 · a tool that times out or fails gives nothing, and is not asked again for that file', async () => {
    const tools = fakeTools({
      qlmanage: async () => {
        throw Object.assign(new Error('timed out'), { killed: true })
      },
    })
    const { project, converter } = setup(tools)
    const deck = join(project, 'deck.key')
    writeFileSync(deck, 'key')
    expect(await converter.thumbnail(deck)).toBeNull()
    expect(await converter.thumbnail(deck)).toBeNull()
    expect(tools.calls).toHaveLength(1)
  })

  it('keeps at most 32 results', async () => {
    const tools = fakeTools({
      textutil: async (call) => Buffer.from(String(call.args.at(-1))),
    })
    const { cacheDir, project, converter } = setup(tools)
    for (let i = 0; i < 34; i += 1) {
      const file = join(project, `n${i}.rtf`)
      writeFileSync(file, `n${i}`)
      expect(await converter.text(file)).toBe(file)
    }
    expect(readdirSync(cacheDir).length).toBeLessThanOrEqual(32)
  })

  it('does nothing off macOS', async () => {
    const tools = fakeTools()
    const cacheDir = join(tempDir('emperor-preview-cache-'), 'previews')
    const converter = new PreviewConverter({
      cacheDir,
      run: tools.run,
      platform: 'linux',
    })
    const file = join(tempDir('emperor-preview-project-'), 'a.heic')
    writeFileSync(file, 'x')
    expect(await converter.imagePng(file)).toBeNull()
    expect(await converter.thumbnail(file)).toBeNull()
    expect(tools.calls).toHaveLength(0)
  })
})

describe('enrichFilePreview (BUG-10)', () => {
  function preview(
    path: string,
    overrides: Partial<FilePreviewResult>,
  ): FilePreviewResult {
    return {
      id: `file:${path}`,
      path,
      name: path.split('/').pop()!,
      kind: 'binary',
      mimeType: 'application/octet-stream',
      bytes: 4,
      truncated: false,
      ...overrides,
    }
  }

  it('gives a document its first page and its text, or the card when it has neither', async () => {
    const { project, converter } = setup()
    const pdf = join(project, 'a.pdf')
    writeFileSync(pdf, '%PDF')
    const shown = await enrichFilePreview(
      preview(pdf, { kind: 'document', mimeType: 'application/pdf' }),
      converter,
    )
    expect(shown.preview).toMatchObject({
      kind: 'document',
      thumbnail: true,
      content: 'Requirements\n',
      extractedText: true,
      openable: true,
    })
    expect(shown.media).toMatchObject({ mimeType: 'image/png' })

    const none = setup(
      fakeTools({
        qlmanage: async () => {
          throw new Error('timed out')
        },
        osascript: async () => Buffer.alloc(0),
      }),
    )
    const locked = join(none.project, 'locked.pdf')
    writeFileSync(locked, '%PDF')
    const card = await enrichFilePreview(
      preview(locked, { kind: 'document', mimeType: 'application/pdf' }),
      none.converter,
    )
    expect(card.preview.kind).toBe('binary')
    expect(card.media).toBeNull()
  })

  it('serves HEIC as its PNG, and a broken one as the card', async () => {
    const { project, converter } = setup()
    const photo = join(project, 'a.heic')
    writeFileSync(photo, 'heic')
    const shown = await enrichFilePreview(
      preview(photo, { kind: 'image', mimeType: 'image/heic' }),
      converter,
    )
    expect(shown.preview).toMatchObject({ kind: 'image', converted: 'png' })
    expect(shown.media).toMatchObject({ mimeType: 'image/png' })
    expect(shown.media!.path).not.toBe(photo)

    const broken = setup(
      fakeTools({
        sips: async () => {
          throw new Error('Error 13: an unknown error occurred')
        },
      }),
    )
    const bad = join(broken.project, 'bad.heic')
    writeFileSync(bad, 'nope')
    const card = await enrichFilePreview(
      preview(bad, { kind: 'image', mimeType: 'image/heic' }),
      broken.converter,
    )
    expect(card.preview.kind).toBe('binary')
  })

  it('serves video, audio and images as themselves, and opens nothing that runs', async () => {
    const { project, converter } = setup()
    const song = join(project, 'a.mp3')
    const script = join(project, 'build.command')
    const tool = join(project, 'tool')
    writeFileSync(song, 'mp3')
    writeFileSync(script, 'echo hi')
    writeFileSync(tool, 'x')
    chmodSync(tool, 0o755)
    expect(
      await enrichFilePreview(
        preview(song, { kind: 'audio', mimeType: 'audio/mpeg' }),
        converter,
      ),
    ).toMatchObject({
      preview: { kind: 'audio', openable: true },
      media: { path: song, mimeType: 'audio/mpeg' },
    })
    expect(
      (await enrichFilePreview(preview(script, {}), converter)).preview
        .openable,
    ).toBe(false)
    expect(
      (await enrichFilePreview(preview(tool, {}), converter)).preview.openable,
    ).toBe(false)
  })
})

describe('isOpenableFile (BUG-10)', () => {
  it('refuses programs, scripts, installers, bundles and executables', () => {
    const dir = tempDir('emperor-open-policy-')
    const allowed = ['a.zip', 'a.pdf', 'a.mp4', 'a.txt', 'a.docx']
    const refused = [
      'a.app',
      'a.command',
      'a.sh',
      'a.pkg',
      'a.dmg',
      'a.terminal',
      'a.workflow',
      'a.scpt',
      'a.jar',
      'a.py',
      'a.webloc',
      'a.mobileconfig',
      'A.APP',
    ]
    for (const name of [...allowed, ...refused])
      writeFileSync(join(dir, name), 'x')
    for (const name of allowed)
      expect(isOpenableFile(join(dir, name)), name).toBe(true)
    for (const name of refused)
      expect(isOpenableFile(join(dir, name)), name).toBe(false)
    const binary = join(dir, 'run-me')
    writeFileSync(binary, 'x')
    chmodSync(binary, 0o700)
    expect(isOpenableFile(binary)).toBe(false)
    expect(isOpenableFile(join(dir, 'missing.txt'))).toBe(false)
    expect(isOpenableFile(dir)).toBe(false)
  })
})

/** The real tools, on a Mac that has them (CI runs on macOS). */
const hasTools =
  process.platform === 'darwin' &&
  ['sips', 'qlmanage', 'textutil', 'osascript'].every((tool) =>
    existsSync(`/usr/bin/${tool}`),
  )

/** A one-page PDF with a line of text, built by hand (a few hundred bytes). */
function tinyPdf(text: string): Buffer {
  const stream = `BT /F1 24 Tf 72 720 Td (${text}) Tj ET`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let body = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((object, index) => {
    offsets.push(body.length)
    body += `${index + 1} 0 obj\n${object}\nendobj\n`
  })
  const xref = body.length
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets)
    body += `${String(offset).padStart(10, '0')} 00000 n \n`
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(body, 'latin1')
}

describe.skipIf(!hasTools)('PreviewConverter with the macOS tools', () => {
  function real() {
    const cacheDir = join(tempDir('emperor-preview-real-'), 'previews')
    const project = tempDir('emperor-preview-files-')
    return { converter: new PreviewConverter({ cacheDir }), project }
  }

  /** A small PNG made by sips itself from a BMP header we write. */
  function writeBmp(path: string): void {
    const width = 8
    const height = 8
    const row = width * 3
    const pixels = Buffer.alloc(row * height, 0x80)
    const header = Buffer.alloc(54)
    header.write('BM', 0)
    header.writeUInt32LE(54 + pixels.length, 2)
    header.writeUInt32LE(54, 10)
    header.writeUInt32LE(40, 14)
    header.writeInt32LE(width, 18)
    header.writeInt32LE(height, 22)
    header.writeUInt16LE(1, 26)
    header.writeUInt16LE(24, 28)
    header.writeUInt32LE(pixels.length, 34)
    writeFileSync(path, Buffer.concat([header, pixels]))
  }

  it('1 · turns a HEIC and a TIFF into PNG', async () => {
    const { converter, project } = real()
    const bmp = join(project, 'source.bmp')
    writeBmp(bmp)
    for (const format of ['heic', 'tiff']) {
      const file = join(project, `photo.${format}`)
      execFileSync('/usr/bin/sips', [
        '-s',
        'format',
        format,
        bmp,
        '--out',
        file,
      ])
      const png = await converter.imagePng(file)
      expect(png, format).not.toBeNull()
      expect(readFileSync(png!).subarray(0, 8)).toEqual(PNG.subarray(0, 8))
    }
  })

  it('4 · gives a PDF a first page and its text', async () => {
    const { converter, project } = real()
    const pdf = join(project, 'spec.pdf')
    writeFileSync(pdf, tinyPdf('Requirements first page'))
    const page = await converter.thumbnail(pdf)
    expect(page).not.toBeNull()
    expect(readFileSync(page!).subarray(0, 8)).toEqual(PNG.subarray(0, 8))
    expect(await converter.text(pdf)).toContain('Requirements first page')
  }, 30_000)

  it('5 · reads a Word document with textutil', async () => {
    const { converter, project } = real()
    const html = join(project, 'spec.html')
    const docx = join(project, 'spec.docx')
    writeFileSync(
      html,
      '<html><meta charset="utf-8"><body><h1>需求说明</h1><p>第一段</p></body></html>',
    )
    execFileSync('/usr/bin/textutil', [
      '-convert',
      'docx',
      '-output',
      docx,
      html,
    ])
    expect(await converter.text(docx)).toMatch(/需求说明[\s\S]*第一段/)
  })

  it('12 · a PDF PDFKit cannot open gives no text', async () => {
    const { converter, project } = real()
    const broken = join(project, 'broken.pdf')
    writeFileSync(broken, '%PDF-1.4\nnot really a pdf\n')
    expect(await converter.text(broken)).toBeNull()
  }, 30_000)
})
