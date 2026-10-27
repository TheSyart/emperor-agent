#!/usr/bin/env node
// The app icon from its vector source (BRD-02):
//
//   assets/generated/emperor-app-icon.svg
//     → desktop/build/icon.png                    1024 × 1024, the macOS icon
//                                                 grid (824 block, 100 margin)
//     → desktop/extension/icons/icon-{16,32,48,128}.png
//
// Every size is drawn from the vector, never scaled down from the 1024 PNG,
// so the small ones stay sharp. electron-builder makes the .icns from
// icon.png, and native/macos/scripts/helper-icon.sh the helpers' icons.
// Headless Chromium from the repo's Playwright; nothing to install.
//
//   node scripts/render-brand-icons.mjs
import { Buffer } from 'node:buffer'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const desktop = join(dirname(fileURLToPath(import.meta.url)), '..')
const repo = join(desktop, '..')
const { chromium } = createRequire(import.meta.url)('playwright')

const source = join(repo, 'assets/generated/emperor-app-icon.svg')
const targets = [
  [1024, join(desktop, 'build/icon.png')],
  ...[16, 32, 48, 128].map((size) => [
    size,
    join(desktop, `extension/icons/icon-${size}.png`),
  ]),
]

const svg = readFileSync(source, 'utf8')
const url = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
const browser = await chromium.launch()
try {
  for (const [size, output] of targets) {
    const page = await browser.newPage({
      viewport: { width: size, height: size },
      deviceScaleFactor: 1,
    })
    await page.setContent(
      `<style>html,body{margin:0;background:transparent}img{display:block}</style>` +
        `<img src="${url}" width="${size}" height="${size}">`,
    )
    await page.locator('img').evaluate((img) => img.decode())
    await page.screenshot({ path: output, omitBackground: true })
    await page.close()
    console.log(`${size}×${size} → ${relative(repo, output)}`)
  }
} finally {
  await browser.close()
}
