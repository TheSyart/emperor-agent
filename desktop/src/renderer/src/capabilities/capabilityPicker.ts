import type { IconComponent } from '../icons'

export type CapabilityTone =
  'red' | 'cyan' | 'blue' | 'slate' | 'gold' | 'green' | 'violet'

export type CapabilityPickerAction =
  | 'files'
  | 'insert_command'
  /** A skill or plugin chip. */
  | 'insert_reference'
  /** A plugin that cannot be referenced now: open its detail instead. */
  | 'open_plugin'
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
  /** What `open_plugin` opens. */
  plugin?: { pluginId: string; scope: string }
  /** Shown in place of the icon (a plugin's logo, or its monogram). */
  logo?: { name: string; url: string | null }
  /** Greyed: selecting it does not insert anything. */
  disabled?: boolean
  icon: IconComponent
  tone?: CapabilityTone
}

export interface CapabilityPickerGroup {
  label: string
  items: CapabilityPickerItem[]
}
