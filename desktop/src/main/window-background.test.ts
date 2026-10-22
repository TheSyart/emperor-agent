import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { windowBackground } from './window-background'

const theme = join(__dirname, '..', 'renderer', 'src', 'theme')

function tokens(file: string): Map<string, string> {
  const css = readFileSync(join(theme, file), 'utf8').replace(
    /\/\*[\s\S]*?\*\//g,
    '',
  )
  return new Map(
    [...css.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [
      m[1]!,
      m[2]!.trim(),
    ]),
  )
}

/** `--surface-canvas` of a semantic file, resolved through the primitives. */
function canvas(file: string): string {
  const table = new Map([...tokens('primitives.css'), ...tokens(file)])
  let value = table.get('--surface-canvas') ?? ''
  for (let i = 0; i < 5 && value.startsWith('var('); i++)
    value = table.get(value.slice(4, -1)) ?? ''
  const triplet = value.match(/^(\d+) (\d+) (\d+)$/)
  if (!triplet) throw new Error(`unresolved --surface-canvas in ${file}`)
  return (
    '#' +
    triplet
      .slice(1, 4)
      .map((n) => Number(n).toString(16).padStart(2, '0'))
      .join('')
  )
}

describe('main window background before the page paints (DS-01)', () => {
  it('uses the dark canvas colour of the theme when the system is dark', () => {
    expect(windowBackground(true)).toBe(canvas('semantic.dark.css'))
  })

  it('uses the light canvas colour when the system is light', () => {
    expect(windowBackground(false)).toBe(canvas('semantic.light.css'))
  })
})
