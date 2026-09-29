/** Nav glyphs for the settings modal (16px lucide icons, keyed by section). */
import type { Component } from 'vue'
import {
  Activity,
  Brain,
  Cat,
  Coins,
  Cpu,
  MousePointerClick,
  Settings,
  Webhook,
} from 'lucide-vue-next'
import type { SettingsModalSection } from './settingsSections'

export const SETTINGS_SECTION_ICONS: Record<SettingsModalSection, Component> = {
  general: Settings,
  model: Cpu,
  hooks: Webhook,
  computer: MousePointerClick,
  memory: Brain,
  tokens: Coins,
  pet: Cat,
  diagnostics: Activity,
}
