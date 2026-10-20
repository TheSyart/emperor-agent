/**
 * 导出诊断包 (REL-01). `prepare()` writes the bundle into a private staging
 * folder and answers its contents (path, what it is, size), which the user
 * confirms; `export()` zips exactly that folder (`ditto -c -k`) to the place
 * the user chose. So the list shown is the zip's contents, file for file.
 *
 * In the bundle: Core's `diagnostics.get` (when Core runs), versions, fuse
 * state, Helper and extension status (`app.json`), the model_config
 * structure with every key removed, OS facts, the newest part of main.log
 * and core.log (redacted again, home shown as `~`) and the names of crash
 * dumps. Never in it: session or message text (fields that carry it are
 * dropped from the diagnostics), memory, keys or tokens, and the minidumps
 * themselves (they hold process memory).
 */
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { redactLogText } from '@emperor/core/host-capabilities'

export interface DiagnosticsBundleEntry {
  path: string
  title: string
  bytes: number
}

export interface DiagnosticsBundleView {
  id: string
  name: string
  entries: DiagnosticsBundleEntry[]
  excluded: string[]
}

export interface DiagnosticsBundleSources {
  /** main.log, core.log and their rotations. */
  logDir: string
  /** Crashpad's folder: dump names only. */
  crashDumps: string
  /** Emperor Home (model_config.json). */
  stateRoot: string
  /** Shown as `~` everywhere in the bundle. */
  homeDir: string
  /** Versions, fuses, Helper and extension status. */
  app(): Promise<Record<string, unknown>>
  /** Core's `diagnostics.get`; null while Core is not running. */
  core(): Promise<unknown> | null
  system(): Record<string, unknown>
}

export const BUNDLE_ID = /^b_[0-9a-f]{12}$/

const EXCLUDED = [
  '会话与消息内容',
  '记忆',
  'API Key、令牌等密钥',
  '崩溃转储文件本身（只列出文件名）',
]

const TITLES: Record<string, string> = {
  'README.txt': '说明：包含什么、不包含什么',
  'diagnostics.json': 'Core 诊断（diagnostics.get）',
  'app.json': '版本、fuse、Helper 与扩展状态',
  'model-config.json': '模型配置结构（不含 Key）',
  'system.json': '操作系统信息',
  'crashes.json': '崩溃转储清单（只有文件名）',
}

const LOG_FILES = ['main.log', 'main.log.1', 'core.log', 'core.log.1']
const REMOVED = '[已移除]'
/** Keys whose value never enters the bundle. */
const SECRET_KEY =
  /^(?:api[-_]?key|apikey|secret|password|passwd|authorization|cookie|headers|env|credentials?|[A-Za-z0-9_-]*(?:token|secret|password))$/i
/** Free text that comes from a conversation. */
const CONTENT_KEY =
  /^(?:description|label|prompt|objective|title|text|content|messages|transcript|preview)$/

interface Staged {
  view: DiagnosticsBundleView
  root: string
  folder: string
  timer: ReturnType<typeof setTimeout>
}

export class DiagnosticsBundles {
  private readonly staged = new Map<string, Staged>()
  private readonly exported = new Map<string, string>()
  private readonly zip: (folder: string, target: string) => Promise<void>
  private readonly now: () => Date

  constructor(
    private readonly options: {
      sources: DiagnosticsBundleSources
      tempDir: string
      zip?: (folder: string, target: string) => Promise<void>
      now?: () => Date
      logTailBytes?: number
      ttlMs?: number
    },
  ) {
    this.zip = options.zip ?? zipWithDitto
    this.now = options.now ?? (() => new Date())
  }

