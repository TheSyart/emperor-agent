import type { IconComponent } from '../icons'
import type { CapabilityDisplayItem, CapabilityTone } from './capabilityProjection'

export type CapabilityPickerAction = 'files' | 'insert_command' | 'insert_capability_token'

export interface CapabilityPickerItem {
  id: string
  action: CapabilityPickerAction
  label: string
  description: string
  meta?: string
  completion?: string
  icon: IconComponent
  tone?: CapabilityTone
  capability?: CapabilityDisplayItem
}

export interface CapabilityPickerGroup {
  label: string
  items: CapabilityPickerItem[]
}
