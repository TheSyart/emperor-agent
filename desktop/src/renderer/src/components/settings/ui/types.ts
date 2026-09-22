/** Shared option / item shapes for the settings primitives. */

/** One Select option (value + label, optional description line). */
export interface SelectOption<V extends string | number = string> {
  value: V
  label: string
  description?: string
  disabled?: boolean
}

/** One Segmented option. `icon` is a 14px glyph component. */
export interface SegmentedOption<V extends string | number = string> {
  value: V
  label: string
  icon?: import('vue').Component
  disabled?: boolean
}

/** One DefinitionList entry. */
export interface DefinitionItem {
  /** Stable key (defaults to the term). */
  key?: string
  term: string
  value?: string | number | null
  /** Monospace value (paths, ids, commands). */
  mono?: boolean
}