  async prepare(): Promise<DiagnosticsBundleView> {
    const src = this.options.sources
    const created = this.now()
    const id = `b_${randomBytes(6).toString('hex')}`
    const name = `emperor-diagnostics-${stamp(created)}`
    fs.mkdirSync(this.options.tempDir, { recursive: true })
    const root = fs.mkdtempSync(
      path.join(this.options.tempDir, 'emperor-diagnostics-'),
    )
    fs.chmodSync(root, 0o700)
    const folder = path.join(root, name)
    fs.mkdirSync(path.join(folder, 'logs'), { recursive: true, mode: 0o700 })
    try {
      const home = (text: string) => homeAsTilde(text, src.homeDir)
      const write = (file: string, value: unknown) =>
        fs.writeFileSync(
          path.join(folder, file),
          typeof value === 'string'
            ? value
            : `${JSON.stringify(value, null, 2)}\n`,
          { mode: 0o600 },
        )

      const core = src.core()
      write(
        'diagnostics.json',
        core
          ? {
              available: true,
              payload: sanitizeCoreDiagnostics(await core, src.homeDir),
            }
          : { available: false, reason: 'Core 没有启动，无法读取诊断' },
      )
      write('app.json', scrub(await src.app(), src.homeDir, false))
      write('model-config.json', this.modelConfig())
      write('system.json', scrub(src.system(), src.homeDir, false))
      write('crashes.json', {
        directory: home(src.crashDumps),
        reports: crashReports(src.crashDumps),
      })
      const tail = this.options.logTailBytes ?? 2 * 1024 * 1024
      for (const file of LOG_FILES) {
        const text = readTail(path.join(src.logDir, file), tail)
        if (text !== null) write(`logs/${file}`, home(redactLogText(text)))
      }
      const listed = filesIn(folder)
      write('README.txt', readme(created, [...listed, 'README.txt'].sort()))
      const entries = filesIn(folder).map((file) => ({
        path: file,
        title: titleOf(file),
        bytes: fs.statSync(path.join(folder, file)).size,
      }))
      const view = { id, name, entries, excluded: [...EXCLUDED] }
      const timer = setTimeout(
        () => this.discard(id),
        this.options.ttlMs ?? 15 * 60_000,
      )
      timer.unref?.()
      this.staged.set(id, { view, root, folder, timer })
      return view
    } catch (error) {
      fs.rmSync(root, { recursive: true, force: true })
      throw error
    }
  }

  async export(
    id: string,
    target: string,
  ): Promise<{
    name: string
    path: string
    entries: DiagnosticsBundleEntry[]
  }> {
    const staged = BUNDLE_ID.test(id) ? this.staged.get(id) : undefined
    if (!staged) throw new Error('诊断包已过期，请重新导出')
    const file = /\.zip$/i.test(target) ? target : `${target}.zip`
    const partial = `${file}.partial-${randomBytes(4).toString('hex')}`
    try {
      await this.zip(staged.folder, partial)
      fs.chmodSync(partial, 0o600)
      fs.renameSync(partial, file)
    } catch (error) {
      fs.rmSync(partial, { force: true })
      throw error
    }
    this.exported.set(id, file)
    this.discard(id)
    return {
      name: path.basename(file),
      path: file,
      entries: staged.view.entries,
    }
  }

  /** Where `export` put bundle `id`, for 在访达中显示. */
  exportedPath(id: string): string | null {
    return this.exported.get(id) ?? null
  }

  discard(id: string): void {
    const staged = this.staged.get(id)
    if (!staged) return
    clearTimeout(staged.timer)
    this.staged.delete(id)
    fs.rmSync(staged.root, { recursive: true, force: true })
  }

  disposeAll(): void {
    for (const id of [...this.staged.keys()]) this.discard(id)
  }

  private modelConfig(): unknown {
    const file = path.join(this.options.sources.stateRoot, 'model_config.json')
    if (!fs.existsSync(file)) return { exists: false }
    try {
      return sanitizeModelConfig(
        JSON.parse(fs.readFileSync(file, 'utf8')),
        this.options.sources.homeDir,
      )
    } catch {
      return { exists: true, error: 'model_config.json 无法解析' }
    }
  }
}

/** The model_config structure with every key, token and header removed. */
export function sanitizeModelConfig(raw: unknown, homeDir: string): unknown {
  return scrub(raw, homeDir, false)
}

/** Core's diagnostics without conversation text or secrets; home as `~`. */
export function sanitizeCoreDiagnostics(
  payload: unknown,
  homeDir: string,
): unknown {
  return scrub(payload, homeDir, true)
}

