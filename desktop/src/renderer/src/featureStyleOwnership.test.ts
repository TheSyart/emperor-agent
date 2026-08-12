import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const rendererRoot = __dirname
const manifestPath = join(rendererRoot, 'feature-style-owners.json')

interface FeatureStyleManifest {
  schemaVersion: number
  cascadeOrder: string[]
  features: Record<
    string,
    {
      view: string
      controller: string
      layers: Array<{ role: string; path: string; scoped?: boolean }>
    }
  >
}

describe('renderer feature style ownership', () => {
  it('declares every Composer style source in effective cascade order', () => {
    expect(existsSync(manifestPath)).toBe(true)
    if (!existsSync(manifestPath)) return
    const manifest = readManifest()
    const declared = manifest.features.composer.layers.map(
      (layer) => layer.path,
    )
    const actual = collectFiles(join(rendererRoot, 'styles'), '.css')
      .filter((path) => {
        const source = readFileSync(join(rendererRoot, path), 'utf8')
        return /\.(?:composer|model-menu)/.test(source)
      })
      .sort()

    expect(manifest.schemaVersion).toBe(1)
    expect([...declared].sort()).toEqual(actual)

    const mainImports = [
      ...readFileSync(join(rendererRoot, 'main.ts'), 'utf8').matchAll(
        /import '\.\/(styles\/[^']+\.css)'/g,
      ),
    ].map((match) => match[1])
    expect(mainImports.filter((path) => declared.includes(path))).toEqual(
      manifest.cascadeOrder,
    )
  })

  it('keeps HooksPanel styling private to its scoped feature view', () => {
    const manifest = readManifest()
    const hooks = manifest.features.hooks
    const component = readFileSync(join(rendererRoot, hooks.view), 'utf8')

    expect(hooks.layers).toEqual([
      {
        role: 'component-scoped',
        path: 'components/panels/HooksPanel.vue',
        scoped: true,
      },
    ])
    expect(component).toContain('<style scoped>')
    expect(component).toContain('class="main-view view-readable hooks-panel"')
  })

  it('points feature contracts only at existing files', () => {
    const manifest = readManifest()
    for (const feature of Object.values(manifest.features)) {
      expect(existsSync(join(rendererRoot, feature.view))).toBe(true)
      expect(existsSync(join(rendererRoot, feature.controller))).toBe(true)
      for (const layer of feature.layers)
        expect(existsSync(join(rendererRoot, layer.path))).toBe(true)
    }
  })
})

function readManifest(): FeatureStyleManifest {
  return JSON.parse(readFileSync(manifestPath, 'utf8')) as FeatureStyleManifest
}

function collectFiles(root: string, extension: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(root)) {
    const absolute = join(root, entry)
    if (statSync(absolute).isDirectory()) {
      files.push(...collectFiles(absolute, extension))
      continue
    }
    if (entry.endsWith(extension))
      files.push(absolute.slice(rendererRoot.length + 1))
  }
  return files
}
