/** Option shapes for the input components (DS-04). */
import type { Component } from 'vue'

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
  icon?: Component
  disabled?: boolean
}
