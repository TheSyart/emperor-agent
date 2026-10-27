/**
 * BRD-05: the official skins (app resources) and the imported ones (the
 * Emperor Home's `skins/`): list, import (a checked copy), replace, delete,
 * and the images `app://skin` may hand out. Card tests 1 and 9.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  manifest,
  pngBytes,
  tempDir,
  webpBytes,
  writeSkin,
} from '../test-fixtures/skins'
import { SkinStore } from './skin-store'
import { themeTokens } from './theme-sources'

const OFFICIAL = join(__dirname, '../../../resources/skins')

let home = ''
let picked = ''
let store: SkinStore

beforeEach(() => {
  home = tempDir('emperor-skin-home-')
  picked = tempDir('emperor-skin-pick-')
  store = new SkinStore({
    officialRoot: OFFICIAL,
    userRoot: join(home, 'skins'),
    tokens: themeTokens,
  })
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  rmSync(picked, { recursive: true, force: true })
})

describe('listing', () => {
  it('starts with the three official skins, 御书房 first', () => {
    const list = store.list()
    expect(list.map((entry) => entry.id)).toEqual([
      'yushufang',
      'zhupi',
      'richang',
    ])
    expect(list.every((entry) => entry.ok && entry.view.official)).toBe(true)
  })

  it('lists an imported skin after them, and a broken folder with why', () => {
    expect(store.install(writeSkin(picked, 'paper', manifest())).ok).toBe(true)
    writeSkin(join(home, 'skins'), 'broken', manifest({ id: 'broken' }), {
      'hero.webp': '<html>',
      'pet.png': pngBytes(10, 10),
    })
    const list = store.list()
    expect(list.map((entry) => entry.id)).toEqual([
      'yushufang',
      'zhupi',
      'richang',
      'broken',
      'paper',
    ])
    const broken = list[3]!
    expect(broken.ok).toBe(false)
    if (!broken.ok) expect(broken.problems.join('\n')).toContain('hero.webp')
  })

  it('skips a folder whose name is not the skin’s id, saying so', () => {
    writeSkin(join(home, 'skins'), 'other', manifest())
    const entry = store.list().at(-1)!
    expect(entry.ok).toBe(false)
    if (!entry.ok) expect(entry.problems.join('\n')).toContain('文件夹名')
  })
})

describe('1 · importing', () => {
  it('copies only skin.json and the pictures it names into the Home', () => {
    const folder = writeSkin(picked, 'paper', manifest(), {
      'hero.webp': webpBytes(20, 20),
      'pet.png': pngBytes(20, 20),
      'unused.png': pngBytes(20, 20),
    })
    const result = store.install(folder)
    expect(result.ok).toBe(true)
    expect(readdirSync(join(home, 'skins', 'paper')).sort()).toEqual([
      'hero.webp',
      'pet.png',
      'skin.json',
    ])
    expect(store.get('paper')?.tokens['--brand']).toBe('184 50 31')
    // The picked folder can go away now.
    rmSync(folder, { recursive: true })
    expect(store.get('paper')).not.toBeNull()
  })

  it('says when the id is taken, and replaces it when asked', () => {
    store.install(writeSkin(picked, 'paper', manifest()))
    const again = writeSkin(picked, 'paper2', manifest({ name: '新宣纸' }))
    const inspected = store.inspect(again)
    expect(inspected).toMatchObject({ ok: true, replaces: true })
    expect(store.install(again).ok).toBe(true)
    expect(store.get('paper')?.name).toBe('新宣纸')
    expect(readdirSync(join(home, 'skins')).sort()).toEqual(['paper'])
  })

  it('never takes an official id', () => {
    const result = store.install(
      writeSkin(picked, 'zhupi', manifest({ id: 'zhupi' })),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.problems.join('\n')).toContain('官方皮肤')
  })

  it('refuses a package that fails a check and writes nothing', () => {
    const result = store.install(
      writeSkin(picked, 'paper', manifest(), {
        'hero.webp': webpBytes(20, 20),
        'pet.png': pngBytes(20, 20),
        'run.js': 'alert(1)',
      }),
    )
    expect(result.ok).toBe(false)
    expect(existsSync(join(home, 'skins', 'paper'))).toBe(false)
  })
})

describe('9 · a skin folder that was deleted', () => {
  it('is gone from the list and get() says so', () => {
    store.install(writeSkin(picked, 'paper', manifest()))
    rmSync(join(home, 'skins', 'paper'), { recursive: true })
    expect(store.get('paper')).toBeNull()
    expect(store.list().map((entry) => entry.id)).not.toContain('paper')
  })

  it('removes an imported skin, never an official one', () => {
    store.install(writeSkin(picked, 'paper', manifest()))
    expect(store.remove('paper')).toBe(true)
    expect(existsSync(join(home, 'skins', 'paper'))).toBe(false)
    expect(() => store.remove('zhupi')).toThrow(/官方皮肤/)
    expect(() => store.remove('../skins')).toThrow()
  })
})

describe('the images app://skin may hand out', () => {
  it('serves a slot picture with its sniffed type', () => {
    store.install(writeSkin(picked, 'paper', manifest()))
    expect(store.asset('paper', 'hero.webp')).toMatchObject({
      mime: 'image/webp',
    })
    expect(store.asset('paper', 'pet.png')?.mime).toBe('image/png')
    expect(store.asset('zhupi', 'hero.webp')?.mime).toBe('image/webp')
  })

  it('serves nothing a slot does not name, and re-checks the bytes', () => {
    store.install(writeSkin(picked, 'paper', manifest()))
    expect(store.asset('paper', 'skin.json')).toBeNull()
    expect(store.asset('paper', 'other.png')).toBeNull()
    expect(store.asset('nope', 'hero.webp')).toBeNull()
    // Swapped after the import: the header no longer matches.
    writeFileSync(join(home, 'skins', 'paper', 'hero.webp'), '<html>')
    expect(store.asset('paper', 'hero.webp')).toBeNull()
  })

  it('gives each slot an address with a version', () => {
    store.install(writeSkin(picked, 'paper', manifest()))
    expect(store.get('paper')?.slots.hero).toMatch(
      /^app:\/\/skin\/paper\/hero\.webp\?v=[\w-]+$/,
    )
  })

  it('leaves a stray folder in the Home alone', () => {
    mkdirSync(join(home, 'skins', 'Not An Id'), { recursive: true })
    expect(store.list().map((entry) => entry.id)).toEqual([
      'yushufang',
      'zhupi',
      'richang',
    ])
  })
})
