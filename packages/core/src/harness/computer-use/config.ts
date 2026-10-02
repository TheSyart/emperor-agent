/**
 * `~/.emperor/computer-use/config.json`: the user's master switch and
 * per-driver switches (0600, atomic replace). Off by default — the
 * capability is evaluation-gated (`capabilities/portfolio.ts`). A corrupt
 * file reads as "off".
 *
 * The retired per-item mode (`authorizationMode: 'scoped'`, 2026-09-29):
 * the AI now drives continuously while the switch is on, so a file that
 * still asks for the per-item mode reads as switched off with a notice for
 * Settings, and is written back once without the field. Switching on again
 * clears the notice. Permissions never widen without the user knowing.
 *
 * The retired app lists and emergency-stop shortcut (`appLists`,
 * `killSwitchAccelerator`, 2026-10-01): Emperor operates every app except
 * the system-protected ones, and the emergency stop is gone. Both fields are
 * read without validation (a leftover never quarantines the file) and
 * written back once without them. The apps the user had kept from Emperor
 * are remembered in `retired-protected-apps.json` until Settings has shown
 * them once, so the wider reach is never silent.
 */

import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { AtomicSnapshotSync, type SnapshotCodec } from '../../store/persistence'
import type { ComputerUseSettings } from './service/service'
import type { DriverKind } from './types'

export const COMPUTER_USE_CONFIG_FILE = 'config.json'
export const RETIRED_PROTECTED_APPS_FILE = 'retired-protected-apps.json'

export interface ComputerUseConfig extends ComputerUseSettings {
  readonly enabled: boolean
  /**
   * The saved per-item mode was retired and switched computer use off; set
   * until the user switches it on again (Settings shows why it is off).
   */
  readonly scopedRetired?: true
  readonly drivers: Partial<Record<DriverKind, boolean>>
  /**
   * Days a download stays in the inbox before it is deleted (00 §10
   * 保留策略); 0 keeps it until the user removes it. Files moved to the
   * workspace are never touched.
   */
  readonly downloadRetentionDays: number
}

export const DOWNLOAD_RETENTION_DAYS = [0, 7, 30, 90] as const
export const DEFAULT_DOWNLOAD_RETENTION_DAYS = 30

/** A bundle ID (macOS) or app identity a retired list may have held. */
const APP_IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/
const APP_LIST_LIMIT = 100

const schema = z
  .object({
    schemaVersion: z.literal(1),
    enabled: z.boolean(),
    /** Retired: read once to switch a per-item file off, never written. */
    authorizationMode: z.enum(['unrestricted', 'scoped']).optional(),
    scopedRetired: z.literal(true).optional(),
    /** Retired 2026-10-01: read once, never validated, never written. */
    killSwitchAccelerator: z.unknown().optional(),
    appLists: z.unknown().optional(),
    downloadRetentionDays: z
      .union([z.literal(0), z.literal(7), z.literal(30), z.literal(90)])
      .optional(),
    drivers: z
      .object({
        'embedded-browser': z.boolean().optional(),
        'external-browser': z.boolean().optional(),
        desktop: z.boolean().optional(),
      })
      .strict()
      .default({}),
  })
  .strict()

const CODEC: SnapshotCodec<ComputerUseConfig> = {
  schemaVersion: 1,
  encode: (value) => ({
    schemaVersion: 1,
    enabled: value.enabled,
    ...(value.scopedRetired === true ? { scopedRetired: true } : {}),
    drivers: value.drivers,
    downloadRetentionDays: value.downloadRetentionDays,
  }),
  decode(input) {
    const parsed = schema.parse(input)
    const retiring = parsed.authorizationMode === 'scoped'
    return {
      value: {
        enabled: retiring ? false : parsed.enabled,
        ...(retiring || parsed.scopedRetired === true
          ? { scopedRetired: true as const }
          : {}),
        drivers: parsed.drivers,
        downloadRetentionDays:
          parsed.downloadRetentionDays ?? DEFAULT_DOWNLOAD_RETENTION_DAYS,
      },
      schemaVersion: 1,
      ...(parsed.authorizationMode === undefined &&
      parsed.killSwitchAccelerator === undefined &&
      parsed.appLists === undefined
        ? {}
        : { migrated: true }),
    }
  },
}

