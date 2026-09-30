/**
 * Plugins as `@` references (E-track contract §1): one choice per plugin id
 * — the row in effect when the same plugin sits in several scopes — with the
 * reason it cannot be referenced right now. Only usable plugins become
 * chips; the rest show greyed and open their detail instead.
 */
import type { LocationQueryRaw } from 'vue-router'
import { navIcon } from '../icons'
import type { PluginSummary } from '../types'
import type { CapabilityPickerItem } from './capabilityPicker'

export interface PluginChoice {
  id: string
  label: string
  description: string
  logo: string | null
  scope: PluginSummary['scope']
  /** Why it cannot be referenced now; `null` when it can. */
  unavailable: string | null
}

function unavailableReason(plugin: PluginSummary): string | null {
  if (plugin.activation === 'active') return null
  if (plugin.activation === 'blocked_unverified') return '来源未验证'
  if (plugin.activation === 'missing') return '插件内容缺失'
  if (plugin.pluginId === 'computer-use' && plugin.scope === 'managed')
    return plugin.toggleable ? '电脑操作未开启' : '这台电脑上不能使用'
  return '已停用'
}

export function pluginChoices(
  plugins: readonly PluginSummary[],
): PluginChoice[] {
  const byId = new Map<string, PluginSummary>()
  for (const plugin of plugins) {
    const seen = byId.get(plugin.pluginId)
    if (!seen || (!seen.effective && plugin.effective))
      byId.set(plugin.pluginId, plugin)
  }
  return [...byId.values()].map((plugin) => ({
    id: plugin.pluginId,
    label: plugin.displayName || plugin.pluginId,
    description: plugin.description ?? '',
    logo: plugin.logo ?? null,
    scope: plugin.scope,
    unavailable: unavailableReason(plugin),
  }))
}

/** Usable first, then by name; a query matches id, name or description. */
export function rankPluginChoices(
  choices: readonly PluginChoice[],
  query: string,
): PluginChoice[] {
  const needle = query.trim().toLowerCase()
  return choices
    .filter(
      (choice) =>
        !needle ||
        [choice.id, choice.label, choice.description].some((text) =>
          text.toLowerCase().includes(needle),
        ),
    )
    .sort(
      (a, b) =>
        Number(a.unavailable !== null) - Number(b.unavailable !== null) ||
        a.label.localeCompare(b.label, 'zh-Hans-CN'),
    )
}

/** Names and logos of the plugins that can be referenced (chips). */
export function pluginCatalog(choices: readonly PluginChoice[]): {
  label(id: string): string | undefined
  logo(id: string): string | null
} {
  const usable = new Map(
    choices
      .filter((choice) => choice.unavailable === null)
      .map((choice) => [choice.id, choice]),
  )
  return {
    label: (id) => usable.get(id)?.label,
    logo: (id) => usable.get(id)?.logo ?? null,
  }
}

/** A picker row: a chip for a usable plugin, the plugin's detail otherwise. */
export function pluginChipItem(choice: PluginChoice): CapabilityPickerItem {
  const logo = { name: choice.label, url: choice.logo }
  if (choice.unavailable !== null)
    return {
      id: `plugin:${choice.id}`,
      action: 'open_plugin',
      label: choice.label,
      description: choice.description,
      meta: choice.unavailable,
      plugin: { pluginId: choice.id, scope: choice.scope },
      disabled: true,
      logo,
      icon: navIcon('plugins'),
      tone: 'slate',
    }
  return {
    id: `plugin:${choice.id}`,
    action: 'insert_reference',
    label: choice.label,
    description: choice.description,
    meta: `@${choice.id}`,
    reference: { kind: 'plugin', id: choice.id, label: choice.label },
    logo,
    icon: navIcon('plugins'),
    tone: 'violet',
  }
}

/** The plugin's detail in 能力 › 插件. */
export function pluginDetailLocation(target: {
  pluginId: string
  scope: string
}): { path: string; query: LocationQueryRaw } {
  return {
    path: '/capabilities',
    query: { plugin: target.pluginId, scope: target.scope },
  }
}
