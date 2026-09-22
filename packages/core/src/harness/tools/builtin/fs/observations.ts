/**
 * Read-before-edit observation policy (ported from dsh-fs-observation-policy).
 *
 * Per-session, in-memory record of the latest authoritative observation of
 * each target (keyed by realpath-derived target key): `present` at an opaque
 * stat version, or confirmed `absent`. From it the mutating tools derive
 * their guards:
 *
 * - `write`: observed present ⇒ replace only if still at that version;
 *   unseen or observed absent ⇒ create only if absent.
 * - `edit`: unseen ⇒ `FS_NOT_OBSERVED`; observed absent ⇒ `FS_NOT_FOUND`;
 *   present ⇒ the observed version is the compare-and-set basis.
 *
 * Calls without a session (host-initiated) record nothing: they read freely
 * but cannot satisfy the edit policy, and their writes are create-only.
 */

import { FsError, type FsTarget } from './fsio'

export type FsObservation =
  { kind: 'present'; version: string } | { kind: 'absent' }

export type FsWriteIntent =
  { kind: 'replaceIfVersion'; version: string } | { kind: 'createIfAbsent' }

export class FsObservations {
  private readonly bySession = new Map<string, Map<string, FsObservation>>()

  /** The latest observation of `targetKey` by `sessionId`, if any. */
  get(
    sessionId: string | undefined,
    targetKey: string,
  ): FsObservation | undefined {
    if (sessionId === undefined) return undefined
    return this.bySession.get(sessionId)?.get(targetKey)
  }

  /** Record an authoritative present/absent observation (no-op without a session). */
  observe(
    sessionId: string | undefined,
    target: FsTarget,
    observation: FsObservation,
  ): void {
    if (sessionId === undefined) return
    let byTarget = this.bySession.get(sessionId)
    if (byTarget === undefined) {
      byTarget = new Map()
      this.bySession.set(sessionId, byTarget)
    }
    byTarget.set(target.targetKey, observation)
  }

  /** Decide the write guard for this session and target. */
  writeIntent(sessionId: string | undefined, target: FsTarget): FsWriteIntent {
    const prior = this.get(sessionId, target.targetKey)
    return prior?.kind === 'present'
      ? { kind: 'replaceIfVersion', version: prior.version }
      : { kind: 'createIfAbsent' }
  }

  /** Decide the edit version guard; throws when the target was never read (or was read as absent). */
  editIntent(
    sessionId: string | undefined,
    target: FsTarget,
  ): { version: string } {
    const prior = this.get(sessionId, target.targetKey)
    if (sessionId === undefined || prior === undefined) {
      throw new FsError(
        `edit requires reading "${target.displayPath}" first`,
        'FS_NOT_OBSERVED',
      )
    }
    if (prior.kind === 'absent') {
      throw new FsError(
        `cannot edit "${target.displayPath}": not found`,
        'FS_NOT_FOUND',
      )
    }
    return { version: prior.version }
  }

  /** Drop one session's state (session closed) or everything. */
  forget(sessionId?: string): void {
    if (sessionId === undefined) this.bySession.clear()
    else this.bySession.delete(sessionId)
  }
}
