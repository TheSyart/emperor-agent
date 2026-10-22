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
  classifyProtectedPath,
  credentialPathMentions,
  entryCovers,
  PROTECTED_STATE_DIRS,
  protectedEntries,
  protectedEntriesUnder,
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

/** The `state` rows of the table for `stateRoot` (no credential fixtures). */
function stateScope(stateRoot: string) {
  return { stateRoot, home: join(base, 'no-home') }
}

function protectedStateDirs(stateRoot: string): string[] {
  return protectedEntries(stateScope(stateRoot))
    .filter((entry) => entry.class === 'state')
    .map((entry) => entry.path)
}

async function isProtectedStatePath(
  path: string,
  stateRoot: string,
): Promise<boolean> {
  return (await classifyProtectedPath(path, stateScope(stateRoot))) === 'state'
}

async function protectedStateDirsUnder(
  root: string,
  stateRoot: string,
): Promise<string[]> {
  return (
    await protectedEntriesUnder(root, stateScope(stateRoot), ['state'])
  ).map((entry) => entry.path)
}

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

describe('protected path table (SEC-06)', () => {
  function scope() {
    const home = join(base, 'home')
    mkdirSync(join(home, '.ssh'), { recursive: true })
    mkdirSync(join(home, '.config', 'gcloud'), { recursive: true })
    mkdirSync(join(home, '.codex'), { recursive: true })
    writeFileSync(join(home, '.ssh', 'id_rsa'), 'k')
    writeFileSync(join(home, '.codex', 'auth.json'), '{}')
    writeFileSync(join(home, '.codex', 'config.toml'), '')
    writeFileSync(join(state, 'model_config.json'), '{}')
    return { stateRoot: state, home }
  }

  it('classifies state, config and credential paths, and nothing beside them', async () => {
    const s = scope()
    const cases: Array<[string, string | null]> = [
      [join(state, 'computer-use', 'vault.json'), 'state'],
      [join(state, 'browser', 'profiles', 'p1', 'Cookies'), 'state'],
      [join(state, 'model_config.json'), 'config'],
      [join(state, 'model_config.json.pre-seal-2026-10-19'), 'config'],
      [join(state, 'model_config.v1-backup.json'), 'config'],
      [join(state, 'mcp_config.json'), 'config'],
      [join(state, 'mcp_config.json.tmp-1-abc'), 'config'],
      [join(state, 'settings.json'), 'config'],
      [join(state, 'hooks.json'), 'config'],
      [join(s.home, '.ssh'), 'credential'],
      [join(s.home, '.ssh', 'id_rsa'), 'credential'],
      [join(s.home, '.aws', 'credentials'), 'credential'],
      [join(s.home, '.config', 'gcloud', 'credentials.db'), 'credential'],
      [join(s.home, '.docker', 'config.json'), 'credential'],
      [join(s.home, '.netrc'), 'credential'],
      [join(s.home, '.codex', 'auth.json'), 'credential'],
      [join(s.home, '.claude', '.credentials.json'), 'credential'],
      // The login Claude Code keeps in its folder under Emperor Home when
      // the Keychain refuses it (AGT-12): Emperor's own tools never read it.
      [
        join(
          state,
          'delegations',
          'claude-code',
          'config',
          '.credentials.json',
        ),
        'credential',
      ],
      [
        join(state, 'delegations', 'claude-code', 'config', 'settings.json'),
        null,
      ],
      [state, null],
      [join(state, 'sessions', 'log.jsonl'), null],
      [join(state, 'skills', 'settings.json'), null],
      [join(state, 'workspace', 'model_config.json'), null],
      [join(s.home, '.codex', 'config.toml'), null],
      [join(s.home, '.docker', 'daemon.json'), null],
      [join(s.home, '.config', 'gh', 'hosts.yml'), null],
      [join(s.home, '.sshx'), null],
    ]
    for (const [path, expected] of cases)
      expect(await classifyProtectedPath(path, s), path).toBe(expected)
  })

  it('sees config files and credentials through symlinks and letter case', async () => {
    const s = scope()
    const project = join(base, 'project')
    mkdirSync(project)
    symlinkSync(join(state, 'model_config.json'), join(project, 'mc.json'))
    symlinkSync(join(s.home, '.ssh'), join(project, 'keys'))
    expect(await classifyProtectedPath(join(project, 'mc.json'), s)).toBe(
      'config',
    )
    expect(
      await classifyProtectedPath(join(project, 'keys', 'id_rsa'), s),
    ).toBe('credential')
    if (process.platform === 'darwin')
      expect(
        await classifyProtectedPath(join(state, 'MODEL_CONFIG.JSON'), s),
      ).toBe('config')
  })

  it('places every entry under a wider search root so results there can be dropped', async () => {
    const s = scope()
    const entries = await protectedEntriesUnder(s.home, s, [
      'state',
      'config',
      'credential',
    ])
    const covered = (path: string) =>
      entries.some((entry) => entryCovers(entry, path))
    expect(covered(join(s.home, '.emperor', 'model_config.json'))).toBe(true)
    expect(
      covered(join(s.home, '.emperor', 'computer-use', 'vault.json')),
    ).toBe(true)
    expect(covered(join(s.home, '.ssh', 'id_rsa'))).toBe(true)
    expect(covered(join(s.home, '.codex', 'auth.json'))).toBe(true)
    expect(covered(join(s.home, '.codex', 'config.toml'))).toBe(false)
    expect(covered(join(s.home, '.emperor', 'sessions', 'log.jsonl'))).toBe(
      false,
    )
    const stateOnly = await protectedEntriesUnder(s.home, s, [
      'state',
      'config',
    ])
    expect(
      stateOnly.some((entry) => entryCovers(entry, join(s.home, '.ssh', 'x'))),
    ).toBe(false)
  })

  it('names the credential paths a command mentions, in ~ form', () => {
    const home = '/Users/fixture'
    expect(
      credentialPathMentions(
        'cat ~/.ssh/id_rsa && cat $HOME/.aws/credentials; cat "${HOME}/.netrc" /Users/fixture/.config/gcloud/creds.db ~/.codex/auth.json',
        home,
      ),
    ).toEqual([
      '~/.ssh/id_rsa',
      '~/.aws/credentials',
      '~/.netrc',
      '~/.config/gcloud/creds.db',
      '~/.codex/auth.json',
    ])
    expect(credentialPathMentions('ls ~/.sshx; echo .ssh', home)).toEqual([])
  })
})

describe('git control paths', () => {
  it('names config, hooks and info attributes, not samples or tracked files', async () => {
    const { isGitControlPath } = await import('./policy')
    expect(isGitControlPath('/w/repo/.git/config')).toBe(true)
    expect(isGitControlPath('/w/repo/.git/config.worktree')).toBe(true)
    expect(isGitControlPath('/w/repo/.git/hooks/pre-commit')).toBe(true)
    expect(isGitControlPath('/w/repo/.git/info/attributes')).toBe(true)
    expect(isGitControlPath('/w/repo/.git/modules/lib/config')).toBe(true)
    expect(
      isGitControlPath('/w/repo/.git/modules/lib/hooks/post-checkout'),
    ).toBe(true)
    expect(isGitControlPath('/w/repo/.git/hooks/pre-commit.sample')).toBe(false)
    expect(isGitControlPath('/w/repo/.gitattributes')).toBe(false)
    expect(isGitControlPath('/w/repo/src/config')).toBe(false)
    expect(isGitControlPath('/w/repo/.git/HEAD')).toBe(false)
  })
})
