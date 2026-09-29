/**
 * GUI grant store (spec 00 §6.1). `grants.json` (0600, directory 0700,
 * atomic replace) is the source of truth for persistent grants; the session
 * log only records the facts of requests, decisions and revocations.
 *
 * Fail closed:
 * - a corrupt file is quarantined and the store comes up suspended (no grant
 *   matches) until the user resumes;
 * - the emergency stop suspends every grant, persisted across restarts;
 * - revoking or narrowing a grant bumps its revision, so a ticket issued
 *   against the old revision stops matching.
 */

import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { AtomicSnapshotSync } from '../../../store/persistence'
import type { UiActionClass, UiGrant } from '../types'
import {
  GRANTS_CODEC,
  type GrantSuspension,
  type GrantsDocument,
} from './codec'

export const GRANTS_FILE = 'grants.json'

export type GrantRevokeCause =
  'user' | 'expiry' | 'kill-switch' | 'session-end' | 'task-end'

export interface GrantChange {
  readonly kind: 'issued' | 'revoked' | 'narrowed' | 'suspended' | 'resumed'
  readonly grant?: UiGrant
  readonly cause?: GrantRevokeCause
}

export type GrantIssueInput = Omit<
  UiGrant,
  'grantId' | 'revision' | 'createdAt'
>

export interface GrantStoreOptions {
  /** `~/.emperor/computer-use` */
  readonly root: string
  readonly now?: () => Date
  readonly idFactory?: () => string
}

export class GrantStore {
  private readonly snapshot: AtomicSnapshotSync<GrantsDocument>
  private readonly now: () => Date
  private readonly idFactory: () => string
  private readonly grants = new Map<string, UiGrant>()
  private suspension: GrantSuspension | null = null
  private readonly listeners = new Set<(change: GrantChange) => void>()
  private loaded = false

  constructor(options: GrantStoreOptions) {
    this.snapshot = new AtomicSnapshotSync({
      path: join(options.root, GRANTS_FILE),
      codec: GRANTS_CODEC,
      fileMode: 0o600,
      directoryMode: 0o700,
      corruptionPolicy: 'quarantine_and_fallback',
    })
    this.now = options.now ?? (() => new Date())
    this.idFactory = options.idFactory ?? (() => `grant_${randomUUID()}`)
  }

  get path(): string {
    return this.snapshot.path
  }

  /** Read the persisted grants; expired entries are dropped. */
  load(): void {
    const result = this.snapshot.read({
      fallback: { grants: [], suspended: null },
    })
    this.grants.clear()
    this.suspension = result.value.suspended
    if (result.receipt.recoveryAction === 'quarantined_corrupt_snapshot') {
      this.suspension = { at: this.now().toISOString(), by: 'corrupt-store' }
    }
    for (const grant of result.value.grants)
      if (!this.expired(grant)) this.grants.set(grant.grantId, grant)
    this.loaded = true
    if (
      result.receipt.recoveryAction === 'quarantined_corrupt_snapshot' ||
      result.value.grants.length !== this.grants.size
    )
      this.persist()
  }

