import { afterEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const repoRoot = resolve(__dirname, '..', '..', '..')
const merger = join(repoRoot, 'scripts', 'merge-cyclonedx-sboms.mjs')
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

describe('CycloneDX SBOM merger', () => {
  it('connects the desktop Core component to the Core lockfile graph', () => {
    const fixture = createFixture()

    const result = runMerger(fixture)

    expect(result.status).toBe(0)
    const merged = JSON.parse(readFileSync(fixture.output, 'utf8')) as {
      components: Array<{ group?: string; name: string }>
      dependencies: Array<{ ref: string; dependsOn: string[] }>
    }
    expect(
      merged.components.some(
        (component) =>
          component.group === '@anthropic-ai' && component.name === 'sdk',
      ),
    ).toBe(true)
    const desktopCore = merged.dependencies.find(
      (dependency) => dependency.ref === 'desktop|@emperor/core',
    )
    expect(desktopCore?.dependsOn).toContain('core|@anthropic-ai/sdk')
  })

  it('rejects a Core BOM that omits a declared dependency', () => {
    const fixture = createFixture()
    const core = JSON.parse(readFileSync(fixture.core, 'utf8')) as {
      components: Array<{ group?: string; name: string }>
    }
    core.components = core.components.filter(
      (component) =>
        !(component.group === '@anthropic-ai' && component.name === 'sdk'),
    )
    writeFileSync(fixture.core, JSON.stringify(core))

    const result = runMerger(fixture)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('SBOM is missing declared dependency')
  })
})

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), 'emperor-sbom-merge-'))
  roots.push(root)
  const core = join(root, 'core.json')
  const desktop = join(root, 'desktop.json')
  const output = join(root, 'merged.json')
  const coreManifest = JSON.parse(
    readFileSync(join(repoRoot, 'packages/core/package.json'), 'utf8'),
  ) as {
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }
  const desktopManifest = JSON.parse(
    readFileSync(join(repoRoot, 'desktop/package.json'), 'utf8'),
  ) as {
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }

  const coreNames = dependencyNames(coreManifest)
  const desktopNames = dependencyNames(desktopManifest).filter(
    (name) => name !== '@emperor/core',
  )
  const coreComponents = [component('@emperor/core', 'core')]
  coreComponents.push(...coreNames.map((name) => component(name, 'core')))
  const desktopComponents = [component('@emperor/core', 'desktop')]
  desktopComponents.push(
    ...desktopNames.map((name) => component(name, 'desktop')),
  )

  writeFileSync(
    core,
    JSON.stringify(
      bom('core-root', coreComponents, [
        {
          ref: 'core|@emperor/core',
          dependsOn: coreNames.map((name) => `core|${name}`),
        },
        ...coreNames.map((name) => ({ ref: `core|${name}`, dependsOn: [] })),
      ]),
    ),
  )
  writeFileSync(
    desktop,
    JSON.stringify(
      bom('desktop-root', desktopComponents, [
        {
          ref: 'desktop-root',
          dependsOn: [
            'desktop|@emperor/core',
            ...desktopNames.map((name) => `desktop|${name}`),
          ],
        },
        { ref: 'desktop|@emperor/core', dependsOn: [] },
        ...desktopNames.map((name) => ({
          ref: `desktop|${name}`,
          dependsOn: [],
        })),
      ]),
    ),
  )
  return { core, desktop, output }
}

function runMerger(fixture: { core: string; desktop: string; output: string }) {
  return spawnSync(
    process.execPath,
    [merger, fixture.core, fixture.desktop, fixture.output],
    { encoding: 'utf8' },
  )
}

function dependencyNames(manifest: {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}) {
  return [
    ...Object.keys(manifest.dependencies || {}),
    ...Object.keys(manifest.devDependencies || {}),
  ]
}

function component(packageName: string, prefix: string) {
  const slash = packageName.startsWith('@') ? packageName.indexOf('/') : -1
  const group = slash > 0 ? packageName.slice(0, slash) : undefined
  const name = slash > 0 ? packageName.slice(slash + 1) : packageName
  return {
    type: 'library',
    group,
    name,
    version: '1.0.0',
    'bom-ref': `${prefix}|${packageName}`,
  }
}

function bom(rootRef: string, components: unknown[], dependencies: unknown[]) {
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    version: 1,
    metadata: {
      component: {
        type: 'application',
        name: rootRef,
        version: '1.0.0',
        'bom-ref': rootRef,
      },
    },
    components,
    dependencies,
  }
}
