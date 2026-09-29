import type { IconComponent } from '../icons'

export type CapabilityTone =
  'red' | 'cyan' | 'blue' | 'slate' | 'gold' | 'green' | 'violet'

export type CapabilityPickerAction =
  | 'files'
  | 'insert_command'
  | 'insert_capability_token'
  /** A skill or plugin chip (the rich composer). */
  | 'insert_reference'
  | 'activate_plan'
  | 'activate_goal'

export interface CapabilityPickerItem {
  id: string
  action: CapabilityPickerAction
  label: string
  description: string
  meta?: string
  completion?: string
  /** What `insert_reference` inserts. */
  reference?: { kind: 'skill' | 'plugin'; id: string; label: string }
  icon: IconComponent
  tone?: CapabilityTone
}

export interface CapabilityPickerGroup {
  label: string
  items: CapabilityPickerItem[]
}
