/**
 * Whether the GitHub pages exist: the GitHub plugin is the one in effect
 * and active. Its own module so the sidebar (first-load bundle) does not
 * pull in the rest of the GitHub view model.
 */
export function githubPluginOn(
  plugins: ReadonlyArray<{
    pluginId: string
    effective?: boolean
    activation: string
  }>,
): boolean {
  return plugins.some(
    (plugin) =>
      plugin.pluginId === 'github' &&
      plugin.effective !== false &&
      plugin.activation === 'active',
  )
}
