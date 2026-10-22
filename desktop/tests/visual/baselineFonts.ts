import { readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { BrowserContext } from '@playwright/test'

const root = fileURLToPath(new URL('./fonts/noto-sans-sc/', import.meta.url))
const assets = new Map<string, string>([
  ['index.css', resolve(root, 'index.css')],
  ...readdirSync(resolve(root, 'files'))
    .filter((name) => /^[a-z0-9.-]+\.woff2$/.test(name))
    .map(
      (name) =>
        [`files/${name}`, resolve(root, 'files', name)] as [string, string],
    ),
])

/** Fixed, licensed font bytes for pixel comparisons; never imported by the app. */
export async function installBaselineFonts(
  context: BrowserContext,
): Promise<void> {
  await context.route('**/__baseline-fonts__/**', async (route) => {
    const name =
      new URL(route.request().url()).pathname.split(
        '/__baseline-fonts__/',
      )[1] ?? ''
    const path = assets.get(name)
    if (!path) return route.abort()
    await route.fulfill({
      path,
      contentType: name.endsWith('.css') ? 'text/css' : 'font/woff2',
    })
  })
  await context.addInitScript(() => {
    if (!/^https?:$/.test(location.protocol)) return
    const install = () => {
      const link = document.createElement('link')
      link.rel = 'stylesheet'
      link.href = '/__baseline-fonts__/index.css'
      link.onload = () => {
        const sheet = new CSSStyleSheet()
        sheet.replaceSync(
          ':root { --font-sans: "Noto Sans SC Variable", sans-serif !important; --font-mono: ui-monospace, "Noto Sans SC Variable", monospace !important; }',
        )
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet]
        document.documentElement.dataset.baselineFonts = 'ready'
      }
      link.onerror = () => {
        document.documentElement.dataset.baselineFonts = 'error'
      }
      document.documentElement.dataset.baselineFonts = 'loading'
      document.head.append(link)
    }
    if (document.readyState === 'loading')
      document.addEventListener('DOMContentLoaded', install, { once: true })
    else install()
  })
}
