/**
 * Site permissions for Agent browser profiles (spec 00 §7.4): camera,
 * microphone, location, notifications, clipboard and fullscreen are denied
 * unless the user allowed that exact kind for that exact origin in that
 * profile, optionally for a limited time. Stored in
 * `~/.emperor/browser/site-permissions.json` (0600); a corrupt file reads as
 * "nothing allowed". Only the user changes it (Settings / CoreApi).
 */

import { join } from 'node:path'
import { z } from 'zod'
import { AtomicSnapshotSync, type SnapshotCodec } from '../../store/persistence'
import { UiError } from './errors'
import { normalizeOrigin } from './grants/match'
import {
  SITE_PERMISSION_KINDS,
  type SitePermission,
  type SitePermissionKind,
} from './types'

export { SITE_PERMISSION_KINDS, type SitePermission, type SitePermissionKind }

export const SITE_PERMISSIONS_FILE = 'site-permissions.json'
const MAX_ENTRIES = 200

const entry = z
  .object({
    profileId: z.string().regex(/^(temporary|p_[0-9a-f]{12})$/),
    origin: z.string().min(1).max(512),
    kind: z.enum(SITE_PERMISSION_KINDS),
    createdAt: z.string().min(1).max(64),
    expiresAt: z.string().min(1).max(64).optional(),
  })
  .strict()

const schema = z
  .object({
    schemaVersion: z.literal(1),
    permissions: z.array(entry).max(MAX_ENTRIES),
  })
  .strict()

const CODEC: SnapshotCodec<SitePermission[]> = {
  schemaVersion: 1,
  encode: (value) => ({ schemaVersion: 1, permissions: value }),
  decode(input) {
    return { value: schema.parse(input).permissions, schemaVersion: 1 }
  },
}

export class SitePermissionStore {
  private readonly snapshot: AtomicSnapshotSync<SitePermission[]>
  private cached: SitePermission[] | null = null

  constructor(
    root: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.snapshot = new AtomicSnapshotSync({
      path: join(root, SITE_PERMISSIONS_FILE),
      codec: CODEC,
      fileMode: 0o600,
      directoryMode: 0o700,
      corruptionPolicy: 'quarantine_and_fallback',
    })
  }

  /** Live (unexpired) permissions. */
  list(): SitePermission[] {
    if (this.cached === null)
      this.cached = this.snapshot.read({ fallback: [] }).value
    const now = this.now().getTime()
    return this.cached.filter(
      (item) =>
        item.expiresAt === undefined || Date.parse(item.expiresAt) > now,
    )
  }

  allowed(
    profileId: string,
    origin: string,
    kind: SitePermissionKind,
  ): boolean {
    const normalized = normalizeOrigin(origin)
    if (normalized === null) return false
    return this.list().some(
      (item) =>
        item.profileId === profileId &&
        item.kind === kind &&
        item.origin === normalized,
    )
  }

  allow(input: {
    profileId: string
    origin: string
    kind: SitePermissionKind
    minutes?: number
  }): SitePermission {
    const origin = normalizeOrigin(input.origin)
    if (origin === null || !/^https?:\/\//.test(origin))
      throw new UiError('INVALID_REQUEST', 'an http(s) origin is required')
    const now = this.now()
    const next: SitePermission = {
      profileId: input.profileId,
      origin,
      kind: input.kind,
      createdAt: now.toISOString(),
      ...(input.minutes === undefined
        ? {}
        : {
            expiresAt: new Date(
              now.getTime() + input.minutes * 60_000,
            ).toISOString(),
          }),
    }
    const kept = this.list().filter(
      (item) =>
        !(
          item.profileId === next.profileId &&
          item.origin === next.origin &&
          item.kind === next.kind
        ),
    )
    if (kept.length >= MAX_ENTRIES)
      throw new UiError('BUDGET_EXCEEDED', 'too many site permissions')
    this.write([...kept, next])
    return next
  }

  /** Remove matching permissions; returns how many were removed. */
  revoke(filter: {
    profileId?: string
    origin?: string
    kind?: SitePermissionKind
  }): number {
    const origin =
      filter.origin === undefined ? undefined : normalizeOrigin(filter.origin)
    const current = this.list()
    const kept = current.filter(
      (item) =>
        !(
          (filter.profileId === undefined ||
            item.profileId === filter.profileId) &&
          (origin === undefined || item.origin === origin) &&
          (filter.kind === undefined || item.kind === filter.kind)
        ),
    )
    if (
      kept.length !== current.length ||
      this.cached?.length !== current.length
    )
      this.write(kept)
    return current.length - kept.length
  }

  private write(next: SitePermission[]): void {
    this.snapshot.write(next)
    this.cached = next
  }
}