function scrub(
  value: unknown,
  homeDir: string,
  dropContent: boolean,
  depth = 0,
): unknown {
  if (depth > 12) return '[…]'
  if (typeof value === 'string')
    return homeAsTilde(redactLogText(value), homeDir)
  if (Array.isArray(value))
    return value.map((item) => scrub(item, homeDir, dropContent, depth + 1))
  if (!value || typeof value !== 'object') return value
  const output: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (dropContent && CONTENT_KEY.test(key)) continue
    if (SECRET_KEY.test(key)) {
      output[key] =
        child === '' || child === null || child === undefined ? child : REMOVED
      continue
    }
    output[key] = scrub(child, homeDir, dropContent, depth + 1)
  }
  return output
}

function homeAsTilde(text: string, homeDir: string): string {
  return homeDir && homeDir !== '/' ? text.split(homeDir).join('~') : text
}

function readTail(file: string, limit: number): string | null {
  let fd: number | null = null
  try {
    fd = fs.openSync(file, 'r')
    const size = fs.fstatSync(fd).size
    if (size === 0) return null
    const start = Math.max(0, size - limit)
    const buffer = Buffer.alloc(size - start)
    fs.readSync(fd, buffer, 0, buffer.length, start)
    let text = buffer.toString('utf8')
    if (start > 0) {
      // Start at a whole line.
      const newline = text.indexOf('\n')
      text = `（前面省略 ${start + newline + 1} 字节）\n${text.slice(newline + 1)}`
    }
    return text
  } catch {
    return null
  } finally {
    if (fd !== null) fs.closeSync(fd)
  }
}

function crashReports(dir: string): Array<Record<string, unknown>> {
  const reports: Array<Record<string, unknown>> = []
  const walk = (folder: string, depth: number) => {
    if (depth > 3) return
    let entries: fs.Dirent[] = []
    try {
      entries = fs.readdirSync(folder, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const file = path.join(folder, entry.name)
      if (entry.isDirectory()) walk(file, depth + 1)
      else if (entry.name.endsWith('.dmp')) {
        const stat = fs.statSync(file)
        reports.push({
          name: path.relative(dir, file),
          bytes: stat.size,
          modifiedAt: stat.mtime.toISOString(),
        })
      }
    }
  }
  walk(dir, 0)
  return reports.sort((a, b) => String(a.name).localeCompare(String(b.name)))
}

function filesIn(folder: string, prefix = ''): string[] {
  return fs
    .readdirSync(path.join(folder, prefix), { withFileTypes: true })
    .flatMap((entry) => {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      return entry.isDirectory() ? filesIn(folder, rel) : [rel]
    })
    .sort()
}

function titleOf(file: string): string {
  if (TITLES[file]) return TITLES[file]
  const rotated = /\.log\.\d+$/.test(file) ? '，上一份' : ''
  return file.startsWith('logs/main')
    ? `主进程日志（脱敏${rotated}）`
    : `Core 日志（脱敏${rotated}）`
}

function readme(created: Date, files: string[]): string {
  return [
    'Emperor Agent 诊断包',
    `生成时间：${created.toISOString()}`,
    '',
    '包含：',
    ...files.map((file) => `- ${file}：${titleOf(file)}`),
    '',
    '不包含：',
    ...EXCLUDED.map((item) => `- ${item}`),
    '',
    '日志与配置里的密钥已替换为 *** 或 [已移除]，用户主目录显示为 ~。',
    '这个文件只保存在你选择的位置，Emperor 不会上传它。',
    '',
  ].join('\n')
}

function stamp(date: Date): string {
  const two = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}-${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}`
}

/** macOS `ditto -c -k --keepParent`: a plain zip, no resource forks. */
export function zipWithDitto(folder: string, target: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      '/usr/bin/ditto',
      [
        '-c',
        '-k',
        '--norsrc',
        '--noextattr',
        '--noqtn',
        '--noacl',
        '--keepParent',
        folder,
        target,
      ],
      { timeout: 60_000 },
      (error) => (error ? reject(error) : resolve()),
    )
  })
}
