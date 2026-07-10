import { existsSync, mkdirSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { SessionStore, type SessionEntry } from './store'

export function migrateLegacyMainlineToDefaultSession(
  root: string,
): SessionEntry | null {
  const store = new SessionStore(root)
  if (store.list({ includeArchived: true }).length > 0) return null
  const memoryDir = join(root, 'memory')
  const oldHistory = join(memoryDir, 'history.jsonl')
  if (!existsSync(oldHistory)) return null

  const session = store.create('Default')
  const sessionDir = store.sessionDir(session.id)
  mkdirSync(sessionDir, { recursive: true })
  moveIfExists(oldHistory, join(sessionDir, 'history.jsonl'))
  moveIfExists(
    join(memoryDir, '_checkpoint.json'),
    join(sessionDir, '_checkpoint.json'),
  )

  const runtimeDir = join(memoryDir, 'runtime')
  const sessionRuntimeDir = join(sessionDir, 'runtime')
  moveIfExists(
    join(runtimeDir, 'events.jsonl'),
    join(sessionRuntimeDir, 'events.jsonl'),
  )
  moveIfExists(join(runtimeDir, 'archive'), join(sessionRuntimeDir, 'archive'))
  return session
}

function moveIfExists(from: string, to: string): void {
  if (!existsSync(from)) return
  mkdirSync(dirname(to), { recursive: true })
  renameSync(from, to)
}
