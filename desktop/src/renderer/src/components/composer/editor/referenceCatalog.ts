/**
 * The names that can be chips, from the slash palette items (skills now;
 * plugins in RF-03). The composer builds one from its props; message views
 * read the app's list through the app context (none outside <App>: no
 * chips are guessed then, saved references still show).
 */
import { inject } from 'vue'
import { skillIdOf, type SlashPaletteItem } from '../../../commands'
import { APP_CONTEXT_KEY } from '../../../composables/useAppContext'
import { EMPTY_CATALOG, type ComposerCatalog } from './referenceText'

export function catalogFromCommands(
  commands: () => readonly SlashPaletteItem[],
): ComposerCatalog {
  return {
    skill: (id) =>
      commands().find((item) => item.kind === 'skill' && skillIdOf(item) === id)
        ?.title,
    plugin: () => undefined,
  }
}

export function useReferenceCatalog(): ComposerCatalog {
  const context = inject(APP_CONTEXT_KEY, null)
  if (!context) return EMPTY_CATALOG
  return catalogFromCommands(() => context.commands.value)
}