  onChange(listener: (change: GrantChange) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  get suspended(): GrantSuspension | null {
    this.ensureLoaded()
    return this.suspension
  }

  /** Active (unexpired) grants. */
  list(): UiGrant[] {
    this.ensureLoaded()
    this.pruneExpired()
    return [...this.grants.values()].filter((grant) =>
      this.delegationValid(grant, new Set()),
    )
  }

  get(grantId: string): UiGrant | undefined {
    this.ensureLoaded()
    const grant = this.grants.get(grantId)
    return grant === undefined ||
      this.expired(grant) ||
      !this.delegationValid(grant, new Set())
      ? undefined
      : grant
  }

  /** A revoked or narrowed source invalidates every delegated child at once. */
  private delegationValid(grant: UiGrant, seen: Set<string>): boolean {
    const link = grant.delegatedFrom
    if (!link) return true
    if (seen.has(grant.grantId)) return false
    seen.add(grant.grantId)
    const source = this.grants.get(link.grantId)
    if (
      !source ||
      source.revision !== link.revision ||
      this.expired(source) ||
      !source.backgroundAllowed
    )
      return false
    if (source.ownerSessionId !== grant.ownerSessionId) return false
    if (
      !grant.allowedActions.every((action) =>
        source.allowedActions.includes(action),
      )
    )
      return false
    if (source.targetScope.kind !== grant.targetScope.kind) return false
    if (
      source.targetScope.kind === 'browser' &&
      grant.targetScope.kind === 'browser'
    ) {
      const sourceScope = source.targetScope
      if (
        sourceScope.profileId !== grant.targetScope.profileId ||
        !grant.targetScope.origins.every((origin) =>
          sourceScope.origins.includes(origin),
        )
      )
        return false
    } else if (
      source.targetScope.kind === 'desktop' &&
      grant.targetScope.kind === 'desktop'
    ) {
      if (
        source.targetScope.appId !== grant.targetScope.appId ||
        (source.targetScope.windowRef &&
          source.targetScope.windowRef !== grant.targetScope.windowRef)
      )
        return false
    }
    return this.delegationValid(source, seen)
  }

  issue(input: GrantIssueInput): UiGrant {
    this.ensureLoaded()
    const grant: UiGrant = {
      ...input,
      allowedActions: [...new Set(input.allowedActions)],
      grantId: this.idFactory(),
      createdAt: this.now().toISOString(),
      revision: 1,
    }
    this.grants.set(grant.grantId, grant)
    if (grant.scope === 'session' || grant.scope === 'timed') this.persist()
    this.emit({ kind: 'issued', grant })
    return grant
  }

  revoke(grantId: string, cause: GrantRevokeCause): UiGrant | undefined {
    this.ensureLoaded()
    const grant = this.grants.get(grantId)
    if (grant === undefined) return undefined
    this.grants.delete(grantId)
    if (grant.scope === 'session' || grant.scope === 'timed') this.persist()
    this.emit({ kind: 'revoked', grant, cause })
    return grant
  }

  revokeWhere(
    predicate: (grant: UiGrant) => boolean,
    cause: GrantRevokeCause,
  ): UiGrant[] {
    this.ensureLoaded()
    const revoked = [...this.grants.values()].filter(predicate)
    if (revoked.length === 0) return []
    for (const grant of revoked) this.grants.delete(grant.grantId)
    if (
      revoked.some(
        (grant) => grant.scope === 'session' || grant.scope === 'timed',
      )
    )
      this.persist()
    for (const grant of revoked) this.emit({ kind: 'revoked', grant, cause })
    return revoked
  }

  /** Narrow a grant's action set or origins; the revision goes up. */
  narrow(
    grantId: string,
    change: {
      allowedActions?: readonly UiActionClass[]
      origins?: readonly string[]
    },
  ): UiGrant | undefined {
    this.ensureLoaded()
    const grant = this.grants.get(grantId)
    if (grant === undefined) return undefined
    const allowedActions =
      change.allowedActions === undefined
        ? grant.allowedActions
        : grant.allowedActions.filter((action) =>
            change.allowedActions!.includes(action),
          )
    let targetScope = grant.targetScope
    if (change.origins !== undefined && targetScope.kind === 'browser') {
      targetScope = {
        ...targetScope,
        origins: targetScope.origins.filter((origin) =>
          change.origins!.includes(origin),
        ),
      }
    }
    if (
      allowedActions.length === 0 ||
      (targetScope.kind === 'browser' && targetScope.origins.length === 0)
    ) {
      this.revoke(grantId, 'user')
      return undefined
    }
    const narrowed: UiGrant = {
      ...grant,
      allowedActions,
      targetScope,
      revision: grant.revision + 1,
    }
    this.grants.set(grantId, narrowed)
    if (narrowed.scope === 'session' || narrowed.scope === 'timed')
      this.persist()
    this.emit({ kind: 'narrowed', grant: narrowed })
    return narrowed
  }

  /** Emergency stop: nothing matches until {@link resume}. Persisted. */
  suspend(by: GrantSuspension['by']): void {
    this.ensureLoaded()
    this.suspension = { at: this.now().toISOString(), by }
    this.persist()
    this.emit({ kind: 'suspended' })
  }

  resume(): void {
    this.ensureLoaded()
    if (this.suspension === null) return
    this.suspension = null
    this.persist()
    this.emit({ kind: 'resumed' })
  }

  /** Remove expired grants; returns what was removed. */
  pruneExpired(): UiGrant[] {
    const expired = [...this.grants.values()].filter((grant) =>
      this.expired(grant),
    )
    if (expired.length === 0) return []
    for (const grant of expired) this.grants.delete(grant.grantId)
    if (
      expired.some(
        (grant) => grant.scope === 'session' || grant.scope === 'timed',
      )
    )
      this.persist()
    for (const grant of expired)
      this.emit({ kind: 'revoked', grant, cause: 'expiry' })
    return expired
  }

  expired(grant: UiGrant): boolean {
    return (
      grant.expiresAt !== undefined &&
      Date.parse(grant.expiresAt) <= this.now().getTime()
    )
  }

  private ensureLoaded(): void {
    if (!this.loaded) this.load()
  }

  private persist(): void {
    this.snapshot.write({
      grants: [...this.grants.values()],
      suspended: this.suspension,
    })
  }

  private emit(change: GrantChange): void {
    for (const listener of this.listeners) {
      try {
        listener(change)
      } catch {
        // listeners must not break the store
      }
    }
  }
}
