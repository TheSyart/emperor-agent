import { skillIdOf, type SlashPaletteItem } from '../commands'
import { toolIcon } from '../icons'
import type {
  CapabilityPickerGroup,
  CapabilityPickerItem,
} from './capabilityPicker'
import {
  pluginChipItem,
  rankPluginChoices,
  type PluginChoice,
} from './pluginChoices'

export interface CapabilityPickerModelInput {
  commands: SlashPaletteItem[]
  /** Plugins for the 插件 group. */
  plugins?: readonly PluginChoice[]
}

/**
 * The + menu's 插入 Skill 或插件 list (UI-S04): Skills as chips, then
 * plugins. Attachments have their own + menu item; commands, Plan and Goal
 * start with `/` (Plan is also in the permission menu).
 */
export function buildCapabilityPickerGroups(
  input: CapabilityPickerModelInput,
): CapabilityPickerGroup[] {
  const skillItems = input.commands
    .filter((item) => item.kind === 'skill')
    .slice(0, 8)
    .map(skillChipItem)
  const pluginItems = rankPluginChoices(input.plugins ?? [], '')
    .slice(0, 8)
    .map(pluginChipItem)
  return [
    { label: 'Skills', items: skillItems },
    { label: '插件', items: pluginItems },
  ].filter((group) => group.items.length)
}

/** A skill chip; also used by the composer's `/` lists. */
export function skillChipItem(item: SlashPaletteItem): CapabilityPickerItem {
  return {
    id: item.id,
    action: 'insert_reference',
    label: item.title,
    description: item.description,
    meta: item.tags || 'Skill',
    reference: { kind: 'skill', id: skillIdOf(item), label: item.title },
    icon: toolIcon('skill'),
    tone: 'cyan',
  }
}
