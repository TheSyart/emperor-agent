import { randomBytes } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { PersistenceIoError, type PersistenceOperation } from './types'

export interface PersistenceStat {
  readonly mode: number
  readonly mtimeMs: number
  readonly size: number
}

export interface PersistenceAdapter {
  readonly directorySync: 'supported' | 'best_effort'
  exists(path: string): Promise<boolean>
  mkdir(path: string, mode: number): Promise<void>
  readText(path: string): Promise<string>
  writeExclusiveAndSync(path: string, body: string, mode: number): Promise<void>
  appendAndSync(path: string, body: string, mode: number): Promise<void>
  rename(source: string, destination: string): Promise<void>
  unlink(path: string): Promise<void>
  stat(path: string): Promise<PersistenceStat>
  syncDirectory(path: string): Promise<void>
}

export interface NodePersistenceAdapterOptions {
  readonly directorySync?: 'supported' | 'best_effort'
  beforeOperation?: (
    operation: PersistenceOperation,
    path: string,
  ) => void | Promise<void>
}

export function createNodePersistenceAdapter(
  options: NodePersistenceAdapterOptions = {},
): PersistenceAdapter {
  const before = options.beforeOperation
  const directorySync =
    options.directorySync ??
    (process.platform === 'win32' ? 'best_effort' : 'supported')

  async function run<T>(
    operation: PersistenceOperation,
    path: string,
    task: () => Promise<T>,
  ): Promise<T> {
    try {
      await before?.(operation, path)
      return await task()
    } catch (cause) {
      if (cause instanceof PersistenceIoError) throw cause
      throw new PersistenceIoError(operation, path, { cause })
    }
  }

  return {
    directorySync,
    async exists(path) {
      try {
        await stat(path)
        return true
      } catch (cause) {
        if (errorCode(cause) === 'ENOENT') return false
        throw new PersistenceIoError('stat', path, { cause })
      }
    },
    mkdir: (path, mode) =>
      run('mkdir', path, async () => {
        await mkdir(path, { recursive: true, mode })
      }),
    readText: (path) => run('read', path, () => readFile(path, 'utf8')),
    writeExclusiveAndSync: (path, body, mode) =>
      run('write', path, async () => {
        const handle = await open(
          path,
          fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
          mode,
        )
        try {
          await handle.writeFile(body, 'utf8')
          await handle.chmod(mode)
          await run('file_sync', path, () => handle.sync())
        } finally {
          await handle.close()
        }
      }),
    appendAndSync: (path, body, mode) =>
      run('write', path, async () => {
        const handle = await open(path, 'a', mode)
        try {
          await handle.chmod(mode)
          await handle.writeFile(body, 'utf8')
          await run('append_sync', path, () => handle.sync())
        } finally {
          await handle.close()
        }
      }),
    rename: (source, destination) =>
      run('rename', destination, () => rename(source, destination)),
    unlink: (path) => run('unlink', path, () => unlink(path)),
    stat: (path) =>
      run('stat', path, async () => {
        const value = await stat(path)
        return {
          mode: value.mode,
          mtimeMs: value.mtimeMs,
          size: value.size,
        }
      }),
    syncDirectory: (path) =>
      run('directory_sync', path, async () => {
        if (directorySync === 'best_effort') return
        const handle = await open(path, 'r')
        try {
          await handle.sync()
        } finally {
          await handle.close()
        }
      }),
  }
}

export const NODE_PERSISTENCE_ADAPTER = createNodePersistenceAdapter()

export interface DurableWriteOptions {
  readonly adapter?: PersistenceAdapter
  readonly fileMode?: number
  readonly directoryMode?: number
}

export async function durableReplace(
  path: string,
  body: string,
  options: DurableWriteOptions = {},
): Promise<void> {
  const adapter = options.adapter ?? NODE_PERSISTENCE_ADAPTER
  const directory = dirname(path)
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`
  await adapter.mkdir(directory, options.directoryMode ?? 0o700)
  try {
    await adapter.writeExclusiveAndSync(
      temporary,
      body,
      options.fileMode ?? 0o600,
    )
    await adapter.rename(temporary, path)
    await adapter.syncDirectory(directory)
  } catch (cause) {
    await adapter.unlink(temporary).catch(() => undefined)
    throw cause
  }
}

export async function quarantineFile(
  path: string,
  options: DurableWriteOptions = {},
  backupPath?: string,
): Promise<string> {
  const adapter = options.adapter ?? NODE_PERSISTENCE_ADAPTER
  const backup =
    backupPath ??
    `${path}.corrupt-${new Date()
      .toISOString()
      .replace(/[:.]/g, '-')}-${randomBytes(4).toString('hex')}`
  await adapter.rename(path, backup)
  await adapter.syncDirectory(dirname(path))
  return backup
}

export async function withPersistenceLock<T>(
  targetPath: string,
  task: () => Promise<T>,
  options: DurableWriteOptions & {
    readonly timeoutMs?: number
    readonly staleMs?: number
    readonly retryMs?: number
  } = {},
): Promise<T> {
  const adapter = options.adapter ?? NODE_PERSISTENCE_ADAPTER
  const lockPath = `${targetPath}.lock`
  const timeoutMs = options.timeoutMs ?? 5_000
  const staleMs = options.staleMs ?? 30_000
  const retryMs = options.retryMs ?? 10
  const deadline = Date.now() + timeoutMs
  await adapter.mkdir(dirname(targetPath), options.directoryMode ?? 0o700)

  while (true) {
    try {
      await adapter.writeExclusiveAndSync(
        lockPath,
        `${JSON.stringify({ pid: process.pid, createdAt: Date.now() })}\n`,
        options.fileMode ?? 0o600,
      )
      break
    } catch (cause) {
      if (!isAlreadyExists(cause)) throw cause
      try {
        const lock = await adapter.stat(lockPath)
        if (Date.now() - lock.mtimeMs > staleMs)
          await adapter.unlink(lockPath).catch(() => undefined)
      } catch (statCause) {
        if (!isMissing(statCause)) throw statCause
      }
      if (Date.now() >= deadline)
        throw new PersistenceIoError('write', lockPath, {
          cause: new Error('persistence lock timeout'),
        })
      await delay(retryMs)
    }
  }

  try {
    return await task()
  } finally {
    await adapter.unlink(lockPath).catch(() => undefined)
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isAlreadyExists(cause: unknown): boolean {
  return (
    errorCode(cause instanceof PersistenceIoError ? cause.cause : cause) ===
    'EEXIST'
  )
}

function isMissing(cause: unknown): boolean {
  return (
    errorCode(cause instanceof PersistenceIoError ? cause.cause : cause) ===
    'ENOENT'
  )
}

function errorCode(cause: unknown): string {
  return String((cause as NodeJS.ErrnoException | null)?.code ?? '')
}
