/**
 * The renderer's theme files, bundled into main as text (Vite `?raw`), so
 * skins are checked against exactly the tokens this build ships.
 */
import components from '../../renderer/src/theme/components.css?raw'
import primitives from '../../renderer/src/theme/primitives.css?raw'
import dark from '../../renderer/src/theme/semantic.dark.css?raw'
import light from '../../renderer/src/theme/semantic.light.css?raw'
import { createThemeTokens } from './theme-tokens'

export const themeTokens = createThemeTokens({
  primitives,
  dark,
  light,
  components,
})
