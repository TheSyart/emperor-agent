import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

const desktopRoot = resolve(__dirname, '..', '..')
const budgetScript = join(desktopRoot, 'scripts/check-renderer-budgets.mjs')
const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

describe('renderer bundle budget', () => {
  it('is part of the Desktop build contract', () => {
    const packageJson = JSON.parse(
      readFileSync(join(desktopRoot, 'package.json'), 'utf8'),
    ) as { scripts?: Record<string, string> }

    expect(packageJson.scripts?.['bundle:budget']).toBe(
      'node scripts/check-renderer-budgets.mjs',
    )
    expect(packageJson.scripts?.build).toContain('npm run bundle:budget')
  })

  it('reports the baseline metrics for a built fixture', () => {
    const fixture = createFixture({ chatBytes: 18 })
    const result = runBudget(fixture.root, fixture.config)

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('"mainJsBytes": 12')
    expect(result.stdout).toContain('"initialJsBytes": 14')
    expect(result.stdout).toContain('"chatJsBytes": 18')
    expect(result.stdout).toContain('"globalCssBytes": 16')
    expect(result.stdout).toContain('"largestImageBytes": 20')
  })

  it('fails the build when a metric exceeds its configured limit', () => {
    const fixture = createFixture({ chatBytes: 21 })
    const result = runBudget(fixture.root, fixture.config)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('chatJsBytes')
    expect(result.stderr).toContain('21 > 20')
  })
})

function createFixture({ chatBytes }: { chatBytes: number }): {
  root: string
  config: string
} {
  const root = mkdtempSync(join(tmpdir(), 'emperor-renderer-budget-'))
  temporaryRoots.push(root)
  const main = join(root, 'main')
  const renderer = join(root, 'renderer')
  const assets = join(renderer, 'assets')
  mkdirSync(main, { recursive: true })
  mkdirSync(assets, { recursive: true })
  writeBytes(join(main, 'index.js'), 12)
  writeBytes(join(assets, 'index-entry.js'), 14)
  writeBytes(join(assets, 'ConversationView-hash.js'), chatBytes)
  writeBytes(join(assets, 'index-style.css'), 16)
  writeBytes(join(assets, 'hero.png'), 20)
  writeFileSync(
    join(renderer, 'index.html'),
    '<script type="module" src="./assets/index-entry.js"></script>\n' +
      '<link rel="stylesheet" href="./assets/index-style.css">',
  )
  const config = join(root, 'renderer-budgets.json')
  writeFileSync(
    config,
    JSON.stringify({
      schemaVersion: 1,
      baseline: {
        mainJsBytes: 12,
        initialJsBytes: 14,
        chatJsBytes: 18,
        globalCssBytes: 16,
        largestImageBytes: 20,
      },
      limits: {
        mainJsBytes: 20,
        initialJsBytes: 20,
        chatJsBytes: 20,
        globalCssBytes: 20,
        largestImageBytes: 20,
      },
    }),
  )
  return { root, config }
}

function runBudget(root: string, config: string) {
  return spawnSync(
    process.execPath,
    [budgetScript, '--out-dir', root, '--config', config],
    { encoding: 'utf8' },
  )
}

function writeBytes(path: string, count: number): void {
  writeFileSync(path, 'x'.repeat(count))
}
