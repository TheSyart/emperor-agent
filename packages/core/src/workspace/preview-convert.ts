import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join } from 'node:path'
import type { FilePreviewResult } from './file-preview'
import { trimPartialUtf8 } from './files'
import { isOpenableFile } from './open-policy'

/**
 * Previews macOS makes for the Files pane (BUG-10):
 * - HEIC, HEIF and TIFF become a PNG (`sips`), at most 2400 px on the long
 *   side (smaller pictures keep their size);
 * - PDF, Office, iWork and RTF get a first-page picture (Quick Look,
 *   `qlmanage -t`) and, when they have one, their text: PDFKit through
 *   `osascript` for a PDF, `textutil` for Word, RTF and ODT (1 MiB at most).
 *
 * Each tool runs with execFile (no shell) from /usr/bin, in a private
 * temporary folder of its own, for at most ten seconds; the file is passed
 * as its absolute path after `--` where the tool takes one (sips and
 * osascript do not: an absolute path can never read as an option). The
 * tools only read the file. Results are cached in `<stateRoot>/cache/
 * previews` under sha256(realpath, mtime, size, method), 32 at most, the
 * least recently used going first; a failure is remembered for the run so
 * a slow file is not tried again until it changes.
 */

/** Runs a tool; resolves with its stdout, rejects on failure or timeout. */
export type PreviewToolRunner = (
  command: string,
  args: readonly string[],
  options: { cwd: string; timeoutMs: number; maxBuffer: number },
) => Promise<Buffer>

export interface PreviewConverterOptions {
  cacheDir: string
  run?: PreviewToolRunner
  platform?: NodeJS.Platform
  timeoutMs?: number
  maxEntries?: number
}

const SIPS = '/usr/bin/sips'
const QLMANAGE = '/usr/bin/qlmanage'
const TEXTUTIL = '/usr/bin/textutil'
const OSASCRIPT = '/usr/bin/osascript'
const MAX_SIDE = 2400
const MAX_TEXT_BYTES = 1024 * 1024
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
/** The text of a PDF through PDFKit (JavaScript for Automation); '' when locked. */
const PDF_TEXT_SCRIPT = `ObjC.import('Quartz')
function run(argv) {
  const doc = $.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(argv[0]))
  if (doc.isNil() || doc.isLocked) return ''
  const text = doc.string
  return text.isNil() ? '' : text.js
}`
const TEXTUTIL_TYPES = new Set(['doc', 'docx', 'rtf', 'odt'])

const runTool: PreviewToolRunner = (command, args, options) =>
  new Promise((resolve, reject) => {
    execFile(
      command,
      [...args],
      {
        cwd: options.cwd,
        timeout: options.timeoutMs,
        killSignal: 'SIGKILL',
        maxBuffer: options.maxBuffer,
        encoding: 'buffer',
        env: {
          PATH: '/usr/bin:/bin',
          HOME: process.env.HOME ?? tmpdir(),
          TMPDIR: tmpdir(),
        },
      },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    )
  })

export class PreviewConverter {
  private readonly cacheDir: string
  private readonly run: PreviewToolRunner
  private readonly platform: NodeJS.Platform
  private readonly timeoutMs: number
  private readonly maxEntries: number
  /** Cache keys a tool already failed on in this run. */
  private readonly failed = new Set<string>()
  /** One conversion per key at a time. */
  private readonly pending = new Map<string, Promise<string | null>>()

  constructor(options: PreviewConverterOptions) {
    this.cacheDir = options.cacheDir
    this.run = options.run ?? runTool
    this.platform = options.platform ?? process.platform
    this.timeoutMs = options.timeoutMs ?? 10_000
    this.maxEntries = options.maxEntries ?? 32
  }

  /** A PNG of a HEIC, HEIF or TIFF picture; null when sips cannot. */
  imagePng(path: string): Promise<string | null> {
    return this.cached(path, 'sips-png', 'png', async (file, work) => {
      const size = await this.run(
        SIPS,
        ['-g', 'pixelWidth', '-g', 'pixelHeight', file],
        this.toolOptions(work),
      )
      const side = Math.max(
        ...[...size.toString('utf8').matchAll(/pixel(?:Width|Height):\s*(\d+)/g)].map(
          (match) => Number(match[1]),
        ),
      )
      const out = join(work, 'preview.png')
      await this.run(
        SIPS,
        [
          '-s',
          'format',
          'png',
          ...(side > MAX_SIDE
            ? ['--resampleHeightWidthMax', String(MAX_SIDE)]
            : []),
          file,
          '--out',
          out,
        ],
        this.toolOptions(work),
      )
      return isPng(out) ? readFileSync(out) : null
    })
  }

  /** The first page of a document as a PNG (Quick Look); null when it has none. */
  thumbnail(path: string): Promise<string | null> {
    return this.cached(path, 'qlmanage-1600', 'png', async (file, work) => {
      await this.run(
        QLMANAGE,
        ['-t', '-s', '1600', '-o', work, '--', file],
        this.toolOptions(work),
      )
      const made = (await readdir(work)).find((name) => name.endsWith('.png'))
      return made && isPng(join(work, made))
        ? readFileSync(join(work, made))
        : null
    })
  }

