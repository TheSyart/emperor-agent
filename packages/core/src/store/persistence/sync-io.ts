import { randomBytes } from 'node:crypto'
import {
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'
import { PersistenceIoError, type PersistenceOperation } from './types'

export interface SyncPersistenceStat {
  readonly mode: number
  readonly mtimeMs: number
  readonly size: number
}

/** Synchronous facade for domain stores whose public API is intentionally sync. */
export interface SyncPersistenceAdapter {
  readonly directorySync: 'supported' | 'best_effort'
  exists(path: string): boolean
  mkdir(path: string, mode: number): void
  readText(path: string): string
  writeExclusive(path: string, body: string, mode: number): void
  writeExclusiveAndSync(path: string, body: string, mode: number): void
  appendAndSync(path: string, body: string, mode: number): void
  rename(source: string, destination: string): void
  unlink(path: string): void
  stat(path: string): SyncPersistenceStat
  syncDirectory(path: string): void
}

export interface NodeSyncPersistenceAdapterOptions {
  readonly directorySync?: 'supported' | 'best_effort'
  beforeOperation?: (operation: PersistenceOperation, path: string) => void
}

export function createNodeSyncPersistenceAdapter(
  options: NodeSyncPersistenceAdapterOptions = {},
): SyncPersistenceAdapter {
  const before = options.beforeOperation
  const directorySync =
    options.directorySync ??
    (process.platform === 'win32' ? 'best_effort' : 'supported')

  function run<T>(
    operation: PersistenceOperation,
    path: string,
    task: () => T,
  ): T {
    try {
      before?.(operation, path)
      return task()
    } catch (cause) {
      if (cause instanceof PersistenceIoError) throw cause
      throw new PersistenceIoError(operation, path, { cause })
    }
  }

  function writeAndSync(
    operation: 'write' | 'append_sync',
    path: string,
    body: string,
    flags: number,
    mode: number,
  ): void {
    run(operation === 'write' ? 'write' : 'append_sync', path, () => {
      const descriptor = openSync(path, flags, mode)
      try {
        fchmodSync(descriptor, mode)
        writeFileSync(descriptor, body, 'utf8')
        run(operation === 'write' ? 'file_sync' : 'append_sync', path, () =>
          fsyncSync(descriptor),
        )
      } finally {
        closeSync(descriptor)
      }
    })
  }

  return {
    directorySync,
    exists(path) {
      try {
        statSync(path)
        return true
      } catch (cause) {
        if (errorCode(cause) === 'ENOENT') return false
        throw new PersistenceIoError('stat', path, { cause })
      }
    },
    mkdir: (path, mode) =>
      run('mkdir', path, () => {
        mkdirSync(path, { recursive: true, mode })
      }),
    readText: (path) => run('read', path, () => readFileSync(path, 'utf8')),
    writeExclusive: (path, body, mode) =>
      run('write', path, () => {
        const descriptor = openSync(
          path,
          fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
          mode,
        )
        try {
          fchmodSync(descriptor, mode)
          writeFileSync(descriptor, body, 'utf8')
        } finally {
          closeSync(descriptor)
        }
      }),
    writeExclusiveAndSync: (path, body, mode) =>
      writeAndSync(
        'write',
        path,
        body,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
        mode,
      ),
    appendAndSync: (path, body, mode) =>
      writeAndSync(
        'append_sync',
        path,
        body,
        fsConstants.O_CREAT | fsConstants.O_APPEND | fsConstants.O_WRONLY,
        mode,
      ),
    rename: (source, destination) =>
      run('rename', destination, () => renameSync(source, destination)),
    unlink: (path) => run('unlink', path, () => unlinkSync(path)),
    stat: (path) =>
      run('stat', path, () => {
        const value = statSync(path)
        return {
          mode: value.mode,
          mtimeMs: value.mtimeMs,
          size: value.size,
        }
      }),
    syncDirectory: (path) =>
      run('directory_sync', path, () => {
        if (directorySync === 'best_effort') return
        const descriptor = openSync(path, 'r')
        try {
          fsyncSync(descriptor)
        } finally {
          closeSync(descriptor)
        }
      }),
  }
}

export const NODE_SYNC_PERSISTENCE_ADAPTER = createNodeSyncPersistenceAdapter()

export interface SyncDurableWriteOptions {
  readonly adapter?: SyncPersistenceAdapter
  readonly fileMode?: number
  readonly directoryMode?: number
}

export function durableReplaceSync(
  path: string,
  body: string,
  options: SyncDurableWriteOptions = {},
): void {
  const adapter = options.adapter ?? NODE_SYNC_PERSISTENCE_ADAPTER
  const directory = dirname(path)
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`
  adapter.mkdir(directory, options.directoryMode ?? 0o700)
  try {
    adapter.writeExclusiveAndSync(temporary, body, options.fileMode ?? 0o600)
    adapter.rename(temporary, path)
    adapter.syncDirectory(directory)
  } catch (cause) {
    try {
      adapter.unlink(temporary)
    } catch {
      // Preserve the original failure; cleanup is best effort.
    }
    throw cause
  }
}

export function quarantineFileSync(
  path: string,
  options: SyncDurableWriteOptions = {},
  backupPath?: string,
): string {
  const adapter = options.adapter ?? NODE_SYNC_PERSISTENCE_ADAPTER
  const backup =
    backupPath ??
    `${path}.corrupt-${new Date()
      .toISOString()
      .replace(/[:.]/g, '-')}-${randomBytes(4).toString('hex')}`
  adapter.rename(path, backup)
  adapter.syncDirectory(dirname(path))
  return backup
}

export function withPersistenceLockSync<T>(
  targetPath: string,
  task: () => T,
  options: SyncDurableWriteOptions & {
    readonly timeoutMs?: number
    readonly staleMs?: number
    readonly retryMs?: number
  } = {},
): T {
  const adapter = options.adapter ?? NODE_SYNC_PERSISTENCE_ADAPTER
  const lockPath = `${targetPath}.lock`
  const timeoutMs = options.timeoutMs ?? 5_000
  const staleMs = options.staleMs ?? 30_000
  const retryMs = options.retryMs ?? 10
  const deadline = Date.now() + timeoutMs
  adapter.mkdir(dirname(targetPath), options.directoryMode ?? 0o700)

  while (true) {
    try {
      adapter.writeExclusive(
        lockPath,
        `${JSON.stringify({ pid: process.pid, createdAt: Date.now() })}\n`,
        options.fileMode ?? 0o600,
      )
      break
    } catch (cause) {
      if (!isAlreadyExists(cause)) throw cause
      try {
        const lock = adapter.stat(lockPath)
        if (Date.now() - lock.mtimeMs > staleMs) {
          try {
            adapter.unlink(lockPath)
          } catch {
            // Another writer may have reclaimed it first.
          }
        }
      } catch (statCause) {
        if (!isMissing(statCause)) throw statCause
      }
      if (Date.now() >= deadline)
        throw new PersistenceIoError('write', lockPath, {
          cause: new Error('persistence lock timeout'),
        })
      waitSync(retryMs)
    }
  }

  try {
    return task()
  } finally {
    try {
      adapter.unlink(lockPath)
    } catch {
      // A stale-lock recovery racing at shutdown must not mask the task result.
    }
  }
}

function waitSync(ms: number): void {
  const signal = new Int32Array(
    new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT),
  )
  Atomics.wait(signal, 0, 0, ms)
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
