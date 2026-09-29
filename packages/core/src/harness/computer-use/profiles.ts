/**
 * Persistent browser profiles (spec 00 §7.2): metadata in
 * `~/.emperor/browser/profiles.json` (0600, atomic replace); the profile's
 * browsing data lives in `~/.emperor/browser/profiles/<profileId>/`, owned
 * by the embedded driver. The temporary profile is implicit and never stored.
 *
 * Ids are generated here (`p_` + 12 hex), never taken from a model or a
 * page, so a profile id is always safe as a directory name.
 */

import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import { AtomicSnapshotSync, type SnapshotCodec } from '../../store/persistence'
import { UiError } from './errors'

export const TEMPORARY_PROFILE_ID = 'temporary'
export const BROWSER_PROFILES_FILE = 'profiles.json'
export const MAX_BROWSER_PROFILES = 20
export const PROFILE_ID_PATTERN = /^p_[0-9a-f]{12}$/

export interface BrowserProfileRecord {
  readonly profileId: string
  readonly name: string
  readonly createdAt: string
  readonly lastUsedAt?: string
}

const record = z
  .object({
    profileId: z.string().regex(PROFILE_ID_PATTERN),
    name: z.string().min(1).max(60),
    createdAt: z.string().min(1).max(64),
    lastUsedAt: z.string().min(1).max(64).optional(),
  })
  .strict()

const schema = z
  .object({
    schemaVersion: z.literal(1),
    profiles: z.array(record).max(MAX_BROWSER_PROFILES),
  })
  .strict()

const CODEC: SnapshotCodec<BrowserProfileRecord[]> = {
  schemaVersion: 1,
  encode: (value) => ({ schemaVersion: 1, profiles: value }),
  decode(input) {
    return { value: schema.parse(input).profiles, schemaVersion: 1 }
  },
}

/** A profile name as users type it: trimmed, single-line, bounded. */
export function normalizeProfileName(name: string): string {
  const clean = name.replace(/\s+/g, ' ').trim()
  if (clean === '' || clean.length > 60)
    throw new UiError(
      'INVALID_REQUEST',
      'a profile name must be 1–60 characters',
    )
  return clean
}

export class BrowserProfileStore {
  private readonly snapshot: AtomicSnapshotSync<BrowserProfileRecord[]>
  private cached: BrowserProfileRecord[] | null = null

  constructor(
    root: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.snapshot = new AtomicSnapshotSync({
      path: join(root, BROWSER_PROFILES_FILE),
      codec: CODEC,
      fileMode: 0o600,
      directoryMode: 0o700,
      corruptionPolicy: 'quarantine_and_fallback',
    })
  }

  list(): BrowserProfileRecord[] {
    if (this.cached === null)
      this.cached = this.snapshot.read({ fallback: [] }).value
    return [...this.cached]
  }

  get(profileId: string): BrowserProfileRecord | undefined {
    return this.list().find((profile) => profile.profileId === profileId)
  }

  create(name: string): BrowserProfileRecord {
    const clean = normalizeProfileName(name)
    const current = this.list()
    if (current.length >= MAX_BROWSER_PROFILES)
      throw new UiError(
        'BUDGET_EXCEEDED',
        `at most ${MAX_BROWSER_PROFILES} browser profiles; delete one first`,
      )
    if (current.some((profile) => profile.name === clean))
      throw new UiError('INVALID_REQUEST', `a profile named "${clean}" exists`)
    const created: BrowserProfileRecord = {
      profileId: `p_${randomBytes(6).toString('hex')}`,
      name: clean,
      createdAt: this.now().toISOString(),
    }
    this.write([...current, created])
    return created
  }

  rename(profileId: string, name: string): BrowserProfileRecord {
    const clean = normalizeProfileName(name)
    const current = this.list()
    const found = current.find((profile) => profile.profileId === profileId)
    if (found === undefined)
      throw new UiError('INVALID_REQUEST', `no profile ${profileId}`)
    if (current.some((profile) => profile.name === clean && profile !== found))
      throw new UiError('INVALID_REQUEST', `a profile named "${clean}" exists`)
    const next = { ...found, name: clean }
    this.write(current.map((profile) => (profile === found ? next : profile)))
    return next
  }

  /** Record use (best effort: a write failure never blocks opening a tab). */
  touch(profileId: string): void {
    const current = this.list()
    if (!current.some((profile) => profile.profileId === profileId)) return
    try {
      this.write(
        current.map((profile) =>
          profile.profileId === profileId
            ? { ...profile, lastUsedAt: this.now().toISOString() }
            : profile,
        ),
      )
    } catch {
      // metadata only
    }
  }

  remove(profileId: string): boolean {
    const current = this.list()
    const next = current.filter((profile) => profile.profileId !== profileId)
    if (next.length === current.length) return false
    this.write(next)
    return true
  }

  private write(next: BrowserProfileRecord[]): void {
    this.snapshot.write(next)
    this.cached = next
  }
}
