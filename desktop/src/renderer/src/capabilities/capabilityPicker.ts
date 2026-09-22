import type { IconComponent } from '../icons'

export type CapabilityTone =
  'red' | 'cyan' | 'blue' | 'slate' | 'gold' | 'green' | 'violet'

export type CapabilityPickerAction =
  | 'files'
  | 'insert_command'
  | 'insert_capability_token'
  | 'activate_plan'
  | 'activate_goal'

export interface CapabilityPickerItem {
  id: string
  action: CapabilityPickerAction
  label: string
  description: string
  meta?: string
  completion?: string
  icon: IconComponent
  tone?: CapabilityTone
}

export interface CapabilityPickerGroup {
  label: string
  items: CapabilityPickerItem[]
}
