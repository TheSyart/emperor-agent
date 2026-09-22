/** Nav glyphs for the settings modal (16px lucide icons, keyed by section). */
import type { Component } from 'vue'
import {
  Activity,
  Brain,
  Cat,
  Clock,
  Coins,
  Cpu,
  Plug,
  Puzzle,
  Settings,
  SlidersHorizontal,
  Sparkles,
  Webhook,
  Wrench,
} from 'lucide-vue-next'
import type { SettingsSectionKey } from './settingsSections'

export const SETTINGS_SECTION_ICONS: Record<SettingsSectionKey, Component> = {
  general: Settings,
  model: Cpu,
  plugins: Puzzle,
  skills: Sparkles,
  mcp: Plug,
  hooks: Webhook,
  tools: Wrench,
  scheduler: Clock,
  memory: Brain,
  tokens: Coins,
  pet: Cat,
  configs: SlidersHorizontal,
  diagnostics: Activity,
}
