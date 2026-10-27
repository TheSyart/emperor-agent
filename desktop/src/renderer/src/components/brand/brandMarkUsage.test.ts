import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const rendererRoot = resolve(__dirname, '..', '..')
const repoRoot = resolve(rendererRoot, '..', '..', '..', '..')

function readRenderer(path: string): string {
  return readFileSync(resolve(rendererRoot, path), 'utf8')
}

function viewBox(svg: string): string {
  return /viewBox="([^"]+)"/.exec(svg)![1]!
}

function pathData(svg: string): string[] {
  return [...svg.matchAll(/\sd="([^"]+)"/g)].map((match) => match[1])
}

const OLD_BITMAPS = [
  'emperor-agent-logo-mark.png',
  'emperoragent-wordmark.png',
  'model-setup-modal-hero-v2.png',
]

describe('brand mark usage', () => {
  it('does not expose the lucide hexagon as a reusable brand icon', () => {
    const icons = readRenderer('icons.ts')

    expect(icons).not.toContain('Hexagon')
    expect(icons).not.toContain('brandIcon')
  })

  it('draws BrandMark as the vector mark in brand gold, not a bitmap', () => {
    const brandMark = readRenderer('components/brand/BrandMark.vue')

    expect(brandMark).toContain('<svg')
    expect(brandMark).toContain('fill: rgb(var(--brand))')
    expect(brandMark).not.toMatch(/\.(png|webp|jpe?g)\b/)
  })

  it('keeps BrandMark, the favicon and the mark asset on one geometry', () => {
    const asset = readFileSync(
      resolve(repoRoot, 'assets/generated/emperor-mark.svg'),
      'utf8',
    )
    const favicon = readRenderer('../public/favicon.svg')
    const component = readRenderer('components/brand/BrandMark.vue')

    expect(favicon).toBe(asset)
    // 0.3 (BRD-02): one path, a rounded block with the crown cut out.
    expect(pathData(asset)).toHaveLength(1)
    expect(pathData(component)).toEqual(pathData(asset))
    expect(asset).toContain('fill-rule="evenodd"')
    expect(component).toContain('fill-rule="evenodd"')
    expect(component).toContain(`viewBox="${viewBox(asset)}"`)
  })

  it('cuts the same crown out of the mark as the app icon wears (BRD-02)', () => {
    const [mark] = pathData(
      readFileSync(
        resolve(repoRoot, 'assets/generated/emperor-mark.svg'),
        'utf8',
      ),
    )
    const icon = readFileSync(
      resolve(repoRoot, 'assets/generated/emperor-app-icon.svg'),
      'utf8',
    )
    // The mark's second subpath is the crown; the icon draws it in gold.
    const crown = mark!.slice(mark!.indexOf('Z') + 1)
    expect(crown).toMatch(/^M.+Z$/)
    expect(pathData(icon)).toContain(crown)
    expect(icon).toContain('viewBox="0 0 1024 1024"')
  })

  it('keeps key brand surfaces on BrandMark instead of brandIcon', () => {
    const files = [
      // The brand row's mark lives in the mode switcher (MOD-02).
      'components/sidebar/ModeSwitcher.vue',
      'components/sidebar/SidebarRail.vue',
      'components/conversation/EmptyHero.vue',
      'components/onboarding/FirstRunOnboarding.vue',
    ]

    for (const file of files) {
      const source = readRenderer(file)
      expect(source, file).toContain('BrandMark')
      expect(source, file).not.toContain('brandIcon')
      for (const bitmap of OLD_BITMAPS)
        expect(source, file).not.toContain(bitmap)
    }
  })

  it('gives the first-run guide one illustration per theme', () => {
    const guide = readRenderer('components/onboarding/FirstRunOnboarding.vue')

    expect(guide).toContain('model-setup-hero-dark.webp')
    expect(guide).toContain('model-setup-hero-light.webp')
    expect(guide).toContain('useTheme')
  })
})
