import * as fsp from 'node:fs/promises'
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  discoverBrowsers,
  userDataDir,
} from '../browser-import/browser-discovery'
import {
  createExtensionDetector,
  type DetectFs,
} from './browser-extension-detect'

const ID = 'oobcokoopgkhlhpohfdpelkafiidojjn'
const cleanup: string[] = []
afterEach(async () => {
  for (const directory of cleanup.splice(0))
    await rm(directory, { recursive: true, force: true })
})

/** A fake home: Emperor's folder and Chrome/Edge profile files. */
async function fixture() {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'ext-detect-')))
  cleanup.push(home)
  const folder = join(home, '.emperor', 'browser-extension')
  await mkdir(folder, { recursive: true })
  const profiles = async (
    browser: 'chrome' | 'edge',
    names: Record<string, string>,
  ) => {
    const dir = userDataDir(browser, home)
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'Local State'),
      JSON.stringify({
        profile: {
          info_cache: Object.fromEntries(
            Object.entries(names).map(([key, name]) => [key, { name }]),
          ),
        },
      }),
    )
    for (const key of Object.keys(names))
      await mkdir(join(dir, key), { recursive: true })
  }
  const prefs = async (
    browser: 'chrome' | 'edge',
    profile: string,
    file: 'Secure Preferences' | 'Preferences',
    value: unknown,
  ) =>
    writeFile(
      join(userDataDir(browser, home), profile, file),
      typeof value === 'string' ? value : JSON.stringify(value),
    )
  const settings = (entry: Record<string, unknown>) => ({
    extensions: { settings: { [ID]: entry } },
  })
  return {
    home,
    folder,
    profiles,
    prefs,
    settings,
    detector: (fs?: DetectFs) =>
      createExtensionDetector({
        extensionId: ID,
        folder,
        discover: () => discoverBrowsers({ homeDir: home }),
        ...(fs ? { fs } : {}),
      }),
  }
}

describe('where the Emperor extension is loaded', () => {
  it('finds it loaded from Emperor’s folder, by its real path', async () => {
    const f = await fixture()
    await f.profiles('chrome', { Default: '个人', 'Profile 1': '工作' })
    // Loaded through a symlink to the same folder: still ours.
    await symlink(f.folder, join(f.home, 'link'))
    await f.prefs(
      'chrome',
      'Profile 1',
      'Secure Preferences',
      f.settings({
        path: join(f.home, 'link'),
        location: 4,
        disable_reasons: [],
      }),
    )
    await f.prefs('chrome', 'Default', 'Preferences', {
      extensions: { ui: { developer_mode: true } },
    })
    expect(await f.detector()()).toEqual([
      {
        browser: 'chrome',
        name: 'Google Chrome',
        present: true,
        extension: 'loaded',
        elsewhere: null,
        developerMode: true,
      },
      {
        browser: 'edge',
        name: 'Microsoft Edge',
        present: false,
        extension: 'none',
        elsewhere: null,
        developerMode: false,
      },
    ])
  })

  it('tells a switched-off extension, in the new and the old formats', async () => {
    const f = await fixture()
    await f.profiles('edge', { Default: '默认' })
    for (const entry of [
      { path: f.folder, disable_reasons: [1] },
      { path: f.folder, disable_reasons: 8192 },
      { path: f.folder, state: 0 },
    ]) {
      await f.prefs('edge', 'Default', 'Secure Preferences', f.settings(entry))
      const [, edge] = await f.detector()()
      expect(edge).toMatchObject({ present: true, extension: 'disabled' })
    }
    await f.prefs(
      'edge',
      'Default',
      'Secure Preferences',
      f.settings({ path: f.folder, disable_reasons: 0, state: 1 }),
    )
    const [, edge] = await f.detector()()
    expect(edge?.extension).toBe('loaded')
  })

  it('names another folder it was loaded from', async () => {
    const f = await fixture()
    await f.profiles('chrome', { Default: '个人' })
    const checkout = join(
      f.home,
      'src',
      'emperor-agent',
      'desktop',
      'extension',
    )
    await f.prefs(
      'chrome',
      'Default',
      'Secure Preferences',
      f.settings({ path: checkout, location: 4 }),
    )
    const [chrome] = await f.detector()()
    expect(chrome).toMatchObject({ extension: 'none', elsewhere: checkout })
  })

  it('ignores unreadable files, uninstalled entries and relative paths', async () => {
    const f = await fixture()
    await f.profiles('chrome', {
      Default: '个人',
      'Profile 1': '工作',
      'Profile 2': '其他',
    })
    await f.prefs('chrome', 'Default', 'Secure Preferences', '{ not json')
    await f.prefs(
      'chrome',
      'Profile 1',
      'Secure Preferences',
      f.settings({ path: f.folder, state: 2 }),
    )
    await f.prefs(
      'chrome',
      'Profile 2',
      'Secure Preferences',
      f.settings({ path: `${ID}/0.2.0_0` }),
    )
    const [chrome] = await f.detector()()
    expect(chrome).toMatchObject({
      present: true,
      extension: 'none',
      elsewhere: null,
    })
  })

  it('parses a preference file again only when it changed', async () => {
    const f = await fixture()
    await f.profiles('chrome', { Default: '个人' })
    await f.prefs(
      'chrome',
      'Default',
      'Secure Preferences',
      f.settings({ path: f.folder }),
    )
    let reads = 0
    const counting: DetectFs = {
      ...fsp,
      readFile: (async (...args: Parameters<typeof fsp.readFile>) => {
        reads++
        return fsp.readFile(...args)
      }) as typeof fsp.readFile,
    }
    const detect = f.detector(counting)
    await detect()
    const first = reads
    expect(first).toBeGreaterThan(0)
    await detect()
    expect(reads).toBe(first)
    await f.prefs(
      'chrome',
      'Default',
      'Secure Preferences',
      f.settings({
        path: f.folder,
        disable_reasons: [1],
        padding: 'x'.repeat(10),
      }),
    )
    const [chrome] = await detect()
    expect(reads).toBe(first + 1)
    expect(chrome?.extension).toBe('disabled')
  })

  it('never reads outside the browser for a strange profile name', async () => {
    const f = await fixture()
    const dir = userDataDir('chrome', f.home)
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'Local State'),
      JSON.stringify({
        profile: { info_cache: { '../../..': { name: 'x' } } },
      }),
    )
    const opened: string[] = []
    const watching: DetectFs = {
      ...fsp,
      stat: (async (path: string) => {
        opened.push(String(path))
        return fsp.stat(path)
      }) as typeof fsp.stat,
    }
    await f.detector(watching)()
    expect(opened).toEqual([])
  })
})
