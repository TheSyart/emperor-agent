import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { EmperorError } from '../../errors'

// REL-03: a file a newer Emperor wrote is read-only here.

export type VersionKey = 'version' | 'schemaVersion'

export const NEWER_FILE_MESSAGE = '这个文件来自更新版本的 Emperor，当前版本只读'

/** The version a document declares; a list declares its highest item's. */
export function declaredVersion(
  value: unknown,
  key: VersionKey,
): number | null {
  if (Array.isArray(value)) {
    let top: number | null = null
    for (const item of value) {
      const version = declaredVersion(item, key)
      if (version !== null && (top === null || version > top)) top = version
    }
    return top
  }
  const version =
    value && typeof value === 'object'
      ? (value as Record<string, unknown>)[key]
      : undefined
  return typeof version === 'number' && Number.isFinite(version)
    ? version
    : null
}

export class DataFileNewerError extends EmperorError {
  constructor(
    readonly path: string,
    readonly version: number,
    readonly supported: number,
  ) {
    super(`${NEWER_FILE_MESSAGE}：${basename(path)}`, 'data_file_newer')
  }
}

/** `value` with its declared version brought down to `supported`. */
export function asSupported(
  value: unknown,
  key: VersionKey,
  supported: number,
): unknown {
  if (Array.isArray(value))
    return value.map((item) => asSupported(item, key, supported))
  const version = declaredVersion(value, key)
  return version !== null && version > supported
    ? { ...(value as object), [key]: supported }
    : value
}

/** Files (by size:mtime) a write already found not newer. */
const writable = new Map<string, string>()

interface Stamp {
  size: number
  mtimeMs: number
}

export function knownWritable(path: string, stat: Stamp): boolean {
  return writable.get(path) === `${stat.size}:${stat.mtimeMs}`
}

export function rememberWritable(path: string, stat: Stamp | null): void {
  if (stat) writable.set(path, `${stat.size}:${stat.mtimeMs}`)
  else writable.delete(path)
}

/** The declared version of `text` when above `supported`, else null. */
export function newerVersionOf(
  text: string,
  key: VersionKey,
  supported: number,
): number | null {
  let version: number | null
  try {
    version = declaredVersion(JSON.parse(text), key)
  } catch {
    return null
  }
  return version !== null && version > supported ? version : null
}

/** Throws {@link DataFileNewerError} when `path` declares a newer version. */
export function assertNotNewerSync(
  path: string,
  key: VersionKey,
  supported: number,
): void {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return
  }
  const version = newerVersionOf(text, key, supported)
  if (version !== null) throw new DataFileNewerError(path, version, supported)
}
