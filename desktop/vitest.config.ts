import vue from '@vitejs/plugin-vue'
import { defineConfig, type Plugin } from 'vitest/config'

export default defineConfig({
  // Vitest 2 embeds Vite 5 types while the desktop runtime uses Vite 6. The
  // plugin contract is runtime-compatible; normalize the duplicate type here.
  plugins: [vue() as unknown as Plugin],
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Main reads the theme files as text for skins (BRD-05,
    // main/skins/theme-sources.ts); every other stylesheet stays empty.
    css: { include: [/\.css\?raw$/] },
  },
})
