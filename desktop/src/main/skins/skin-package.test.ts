/**
 * BRD-05 card tests 1–6 at the package level: a valid skin loads; tokens
 * off the allowlist, unreadable text, scripts, disguised and oversized
 * images are refused, each with the reason.
 */
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  manifest,
  pngBytes,
  tempDir,
  webpBytes,
  writeSkin,
} from '../test-fixtures/skins'
import {
  inspectSkinFolder,
  skinView,
  type SkinInspection,
} from './skin-package'
import { themeTokens } from './theme-sources'

const OFFICIAL = join(__dirname, '../../../resources/skins')

let root = ''
beforeEach(() => {
  root = tempDir()
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function inspect(folder: string): SkinInspection {
  return inspectSkinFolder(folder, themeTokens)
}

function problems(folder: string): string[] {
  const result = inspect(folder)
  expect(result.ok, JSON.stringify(result)).toBe(false)
  return result.ok ? [] : result.problems
}

function view(folder: string) {
  const result = inspect(folder)
  if (!result.ok) throw new Error(result.problems.join('\n'))
  return skinView(result.skin, themeTokens, {
    official: false,
    assetUrl: (file) => `app://skin/${result.skin.id}/${file}?v=t`,
  })
}

describe('1 · a valid skin', () => {
  it('loads with its tokens, font, slots and the values exempt zones restore', () => {
    const skin = view(writeSkin(root, 'paper', manifest()))
    expect(skin).toMatchObject({
      id: 'paper',
      name: '宣纸',
      author: '测试',
      base: 'light',
      official: false,
      fonts: { heading: 'songti' },
      tokens: {
        '--surface-canvas': '246 239 225',
        '--text-1': '58 34 24',
        '--brand': '184 50 31',
        '--stroke-2': 'rgb(90 50 20 / 0.14)',
      },
      slots: {
        hero: 'app://skin/paper/hero.webp?v=t',
        sidebarFooter: 'app://skin/paper/pet.png?v=t',
      },
    })
    // A light-only skin restores the light theme only.
    expect(Object.keys(skin.reset)).toEqual(['light'])
    expect(skin.reset.light).toMatchObject({
      '--surface-canvas': '246 245 242',
      '--sidebar-fill': '246 245 242',
      '--text-1': '28 27 25',
      '--code-fg': '28 27 25',
      '--button-primary-fill': '28 27 25',
      '--brand': '156 111 36',
      '--stroke-2': 'rgb(0 0 0 / 0.12)',
      '--hairline': 'rgb(0 0 0 / 0.12)',
    })
    expect(skin.reset.light).not.toHaveProperty('--surface-base')
    expect(skin.preview.light).toEqual({
      canvas: '246 239 225',
      base: '255 255 255',
      raised: '247 246 243',
      text1: '58 34 24',
      text2: '95 93 88',
      brand: '184 50 31',
    })
  })

  it('reads an `auto` skin for both themes and a missing base as auto', () => {
    const json = manifest({
      base: undefined,
      tokens: { '--brand': '184 50 31' },
    })
    const skin = view(writeSkin(root, 'paper', json))
    expect(skin.base).toBe('auto')
    expect(skin.reset.light?.['--brand']).toBe('156 111 36')
    expect(skin.reset.dark?.['--brand']).toBe('212 170 94')
  })

  it('ignores Finder’s .DS_Store', () => {
    const dir = writeSkin(root, 'paper', manifest())
    writeFileSync(join(dir, '.DS_Store'), 'Bud1')
    expect(inspect(dir).ok).toBe(true)
  })
})

describe('2 · tokens off the allowlist or in the wrong form', () => {
  it('refuses sizes, radii, status colours and component tokens', () => {
    for (const key of [
      '--radius-card',
      '--fs-s',
      '--space-4',
      '--ok',
      '--error',
      '--input-major',
      '--gold-500',
    ]) {
      const found = problems(
        writeSkin(
          root,
          `p-${key.slice(2)}`,
          manifest({
            id: `p-${key.slice(2)}`.slice(0, 32),
            tokens: { [key]: '4px' },
          }),
        ),
      )
      expect(found.join('\n'), key).toContain(`「${key}」`)
      expect(found.join('\n')).toContain('皮肤只能改颜色')
    }
  })

  it('refuses values that are not the token’s form', () => {
    const found = problems(
      writeSkin(
        root,
        'paper',
        manifest({
          tokens: {
            '--text-1': '#333',
            '--surface-base': '300 0 0',
            '--surface-raised': 'rgb(1 2 3)',
            '--stroke-2': '12 12 12',
            '--surface-hover': 'url(https://evil.test/x.png)',
          },
        }),
      ),
    ).join('\n')
    for (const key of [
      '--text-1',
      '--surface-base',
      '--surface-raised',
      '--stroke-2',
      '--surface-hover',
    ])
      expect(found).toContain(`「${key}」`)
  })
})

describe('3 · text that cannot be read', () => {
  it('names the pair and the ratio', () => {
    const found = problems(
      writeSkin(
        root,
        'paper',
        manifest({ tokens: { '--text-2': '200 190 180' } }),
      ),
    ).join('\n')
    expect(found).toMatch(
      /「--text-2」在「--surface-canvas」上的对比度只有 \d\.\d : 1，至少要 4\.5 : 1/,
    )
    expect(found).toContain('「--surface-base」')
  })

  it('checks the base theme’s text on the skin’s backgrounds (exempt zones keep it)', () => {
    const found = problems(
      writeSkin(
        root,
        'paper',
        manifest({
          tokens: {
            '--surface-canvas': '30 30 30',
            '--surface-base': '36 36 36',
            '--text-1': '240 240 240',
            '--text-2': '210 210 210',
          },
        }),
      ),
    ).join('\n')
    expect(found).toContain('对话正文')
    expect(found).toContain('「--surface-canvas」')
  })

  it('checks an auto skin on both themes', () => {
    const found = problems(
      writeSkin(
        root,
        'paper',
        manifest({ base: 'auto', tokens: { '--text-1': '24 24 24' } }),
      ),
    ).join('\n')
    expect(found).toContain('深色')
    expect(found).not.toContain('浅色')
  })
})

describe('4 · scripts, pages, SVG, stylesheets and other files', () => {
  it('refuses .js / .html / .svg / .css by name', () => {
    for (const name of [
      'evil.js',
      'index.html',
      'logo.svg',
      'skin.css',
      'a.mjs',
      'b.htm',
    ]) {
      const found = problems(
        writeSkin(
          root,
          `x-${name.replace('.', '-')}`,
          manifest({ id: `x-${name.replace('.', '-')}` }),
          {
            'hero.webp': webpBytes(10, 10),
            'pet.png': pngBytes(10, 10),
            [name]: 'alert(1)',
          },
        ),
      ).join('\n')
      expect(found, name).toContain(`「${name}」`)
      expect(found).toContain('不能带脚本')
    }
  })

  it('refuses anything else that is not an image, a folder or a link', () => {
    const dir = writeSkin(root, 'paper', manifest(), {
      'hero.webp': webpBytes(10, 10),
      'pet.png': pngBytes(10, 10),
      'notes.txt': 'hi',
    })
    mkdirSync(join(dir, 'more'))
    symlinkSync('/etc/hosts', join(dir, 'hosts.png'))
    const found = problems(dir).join('\n')
    expect(found).toContain('「notes.txt」')
    expect(found).toContain('「more」')
    expect(found).toContain('「hosts.png」')
  })
})

describe('5 · an image whose name lies', () => {
  it('refuses HTML named .webp and WebP named .png', () => {
    const found = problems(
      writeSkin(root, 'paper', manifest(), {
        'hero.webp': '<!doctype html><script>alert(1)</script>',
        'pet.png': webpBytes(10, 10),
      }),
    ).join('\n')
    expect(found).toContain('「hero.webp」')
    expect(found).toContain('「pet.png」')
    expect(found).toContain('文件头')
  })
})

describe('6 · images over the limits', () => {
  it('refuses an image over 512 KB, a total over 4 MB and a side over 2048', () => {
    const big = problems(
      writeSkin(root, 'big', manifest({ id: 'big' }), {
        'hero.webp': webpBytes(10, 10, 'VP8X', 513 * 1024),
        'pet.png': pngBytes(10, 10),
      }),
    ).join('\n')
    expect(big).toContain('「hero.webp」')
    expect(big).toContain('512 KB')

    const files: Record<string, Buffer> = {
      'hero.webp': webpBytes(10, 10),
      'pet.png': pngBytes(10, 10),
    }
    for (let index = 0; index < 9; index++)
      files[`extra-${index}.png`] = pngBytes(10, 10, 500 * 1024)
    expect(
      problems(writeSkin(root, 'many', manifest({ id: 'many' }), files)).join(
        '\n',
      ),
    ).toContain('4 MB')

    const huge = problems(
      writeSkin(root, 'huge', manifest({ id: 'huge' }), {
        'hero.webp': webpBytes(4096, 4096),
        'pet.png': pngBytes(10, 10),
      }),
    ).join('\n')
    expect(huge).toContain('4096 × 4096')
  })
})

describe('the manifest', () => {
  it('names each thing wrong with skin.json', () => {
    expect(problems(writeSkin(root, 'none', null)).join('\n')).toContain(
      'skin.json',
    )
    expect(problems(writeSkin(root, 'junk', '{ nope')).join('\n')).toContain(
      '不是有效的 JSON',
    )
    expect(
      problems(
        writeSkin(
          root,
          'large',
          JSON.stringify({ pad: 'x'.repeat(70 * 1024) }),
        ),
      ).join('\n'),
    ).toContain('64 KB')
    const found = problems(
      writeSkin(
        root,
        'paper',
        manifest({
          schema: 2,
          id: 'Bad ID',
          base: 'sepia',
          fonts: { heading: 'comic' },
          slots: {
            thinking: 'hero.webp',
            hero: 'missing.webp',
            sidebarFooter: '../pet.png',
          },
          script: 'x',
        }),
      ),
    ).join('\n')
    expect(found).toContain('schema')
    expect(found).toContain('id')
    expect(found).toContain('base')
    expect(found).toContain('comic')
    expect(found).toContain('「thinking」')
    expect(found).toContain('「missing.webp」')
    expect(found).toContain('「../pet.png」')
    expect(found).toContain('「script」')
  })
})

describe('the official skins', () => {
  it('are 御书房, 朱批 and 日常 and pass the same checks', () => {
    const skins = Object.fromEntries(
      ['yushufang', 'zhupi', 'richang'].map((id) => [
        id,
        view(join(OFFICIAL, id)),
      ]),
    )
    expect(skins.yushufang).toMatchObject({
      name: '御书房',
      base: 'auto',
      tokens: {},
      fonts: { heading: 'system' },
    })
    expect(Object.keys(skins.yushufang!.slots)).toEqual([])
    expect(skins.zhupi).toMatchObject({
      name: '朱批',
      base: 'light',
      fonts: { heading: 'songti' },
    })
    expect(skins.zhupi!.tokens['--surface-canvas']).toBe('246 239 225')
    expect(skins.zhupi!.tokens['--brand']).toBe('184 50 31')
    expect(Object.keys(skins.zhupi!.slots).sort()).toEqual(['approved', 'hero'])
    expect(skins.richang).toMatchObject({
      name: '日常',
      base: 'auto',
      tokens: {},
    })
    expect(Object.keys(skins.richang!.slots).sort()).toEqual(['hero'])
  })
})
