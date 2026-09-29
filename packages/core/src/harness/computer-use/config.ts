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
 */

import { join } from 'node:path'
import { z } from 'zod'
import { AtomicSnapshotSync, type SnapshotCodec } from '../../store/persistence'
import type { AppListKind, ComputerUseSettings } from './service/service'
import type { DriverKind } from './types'

export const COMPUTER_USE_CONFIG_FILE = 'config.json'

export interface ComputerUseConfig extends ComputerUseSettings {
  readonly enabled: boolean
  /**
   * The saved per-item mode was retired and switched computer use off; set
   * until the user switches it on again (Settings shows why it is off).
   */
  readonly scopedRetired?: true
  readonly drivers: Partial<Record<DriverKind, boolean>>
  /** The user's emergency-stop shortcut (absent: the platform default). */
  readonly killSwitchAccelerator?: string
  /** The user's additions to the protected / high-risk / sensitive apps. */
  readonly appLists: Record<AppListKind, readonly string[]>
  /**
   * Days a download stays in the inbox before it is deleted (00 §10
   * 保留策略); 0 keeps it until the user removes it. Files moved to the
   * workspace are never touched.
   */
  readonly downloadRetentionDays: number
}

export const DOWNLOAD_RETENTION_DAYS = [0, 7, 30, 90] as const
export const DEFAULT_DOWNLOAD_RETENTION_DAYS = 30

/** A bundle ID (macOS) or app identity the user adds to a list. */
export const APP_IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/
export const APP_LIST_LIMIT = 100

/**
 * An Electron accelerator: modifiers and one key joined by `+`, e.g.
 * `Control+Alt+Command+.` (spec 00 §6.6: changeable in Settings).
 */
export const KILL_SWITCH_ACCELERATOR =
  /^(?:(?:Command|Cmd|Control|Ctrl|CommandOrControl|CmdOrCtrl|Alt|Option|AltGr|Shift|Super|Meta)\+){1,4}(?:[A-Z0-9]|F(?:[1-9]|1[0-9]|2[0-4])|[.,;'`=\-/\\[\]]|Space|Tab|Backspace|Delete|Insert|Return|Enter|Up|Down|Left|Right|Home|End|PageUp|PageDown|Escape|Esc)$/

const schema = z
  .object({
    schemaVersion: z.literal(1),
    enabled: z.boolean(),
    /** Retired: read once to switch a per-item file off, never written. */
    authorizationMode: z.enum(['unrestricted', 'scoped']).optional(),
    scopedRetired: z.literal(true).optional(),
    killSwitchAccelerator: z
      .string()
      .max(64)
      .regex(KILL_SWITCH_ACCELERATOR)
      .optional(),
    downloadRetentionDays: z
      .union([z.literal(0), z.literal(7), z.literal(30), z.literal(90)])
      .optional(),
    appLists: z
      .object({
        protected: z.array(z.string().regex(APP_IDENTITY)).max(APP_LIST_LIMIT),
        highRisk: z.array(z.string().regex(APP_IDENTITY)).max(APP_LIST_LIMIT),
        sensitive: z.array(z.string().regex(APP_IDENTITY)).max(APP_LIST_LIMIT),
      })
      .strict()
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
    appLists: value.appLists,
    downloadRetentionDays: value.downloadRetentionDays,
    ...(value.killSwitchAccelerator === undefined
      ? {}
      : { killSwitchAccelerator: value.killSwitchAccelerator }),
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
        appLists: parsed.appLists ?? EMPTY_LISTS,
        downloadRetentionDays:
          parsed.downloadRetentionDays ?? DEFAULT_DOWNLOAD_RETENTION_DAYS,
        ...(parsed.killSwitchAccelerator === undefined
          ? {}
          : { killSwitchAccelerator: parsed.killSwitchAccelerator }),
      },
      schemaVersion: 1,
      ...(parsed.authorizationMode === undefined ? {} : { migrated: true }),
    }
  },
}

const EMPTY_LISTS: Record<AppListKind, readonly string[]> = {
  protected: [],
  highRisk: [],
  sensitive: [],
}

const DEFAULTS: ComputerUseConfig = {
  enabled: false,
  drivers: {},
  appLists: EMPTY_LISTS,
  downloadRetentionDays: DEFAULT_DOWNLOAD_RETENTION_DAYS,
}

export class ComputerUseConfigStore {
  private readonly snapshot: AtomicSnapshotSync<ComputerUseConfig>
  private cached: ComputerUseConfig | null = null

  constructor(root: string) {
    this.snapshot = new AtomicSnapshotSync({
      path: join(root, COMPUTER_USE_CONFIG_FILE),
      codec: CODEC,
      fileMode: 0o600,
      directoryMode: 0o700,
      corruptionPolicy: 'quarantine_and_fallback',
    })
  }

  get(): ComputerUseConfig {
    if (this.cached === null) {
      const result = this.snapshot.read({ fallback: DEFAULTS })
      this.cached = result.value
      // Drop the retired field from disk once (the value is already safe).
      if (result.receipt.recoveryAction === 'migrated_in_memory')
        this.snapshot.write(result.value)
    }
    return this.cached
  }

  update(change: {
    enabled?: boolean
    drivers?: Partial<Record<DriverKind, boolean>>
    /** `null` restores the platform default. */
    killSwitchAccelerator?: string | null
    /** Replace whole lists (deduplicated, bounded). */
    appLists?: Partial<Record<AppListKind, readonly string[]>>
    downloadRetentionDays?: (typeof DOWNLOAD_RETENTION_DAYS)[number]
  }): ComputerUseConfig {
    const current = this.get()
    const accelerator =
      change.killSwitchAccelerator === undefined
        ? current.killSwitchAccelerator
        : (change.killSwitchAccelerator ?? undefined)
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
      appLists: {
        ...current.appLists,
        ...Object.fromEntries(
          Object.entries(change.appLists ?? {}).map(([kind, ids]) => [
            kind,
            [...new Set(ids)].slice(0, APP_LIST_LIMIT),
          ]),
        ),
      },
      ...(accelerator === undefined
        ? {}
        : { killSwitchAccelerator: accelerator }),
    }
    this.snapshot.write(next)
    this.cached = next
    return next
  }
}
