/**
 * When the first-run guide opens by itself and what the hero says while no
 * model works (UI-S17). Kept apart from firstRunModel.ts (the guide's copy)
 * so the first paint carries only this.
 */
import type { BootstrapPayload } from '../../types'

/** localStorage: 「稍后配置」 was chosen once, so launches stay quiet. */
export const FIRST_RUN_KEY = 'emperor.firstRun.v1'

export function readFirstRunDismissed(): boolean {
  try {
    return globalThis.localStorage?.getItem(FIRST_RUN_KEY) === 'dismissed'
  } catch {
    return false
  }
}

export function rememberFirstRunDismissed(): void {
  try {
    globalThis.localStorage?.setItem(FIRST_RUN_KEY, 'dismissed')
  } catch {
    // Storage blocked: the guide may open again on the next launch.
  }
}

/**
 * Open the guide at launch: there is no model entry at all (a broken one
 * is a repair, offered on the hero), it was never put off, and 设置 is not
 * already open.
 */
export function shouldOpenFirstRun(
  boot: BootstrapPayload | null | undefined,
  opts: { dismissed: boolean; settingsOpen: boolean },
): boolean {
  const config = boot?.modelConfig
  if (!config || opts.dismissed || opts.settingsOpen) return false
  return config.availability?.usable === false && config.models.length === 0
}

/** The hero's model row while no model works (null: one does). */
export type HeroModelState =
  { kind: 'setup' } | { kind: 'repair'; message: string }

export function heroModelState(
  boot: BootstrapPayload | null | undefined,
): HeroModelState | null {
  const config = boot?.modelConfig
  if (!config || config.availability?.usable !== false) return null
  if (!config.models.length) return { kind: 'setup' }
  return {
    kind: 'repair',
    message: config.availability.message?.trim() || '当前模型不可用',
  }
}
