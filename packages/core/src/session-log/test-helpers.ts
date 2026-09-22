/** Test-only helpers for session-log specs. */
import { Session } from './session'
import type { SessionEvent } from './types'

/** Equivalent of dsh `Session.create(id, seed?)`. */
export function testSession(
  id: string,
  seed?: readonly SessionEvent[],
): Session {
  return new Session({ version: 0, id, createdAt: 0 }, seed ?? [], 'seed')
}