  /** A document's text, 1 MiB at most: PDF (PDFKit), Word, RTF, ODT (textutil). */
  text(path: string): Promise<string | null> {
    const extension = basename(path).toLocaleLowerCase().split('.').pop() ?? ''
    if (extension !== 'pdf' && !TEXTUTIL_TYPES.has(extension))
      return Promise.resolve(null)
    return this.cached(path, `text-${extension}`, 'txt', async (file, work) => {
      const stdout =
        extension === 'pdf'
          ? await this.run(
              OSASCRIPT,
              ['-l', 'JavaScript', '-e', PDF_TEXT_SCRIPT, file],
              this.toolOptions(work, 8 * MAX_TEXT_BYTES),
            )
          : await this.run(
              TEXTUTIL,
              ['-convert', 'txt', '-stdout', '-encoding', 'UTF-8', '--', file],
              this.toolOptions(work, 8 * MAX_TEXT_BYTES),
            )
      const text =
        stdout.length > MAX_TEXT_BYTES
          ? trimPartialUtf8(stdout.subarray(0, MAX_TEXT_BYTES))
          : stdout
      return text.toString('utf8').trim() ? text : null
    }).then((cache) => (cache ? readFileSync(cache, 'utf8') : null))
  }

  private toolOptions(cwd: string, maxBuffer = 1024 * 1024) {
    return { cwd, timeoutMs: this.timeoutMs, maxBuffer }
  }

  /**
   * The cached result of `method` for the file, made by `make` in a private
   * temporary folder when missing; null when the tool gave nothing.
   */
  private cached(
    path: string,
    method: string,
    suffix: string,
    make: (file: string, work: string) => Promise<Buffer | null>,
  ): Promise<string | null> {
    if (this.platform !== 'darwin') return Promise.resolve(null)
    let file: string
    let key: string
    try {
      file = realpathSync(path)
      if (!isAbsolute(file)) return Promise.resolve(null)
      const metadata = statSync(file)
      key = createHash('sha256')
        .update(`${file}\0${metadata.mtimeMs}\0${metadata.size}\0${method}`)
        .digest('hex')
    } catch {
      return Promise.resolve(null)
    }
    const target = join(this.cacheDir, `${key}.${suffix}`)
    if (existsSync(target)) {
      const now = new Date()
      try {
        utimesSync(target, now, now)
      } catch {
        // A read-only cache still serves.
      }
      return Promise.resolve(target)
    }
    if (this.failed.has(key)) return Promise.resolve(null)
    const running = this.pending.get(key)
    if (running) return running
    const result = (async () => {
      const work = await mkdtemp(join(tmpdir(), 'emperor-preview-'))
      try {
        const bytes = await make(file, work)
        if (!bytes) {
          this.failed.add(key)
          return null
        }
        mkdirSync(this.cacheDir, { recursive: true })
        const staged = join(work, `result.${suffix}`)
        writeFileSync(staged, bytes)
        copyFileSync(staged, target)
        this.prune()
        return target
      } catch {
        this.failed.add(key)
        return null
      } finally {
        await rm(work, { recursive: true, force: true })
        this.pending.delete(key)
      }
    })()
    this.pending.set(key, result)
    return result
  }

  /** Keep the newest `maxEntries` results. */
  private prune(): void {
    try {
      const entries = readdirSync(this.cacheDir)
        .map((name) => {
          const path = join(this.cacheDir, name)
          return { path, used: statSync(path).mtimeMs }
        })
        .sort((left, right) => right.used - left.used)
      for (const stale of entries.slice(this.maxEntries))
        rmSync(stale.path, { force: true })
    } catch {
      // A cache that cannot be tidied still works.
    }
  }
}

function isPng(path: string): boolean {
  try {
    return readFileSync(path).subarray(0, 8).equals(PNG_SIGNATURE)
  } catch {
    return false
  }
}

export interface EnrichedPreview {
  preview: FilePreviewResult
  /** What a media address shows: the file, its PNG or its first page. */
  media: { path: string; mimeType: string } | null
}

/**
 * The preview the pane shows, with what macOS can add (BUG-10): HEIC/TIFF
 * as PNG, a document's first page and text, and whether 用默认应用打开 may
 * open the file. A picture sips cannot read, or a document with neither a
 * first page nor text, becomes the plain card (kind `binary`).
 */
export async function enrichFilePreview(
  preview: FilePreviewResult,
  converter: PreviewConverter,
): Promise<EnrichedPreview> {
  if (preview.kind === 'directory') return { preview, media: null }
  const shown: FilePreviewResult = {
    ...preview,
    openable: isOpenableFile(preview.path),
  }
  const card = (): EnrichedPreview => ({
    preview: { ...shown, kind: 'binary', content: undefined, truncated: false },
    media: null,
  })
  switch (shown.kind) {
    case 'video':
    case 'audio':
      return { preview: shown, media: { path: shown.path, mimeType: shown.mimeType } }
    case 'image': {
      if (!/^image\/(?:heic|heif|tiff)$/.test(shown.mimeType))
        return {
          preview: shown,
          media: { path: shown.path, mimeType: shown.mimeType },
        }
      const png = await converter.imagePng(shown.path)
      if (!png) return card()
      return {
        preview: { ...shown, converted: 'png' },
        media: { path: png, mimeType: 'image/png' },
      }
    }
    case 'document': {
      const [page, text] = await Promise.all([
        converter.thumbnail(shown.path),
        shown.content ? Promise.resolve(shown.content) : converter.text(shown.path),
      ])
      if (!page && !text) return card()
      return {
        preview: {
          ...shown,
          thumbnail: Boolean(page),
          ...(text
            ? {
                content: text,
                extractedText: true,
                truncated: Buffer.byteLength(text) >= MAX_TEXT_BYTES,
              }
            : {}),
        },
        media: page ? { path: page, mimeType: 'image/png' } : null,
      }
    }
    default:
      return { preview: shown, media: null }
  }
}
