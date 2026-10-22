/**
 * Which model a Codex run uses when nobody in Emperor chose one (FIX-16).
 *
 * Codex runs on the model its own configuration names (the user's
 * `~/.codex/config.toml`, which the Codex desktop app writes). A newer app
 * can name a model this CLI's login is not offered, and then every turn
 * ends at once with a 400. What `model/list` returns is what the login
 * offers — hidden models included, since they still run — so a default
 * missing from it gives way to the list's default model, or its first.
 * Emperor never writes the user's Codex files; the choice is per run.
 */

/** One row of Codex's `model/list`. */
export interface OfferedModel {
  id: string
  name?: string
  /** The list's own default model. */
  isDefault?: boolean
  /** Left out of Codex's picker; it still runs. */
  hidden?: boolean
}

/** Rows of one `model/list` page (`data`): the model id, name and flags. */
export function codexModelRows(data: unknown): OfferedModel[] {
  if (!Array.isArray(data)) return []
  return data.flatMap((raw) => {
    const row = (raw ?? {}) as Record<string, unknown>
    const id = row.model ?? row.id
    if (typeof id !== 'string' || !id) return []
    return [
      {
        id,
        ...(typeof row.displayName === 'string'
          ? { name: row.displayName }
          : {}),
        ...(row.isDefault === true ? { isDefault: true } : {}),
        ...(row.hidden === true ? { hidden: true } : {}),
      },
    ]
  })
}

/**
 * The model to use instead of `current`: undefined when the list offers
 * `current` (and it is not excluded), or offers nothing else. Otherwise the
 * list's default, else its first model — models shown in the picker first.
 */
export function replacementModel(
  offered: readonly OfferedModel[],
  current: string | undefined,
  exclude: readonly (string | undefined)[] = [],
): string | undefined {
  if (!offered.length) return undefined
  if (
    current &&
    !exclude.includes(current) &&
    offered.some((row) => row.id === current)
  )
    return undefined
  const rows = offered.filter(
    (row) => row.id !== current && !exclude.includes(row.id),
  )
  const shown = rows.filter((row) => !row.hidden)
  return (
    shown.find((row) => row.isDefault) ??
    shown[0] ??
    rows.find((row) => row.isDefault) ??
    rows[0]
  )?.id
}
