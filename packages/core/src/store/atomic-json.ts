import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * 原子 JSON 存储 + 腐坏隔离。所有 snapshot store 共享同一写入不变量：
 * 写 tmp → rename 原子替换；解析失败 → 备份为
 * `*.corrupt-<ts>` → 返回默认 → 暴露给 diagnostics。**不变量**：终态写要么完整要么保留旧文件。
 */

export interface ConfigRecoveryInfo {
  path: string
  backupPath: string
  error: unknown
}

export interface ReadOptions<T = unknown> {
  /** 解析失败、已隔离损坏文件后回调（用于 diagnostics 可见，不静默吞）。 */
  onCorrupt?: (info: ConfigRecoveryInfo) => void
  /** 语义校验/转换；抛错时按损坏文件处理。 */
  validate?: (value: unknown) => T
}

export interface AtomicWriteOptions {
  mode?: number
}

function corruptName(path: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const nonce = randomBytes(4).toString('hex')
  return `${path}.corrupt-${ts}-${nonce}`
}

/** 把损坏文件原子移到 `*.corrupt-<ts>-<nonce>`，返回备份路径。 */
export async function isolateCorrupt(path: string): Promise<string> {
  const backup = corruptName(path)
  await rename(path, backup)
  return backup
}

/** 读 JSON；不存在或解析失败返回 fallback（失败时先隔离损坏文件）。 */
export async function readJson<T>(
  path: string,
  fallback: T,
  opts: ReadOptions<T> = {},
): Promise<T> {
  if (!existsSync(path)) return fallback
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    return fallback
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    return opts.validate ? opts.validate(parsed) : (parsed as T)
  } catch (error) {
    let backupPath = ''
    try {
      backupPath = await isolateCorrupt(path)
    } catch {
      // 隔离失败也不要因此再抛；继续返回默认。
    }
    opts.onCorrupt?.({ path, backupPath, error })
    return fallback
  }
}

/** 原子写 JSON：写同目录 tmp → rename 替换。失败清理 tmp 并抛。 */
export async function writeJsonAtomic(
  path: string,
  data: unknown,
  opts: AtomicWriteOptions = {},
): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`
  const body = `${JSON.stringify(data, null, 2)}\n`
  let handle: Awaited<ReturnType<typeof open>> | null = null
  try {
    handle = await open(tmp, 'wx', opts.mode ?? 0o666)
    await handle.writeFile(body, 'utf8')
    if (opts.mode !== undefined) await handle.chmod(opts.mode)
    await handle.sync()
    await handle.close()
    handle = null
    await rename(tmp, path)
  } catch (error) {
    await handle?.close().catch(() => {})
    await unlink(tmp).catch(() => {})
    throw error
  }
}
