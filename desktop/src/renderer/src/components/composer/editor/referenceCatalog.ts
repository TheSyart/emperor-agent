/**
 * The names that can be chips: skills from the slash palette items, and
 * plugins that can be referenced right now (RF-03). The composer builds one
 * from its props; message views read the app's lists through the app
 * context (none outside <App>: no chips are guessed then, saved
 * references still show).
 */
import { inject } from 'vue'
import {
  pluginCatalog,
  pluginChoices,
} from '../../../capabilities/pluginChoices'
import { skillIdOf, type SlashPaletteItem } from '../../../commands'
import { APP_CONTEXT_KEY } from '../../../composables/useAppContext'
import type { PluginSummary } from '../../../types'
import { EMPTY_CATALOG, type ComposerCatalog } from './referenceText'

export function catalogFromCommands(
  commands: () => readonly SlashPaletteItem[],
  plugins: () => readonly PluginSummary[] = () => [],
): ComposerCatalog {
  const usable = () => pluginCatalog(pluginChoices(plugins()))
  return {
    skill: (id) =>
      commands().find((item) => item.kind === 'skill' && skillIdOf(item) === id)
        ?.title,
    plugin: (id) => usable().label(id),
    pluginLogo: (id) => usable().logo(id),
  }
}

export function useReferenceCatalog(): ComposerCatalog {
  const context = inject(APP_CONTEXT_KEY, null)
  if (!context) return EMPTY_CATALOG
  return catalogFromCommands(
    () => context.commands.value,
    () => context.boot.value?.plugins ?? [],
  )
}
