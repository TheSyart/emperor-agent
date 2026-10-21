#!/usr/bin/env node
// Pixel baselines (DS-06): run the visual tests tagged @baseline.
//
//   npm run visual:baselines          compare with tests/visual/__baselines__;
//                                     exits non-zero on any diff or missing image
//   npm run visual:baselines:update   regenerate the baselines (an image whose
//                                     pixels did not change is left untouched),
//                                     then delete images no spec declares
//
// Options: --config <file> (default playwright.config.ts; EMPEROR_VISUAL_PORT
// picks the renderer port). Anything else goes to `playwright test`, e.g.
// --workers=4; with a file or --grep filter, --update rewrites only what it
// ran and deletes nothing.
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  statSync,
  unlinkSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const desktop = join(dirname(fileURLToPath(import.meta.url)), '..')
export const VISUAL_DIR = join(desktop, 'tests/visual')
export const BASELINE_DIR = join(VISUAL_DIR, '__baselines__')

const CALL =
  /expectBaseline\(\s*[^,()]+,\s*'([a-z0-9-]+)',\s*`([a-z0-9-]+)-\$\{theme\}`,?\s*\)/g

/**
 * The images the visual specs compare against: every
 * `expectBaseline(target, '<area>', `<screen>-${theme}`)` call, once per
 * theme. `malformed` lists files with calls written any other way.
 */
export function declaredBaselines(visualDir = VISUAL_DIR) {
  const images = []
  const malformed = []
  for (const file of readdirSync(visualDir).sort()) {
    if (!file.endsWith('.spec.ts')) continue
    const source = readFileSync(join(visualDir, file), 'utf8')
    const calls = source.match(/expectBaseline\(/g)?.length ?? 0
    const matches = [...source.matchAll(CALL)]
    if (matches.length !== calls)
      malformed.push(`${file}: ${calls - matches.length} call(s)`)
    for (const [, area, screen] of matches)
      for (const theme of ['dark', 'light'])
        images.push(`${area}/${screen}-${theme}.png`)
  }
  return { images: images.sort(), malformed }
}

/** Every file under the baseline directory, as `<area>/<file>`. */
export function committedBaselines(dir = BASELINE_DIR) {
  const walk = (at) =>
    existsSync(at)
      ? readdirSync(at).flatMap((entry) => {
          const abs = join(at, entry)
          return statSync(abs).isDirectory() ? walk(abs) : [abs]
        })
      : []
  return walk(dir)
    .map((abs) => relative(dir, abs).split('\\').join('/'))
    .sort()
}

function main(argv) {
  const update = argv.includes('--update')
  let config = 'playwright.config.ts'
  const passthrough = []
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--update') continue
    if (arg === '--config' || arg === '-c') config = argv[++i]
    else if (arg.startsWith('--config=')) config = arg.slice('--config='.length)
    else passthrough.push(arg)
  }
  const filtered = passthrough.some(
    (arg) =>
      !arg.startsWith('-') || /^(--grep|-g|--grep-invert|--project)/.test(arg),
  )

  const cli = createRequire(import.meta.url).resolve('@playwright/test/cli')
  const result = spawnSync(
    process.execPath,
    [
      cli,
      'test',
      '-c',
      config,
      '--grep',
      '@baseline',
      `--update-snapshots=${update ? 'all' : 'none'}`,
      ...passthrough,
    ],
    { cwd: desktop, stdio: 'inherit' },
  )
  const status = result.status ?? 1
  if (!update || status !== 0) return status

  const { images, malformed } = declaredBaselines()
  if (malformed.length) {
    console.error(`expectBaseline calls the manifest cannot read:`)
    for (const item of malformed) console.error(`  ${item}`)
    return 1
  }
  if (!filtered) {
    const wanted = new Set(images)
    for (const file of committedBaselines()) {
      if (wanted.has(file)) continue
      unlinkSync(join(BASELINE_DIR, file))
      console.log(`removed stale baseline ${file}`)
    }
    for (const entry of existsSync(BASELINE_DIR)
      ? readdirSync(BASELINE_DIR)
      : []) {
      const dir = join(BASELINE_DIR, entry)
      if (statSync(dir).isDirectory() && readdirSync(dir).length === 0)
        rmdirSync(dir)
    }
  }
  const files = committedBaselines()
  const bytes = files.reduce(
    (sum, file) => sum + statSync(join(BASELINE_DIR, file)).size,
    0,
  )
  console.log(
    `${files.length} baselines, ${(bytes / 1024 / 1024).toFixed(2)} MB in ${relative(desktop, BASELINE_DIR)}`,
  )
  return 0
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url))
  process.exit(main(process.argv.slice(2)))