const DEFAULTS: ComputerUseConfig = {
  enabled: false,
  drivers: {},
  downloadRetentionDays: DEFAULT_DOWNLOAD_RETENTION_DAYS,
}

interface RetiredProtectedApps {
  readonly apps: readonly string[]
}

const RETIRED_CODEC: SnapshotCodec<RetiredProtectedApps> = {
  schemaVersion: 1,
  encode: (value) => ({ schemaVersion: 1, apps: value.apps }),
  decode: (input) => ({
    value: {
      apps: z
        .object({
          schemaVersion: z.literal(1),
          apps: z.array(z.string().regex(APP_IDENTITY)).max(APP_LIST_LIMIT),
        })
        .strict()
        .parse(input).apps,
    },
    schemaVersion: 1,
  }),
}

/** The protected apps a retired `appLists` held (valid ids, deduplicated). */
function retiringProtectedApps(path: string): string[] {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as {
      appLists?: { protected?: unknown }
    }
    const ids = raw.appLists?.protected
    if (!Array.isArray(ids)) return []
    return [
      ...new Set(
        ids.filter(
          (id): id is string => typeof id === 'string' && APP_IDENTITY.test(id),
        ),
      ),
    ].slice(0, APP_LIST_LIMIT)
  } catch {
    return []
  }
}

export class ComputerUseConfigStore {
  private readonly snapshot: AtomicSnapshotSync<ComputerUseConfig>
  private readonly retired: AtomicSnapshotSync<RetiredProtectedApps>
  private cached: ComputerUseConfig | null = null
  private retiredCached: readonly string[] | null = null

  constructor(root: string) {
    this.snapshot = new AtomicSnapshotSync({
      path: join(root, COMPUTER_USE_CONFIG_FILE),
      codec: CODEC,
      fileMode: 0o600,
      directoryMode: 0o700,
      corruptionPolicy: 'quarantine_and_fallback',
    })
    this.retired = new AtomicSnapshotSync({
      path: join(root, RETIRED_PROTECTED_APPS_FILE),
      codec: RETIRED_CODEC,
      fileMode: 0o600,
      directoryMode: 0o700,
      corruptionPolicy: 'quarantine_and_fallback',
    })
  }

  get(): ComputerUseConfig {
    if (this.cached === null) {
      const result = this.snapshot.read({ fallback: DEFAULTS })
      this.cached = result.value
      // Drop the retired fields from disk once (the value is already safe),
      // keeping the apps the user had protected for Settings to show.
      if (result.receipt.recoveryAction === 'migrated_in_memory') {
        const apps = retiringProtectedApps(this.snapshot.path)
        if (apps.length > 0) this.retired.write({ apps })
        this.snapshot.write(result.value)
      }
    }
    return this.cached
  }

  /** Apps the user had kept from Emperor that it can operate now. */
  retiredProtectedApps(): readonly string[] {
    this.get()
    this.retiredCached ??= this.retired.read({
      fallback: { apps: [] },
    }).value.apps
    return this.retiredCached
  }

  /** Settings has shown the notice: forget the list. */
  acknowledgeRetiredProtectedApps(): void {
    rmSync(this.retired.path, { force: true })
    this.retiredCached = []
  }

  update(change: {
    enabled?: boolean
    drivers?: Partial<Record<DriverKind, boolean>>
    downloadRetentionDays?: (typeof DOWNLOAD_RETENTION_DAYS)[number]
  }): ComputerUseConfig {
    const current = this.get()
    const enabled = change.enabled ?? current.enabled
    const next: ComputerUseConfig = {
      enabled,
      // Switching on again is the user's confirmation after the notice.
      ...(current.scopedRetired === true && !enabled
        ? { scopedRetired: true as const }
        : {}),
      drivers: { ...current.drivers, ...(change.drivers ?? {}) },
      downloadRetentionDays:
        change.downloadRetentionDays ?? current.downloadRetentionDays,
    }
    this.snapshot.write(next)
    this.cached = next
    return next
  }
}
