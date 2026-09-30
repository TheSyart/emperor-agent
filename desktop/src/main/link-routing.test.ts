import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { linkDestination } from './link-routing'

const system = { linkTarget: 'system', localTarget: 'builtin' } as const
const builtin = { linkTarget: 'builtin', localTarget: 'builtin' } as const
const localSystem = { linkTarget: 'builtin', localTarget: 'system' } as const

describe('linkDestination', () => {
  it('sends web links to the system browser by default', () => {
    expect(linkDestination('https://example.com/a?b=1', system)).toBe('system')
  })

  it('opens web links in the built-in browser when the user chose it', () => {
    expect(linkDestination('https://example.com/', builtin)).toBe('builtin')
    expect(linkDestination('http://example.com/', builtin)).toBe('builtin')
  })

  it('opens an address of this machine where 本地 URL 打开位置 says', () => {
    for (const url of [
      'http://localhost:5173/',
      'http://127.0.0.1:8080/x',
      'http://app.localhost/',
      'http://[::1]:3000/',
    ]) {
      // Built-in by default, whatever web links do.
      expect(linkDestination(url, system)).toBe('builtin')
      expect(linkDestination(url, builtin)).toBe('builtin')
      expect(linkDestination(url, localSystem)).toBe('system')
    }
    // Web links keep their own choice.
    expect(linkDestination('https://example.com/', localSystem)).toBe('builtin')
  })

  it('refuses credentials and anything that is not http(s)', () => {
    for (const url of [
      'https://user:pass@example.com/',
      'javascript:alert(1)',
      'file:///etc/passwd',
      'app://bundle/index.html',
      'mailto:a@example.com',
      'not a url',
    ]) {
      expect(linkDestination(url, builtin)).toBe('refuse')
      expect(linkDestination(url, system)).toBe('refuse')
      expect(linkDestination(url, localSystem)).toBe('refuse')
    }
  })
})

describe('link routing wiring', () => {
  it('routes only the main window links and the link channel', () => {
    const index = readFileSync(resolve(__dirname, 'index.ts'), 'utf8')
    const uses = index.match(/openUserLink\(/g) ?? []
    // The definition, the main window policy and the desktop IPC.
    expect(uses).toHaveLength(3)
    expect(
      index.match(/openLink: \(url\) => openUserLink\(url\)/g),
    ).toHaveLength(2)
    // The pet window keeps handing links to the system browser.
    const pet =
      /const trustedPetPolicy = createTrustedRendererPolicy\(\{[\s\S]*?\n\}\)/.exec(
        index,
      )?.[0]
    expect(pet).toBeDefined()
    expect(pet).not.toContain('openLink')
  })

  it('leaves the Agent browser (computer use) to its own navigation policy', () => {
    const root = resolve(__dirname, 'computer-use')
    const sources = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory()
          ? sources(join(dir, entry.name))
          : entry.name.endsWith('.ts')
            ? [join(dir, entry.name)]
            : [],
      )
    for (const file of sources(root)) {
      const text = readFileSync(file, 'utf8')
      expect(text, file).not.toMatch(/link-routing|openUserLink|LINK_OPEN/)
    }
  })
})
