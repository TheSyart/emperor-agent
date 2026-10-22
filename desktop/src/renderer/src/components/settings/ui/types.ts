/** Shared option / item shapes for the settings primitives. */

export type { SegmentedOption, SelectOption } from '../../ui/inputTypes'

/** One DefinitionList entry. */
export interface DefinitionItem {
  /** Stable key (defaults to the term). */
  key?: string
  term: string
  value?: string | number | null
  /** Monospace value (paths, ids, commands). */
  mono?: boolean
}

/** A SettingsTable column: width is a grid track size (default minmax(0, 1fr)). */
export interface SettingsTableColumn {
  key: string
  label: string
  width?: string
}

/** One action of a row's 「⋯」 menu (SettingsRowMenu). */
export interface SettingsRowMenuItem {
  id: string
  label: string
  danger?: boolean
  disabled?: boolean
  onSelect: () => unknown
}
