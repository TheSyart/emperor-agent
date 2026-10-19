import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const rendererRoot = resolve(__dirname, '..', '..')

function readRenderer(path: string): string {
  return readFileSync(resolve(rendererRoot, path), 'utf8')
}

describe('brand mark usage', () => {
  it('does not expose the lucide hexagon as a reusable brand icon', () => {
    const icons = readRenderer('icons.ts')

    expect(icons).not.toContain('Hexagon')
    expect(icons).not.toContain('brandIcon')
  })

  it('uses the project logo asset for reusable brand marks', () => {
    const brandMark = readRenderer('components/brand/BrandMark.vue')

    expect(brandMark).toContain('emperor-agent-logo-mark.png')
  })

  it('keeps key brand surfaces on project logo assets instead of brandIcon', () => {
    // The rail's top holds the traffic lights (UI-S01): the mark lives in
    // the sidebar's brand bar only.
    const files = ['components/sidebar/SidebarBrandRow.vue']

    for (const file of files) {
      const source = readRenderer(file)
      expect(source, file).toContain('BrandMark')
      expect(source, file).not.toContain('brandIcon')
    }

    const setupDialog = readRenderer(
      'components/onboarding/ModelSetupRequiredDialog.vue',
    )
    expect(setupDialog).toContain('emperoragent-wordmark.png')
    expect(setupDialog).not.toContain('brandIcon')
  })
})
