import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  isProtectedStatePath,
  PROTECTED_STATE_DIRS,
  protectedStateDirs,
  protectedStateDirsUnder,
} from './protected-state'

let base: string
let state: string

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'emperor-protected-')))
  state = join(base, 'home', '.emperor')
  mkdirSync(join(state, 'computer-use', 'secrets'), { recursive: true })
  mkdirSync(join(state, 'browser', 'profiles', 'p1'), { recursive: true })
  mkdirSync(join(state, 'sessions'), { recursive: true })
  writeFileSync(join(state, 'computer-use', 'vault.json'), '{}')
  writeFileSync(join(state, 'computer-use', 'secrets', 'local.key'), 'k')
  writeFileSync(join(state, 'browser', 'profiles', 'p1', 'Cookies'), 'c')
  writeFileSync(join(state, 'sessions', 'log.jsonl'), '{}')
  writeFileSync(join(state, 'computer-use-notes.txt'), 'n')
})

afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

describe('protected Emperor state', () => {
  it('is computer-use and browser under the real state root', () => {
    expect(PROTECTED_STATE_DIRS).toEqual(['computer-use', 'browser'])
    expect(protectedStateDirs(state)).toEqual([
      join(state, 'computer-use'),
      join(state, 'browser'),
    ])
    // A symlinked state root resolves to where the data really is.
    symlinkSync(state, join(base, 'alias'))
    expect(protectedStateDirs(join(base, 'alias'))).toEqual([
      join(state, 'computer-use'),
      join(state, 'browser'),
    ])
  })

  it('covers both directories and everything in them, and nothing beside them', async () => {
    for (const path of [
      join(state, 'computer-use'),
      join(state, 'computer-use', 'vault.json'),
      join(state, 'computer-use', 'secrets', 'local.key'),
      join(state, 'computer-use', 'not-yet', 'made.txt'),
      join(state, 'browser'),
      join(state, 'browser', 'profiles', 'p1', 'Cookies'),
    ])
      expect(await isProtectedStatePath(path, state), path).toBe(true)
    for (const path of [
      state,
      join(state, 'sessions', 'log.jsonl'),
      join(state, 'spill', 'grep-results.txt'),
      join(state, 'computer-use-notes.txt'),
      join(state, 'browserx'),
      join(base, 'project', 'computer-use', 'vault.json'),
    ])
      expect(await isProtectedStatePath(path, state), path).toBe(false)
  })

  it('sees through symlinks, letter case and the data-volume alias', async () => {
    const project = join(base, 'project')
    mkdirSync(project)
    symlinkSync(join(state, 'computer-use'), join(project, 'link'))
    symlinkSync(
      join(state, 'browser', 'profiles', 'p1', 'Cookies'),
      join(project, 'cookies.txt'),
    )
    expect(
      await isProtectedStatePath(join(project, 'link', 'vault.json'), state),
    ).toBe(true)
    expect(
      await isProtectedStatePath(join(project, 'cookies.txt'), state),
    ).toBe(true)
    if (process.platform === 'darwin') {
      expect(
        await isProtectedStatePath(
          join(state, 'COMPUTER-USE', 'vault.json'),
          state,
        ),
      ).toBe(true)
      // realpath keeps /System/Volumes/Data/...; file identity does not.
      const alias = join('/System/Volumes/Data', state)
      if (existsSync(alias))
        expect(
          await isProtectedStatePath(
            join(alias, 'computer-use', 'vault.json'),
            state,
          ),
        ).toBe(true)
    }
  })

  it('places the directories under a wider search root, in that root’s own spelling', async () => {
    const home = join(base, 'home')
    expect(await protectedStateDirsUnder(home, state)).toEqual([
      join(home, '.emperor', 'computer-use'),
      join(home, '.emperor', 'browser'),
    ])
    symlinkSync(home, join(base, 'home-link'))
    expect(
      await protectedStateDirsUnder(join(base, 'home-link'), state),
    ).toEqual([
      join(base, 'home-link', '.emperor', 'computer-use'),
      join(base, 'home-link', '.emperor', 'browser'),
    ])
    expect(
      await protectedStateDirsUnder(join(state, 'sessions'), state),
    ).toEqual([])
    expect(await protectedStateDirsUnder(join(base, 'missing'), state)).toEqual(
      [],
    )
  })
})
