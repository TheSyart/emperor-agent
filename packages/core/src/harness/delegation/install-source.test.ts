/**
 * AGT-13: how Claude Code and Codex were installed, from where the
 * executable really lives, and the upgrade command that goes with it.
 * Every layout is built in a temp folder (symlinks as npm, Homebrew and
 * Claude's installer make them); nothing real is run.
 */
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  EXECUTOR_PACKAGES,
  detectInstallSource,
  upgradeCommand,
} from './install-source'

const roots: string[] = []
afterEach(() =>
  roots.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true })),
)
function root() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'emperor-install-')))
  roots.push(dir)
  return dir
}
function script(path: string, body = 'exit 0') {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
}
function link(target: string, path: string) {
  mkdirSync(dirname(path), { recursive: true })
  symlinkSync(target, path)
}

/** `<prefix>/bin/<name>` → `../lib/node_modules/<package>/<bin>`, as npm links it. */
function npmGlobal(
  prefix: string,
  pkg: string,
  bin: string,
  name: string,
  withNpm = true,
) {
  script(join(prefix, 'lib/node_modules', pkg, bin))
  writeFileSync(
    join(prefix, 'lib/node_modules', pkg, 'package.json'),
    JSON.stringify({ name: pkg, version: '1.0.0' }),
  )
  link(`../lib/node_modules/${pkg}/${bin}`, join(prefix, 'bin', name))
  if (withNpm) script(join(prefix, 'bin', 'npm'))
  return join(prefix, 'bin', name)
}

describe('install source', () => {
  it('npm global: the prefix that owns the package and its own npm', () => {
    const r = root()
    const prefix = join(r, 'homebrew')
    const codex = npmGlobal(prefix, '@openai/codex', 'bin/codex.js', 'codex')
    const source = detectInstallSource(codex, 'codex', { home: r })
    expect(source).toMatchObject({
      kind: 'npm',
      executable: codex,
      realPath: join(prefix, 'lib/node_modules/@openai/codex/bin/codex.js'),
      npm: {
        prefix,
        packageName: '@openai/codex',
        packageDir: join(prefix, 'lib/node_modules/@openai/codex'),
        executable: join(prefix, 'bin/npm'),
        ownNpm: true,
      },
    })
    const claude = npmGlobal(
      prefix,
      '@anthropic-ai/claude-code',
      'bin/claude.exe',
      'claude',
    )
    expect(detectInstallSource(claude, 'claude-code', { home: r }).npm).toEqual(
      {
        prefix,
        packageName: '@anthropic-ai/claude-code',
        packageDir: join(prefix, 'lib/node_modules/@anthropic-ai/claude-code'),
        executable: join(prefix, 'bin/npm'),
        ownNpm: true,
      },
    )
  })

  it('npm global under a custom prefix: the npm on PATH, told the prefix', () => {
    const r = root()
    const prefix = join(r, '.npm-global')
    const claude = npmGlobal(
      prefix,
      '@anthropic-ai/claude-code',
      'bin/claude.exe',
      'claude',
      false,
    )
    script(join(r, 'node/bin/npm'))
    const source = detectInstallSource(claude, 'claude-code', {
      home: r,
      path: `/nonexistent:${join(r, 'node/bin')}`,
    })
    expect(source.kind).toBe('npm')
    expect(source.npm).toMatchObject({
      prefix,
      executable: join(r, 'node/bin/npm'),
      ownNpm: false,
    })
    // No npm anywhere: still npm, but nothing to run it with.
    expect(
      detectInstallSource(claude, 'claude-code', { home: r, path: '' }).npm
        ?.executable,
    ).toBeNull()
  })

  it('another package that happens to ship the same command is not ours', () => {
    const r = root()
    const codex = npmGlobal(
      join(r, 'prefix'),
      'codex-wrapper',
      'bin/codex',
      'codex',
    )
    expect(detectInstallSource(codex, 'codex', { home: r }).kind).toBe(
      'unknown',
    )
  })

  it('Homebrew formula: Cellar wins over the npm folder inside its keg', () => {
    const r = root()
    const brew = join(r, 'opt-homebrew')
    const keg = join(brew, 'Cellar/codex/0.153.4')
    script(join(keg, 'libexec/lib/node_modules/@openai/codex/bin/codex.js'))
    link(
      '../libexec/lib/node_modules/@openai/codex/bin/codex.js',
      join(keg, 'bin/codex'),
    )
    link('../Cellar/codex/0.153.4/bin/codex', join(brew, 'bin/codex'))
    script(join(brew, 'bin/brew'))
    const source = detectInstallSource(join(brew, 'bin/codex'), 'codex', {
      home: r,
    })
    expect(source).toMatchObject({
      kind: 'homebrew',
      homebrew: {
        name: 'codex',
        cask: false,
        prefix: brew,
        brew: join(brew, 'bin/brew'),
        location: join(brew, 'Cellar/codex'),
      },
    })
  })

  it('Homebrew cask: Caskroom, and no brew next to it', () => {
    const r = root()
    const brew = join(r, 'usr-local')
    script(join(brew, 'Caskroom/claude-code/2.1.281/claude'))
    link('../Caskroom/claude-code/2.1.281/claude', join(brew, 'bin/claude'))
    const source = detectInstallSource(
      join(brew, 'bin/claude'),
      'claude-code',
      { home: r },
    )
    expect(source).toMatchObject({
      kind: 'homebrew',
      homebrew: { name: 'claude-code', cask: true, brew: null },
    })
  })

  it("Claude's native installer: ~/.local/bin/claude → ~/.local/share/claude/versions/…", () => {
    const home = root()
    script(join(home, '.local/share/claude/versions/2.1.281'))
    link(
      join(home, '.local/share/claude/versions/2.1.281'),
      join(home, '.local/bin/claude'),
    )
    const source = detectInstallSource(
      join(home, '.local/bin/claude'),
      'claude-code',
      { home },
    )
    expect(source.kind).toBe('claude-native')
    expect(source.realPath).toBe(
      join(home, '.local/share/claude/versions/2.1.281'),
    )
    // Codex never comes from Claude's installer.
    expect(
      detectInstallSource(join(home, '.local/bin/claude'), 'codex', { home })
        .kind,
    ).toBe('unknown')
  })

  it('Codex inside a desktop app comes with the app', () => {
    const r = root()
    const app = join(r, 'Applications/Codex.app')
    script(join(app, 'Contents/Resources/codex'))
    link(join(app, 'Contents/Resources/codex'), join(r, 'bin/codex'))
    const source = detectInstallSource(join(r, 'bin/codex'), 'codex', {
      home: r,
    })
    expect(source).toMatchObject({ kind: 'desktop', app })
  })

  it('anything else, or nothing at all, is unknown', () => {
    const r = root()
    script(join(r, 'tools/codex'))
    expect(
      detectInstallSource(join(r, 'tools/codex'), 'codex', { home: r }).kind,
    ).toBe('unknown')
    const missing = detectInstallSource(join(r, 'nope/claude'), 'claude-code', {
      home: r,
    })
    expect(missing).toMatchObject({
      kind: 'unknown',
      realPath: join(r, 'nope/claude'),
    })
    // The old npm-in-~/.claude installer is not upgraded from here.
    script(
      join(r, '.claude/local/node_modules/@anthropic-ai/claude-code/cli.js'),
    )
    link(
      join(r, '.claude/local/node_modules/@anthropic-ai/claude-code/cli.js'),
      join(r, '.claude/local/claude'),
    )
    expect(
      detectInstallSource(join(r, '.claude/local/claude'), 'claude-code', {
        home: r,
      }).kind,
    ).toBe('unknown')
  })
})

describe('upgrade command', () => {
  it('npm: that prefix’s npm, `install -g <package>@<version>`', () => {
    const r = root()
    const prefix = join(r, 'homebrew')
    const codex = npmGlobal(prefix, '@openai/codex', 'bin/codex.js', 'codex')
    const plan = upgradeCommand(
      detectInstallSource(codex, 'codex', { home: r }),
      'codex',
      '0.163.0',
    )
    expect(plan).toEqual({
      oneClick: true,
      argv: [join(prefix, 'bin/npm'), 'install', '-g', '@openai/codex@0.163.0'],
      env: { npm_config_prefix: prefix },
      path: join(prefix, 'bin'),
      command: 'npm install -g @openai/codex@0.163.0',
      writes: [
        join(prefix, 'lib/node_modules'),
        join(prefix, 'lib/node_modules/@openai/codex'),
        join(prefix, 'bin'),
      ],
    })
    expect(EXECUTOR_PACKAGES).toEqual({
      'claude-code': '@anthropic-ai/claude-code',
      codex: '@openai/codex',
    })
  })

  it('npm under a custom prefix names the prefix; with no npm it is a command to copy', () => {
    const r = root()
    const prefix = join(r, '.npm-global')
    const claude = npmGlobal(
      prefix,
      '@anthropic-ai/claude-code',
      'bin/claude.exe',
      'claude',
      false,
    )
    script(join(r, 'node/bin/npm'))
    const plan = upgradeCommand(
      detectInstallSource(claude, 'claude-code', {
        home: r,
        path: join(r, 'node/bin'),
      }),
      'claude-code',
      '2.1.308',
    )
    expect(plan.oneClick).toBe(true)
    expect(plan.argv).toEqual([
      join(r, 'node/bin/npm'),
      'install',
      '-g',
      '--prefix',
      prefix,
      '@anthropic-ai/claude-code@2.1.308',
    ])
    expect(plan.command).toBe(
      `npm install -g --prefix ${prefix} @anthropic-ai/claude-code@2.1.308`,
    )
    const none = upgradeCommand(
      detectInstallSource(claude, 'claude-code', { home: r, path: '' }),
      'claude-code',
      '2.1.308',
    )
    expect(none).toMatchObject({
      oneClick: false,
      manual: 'unknown',
      command: `npm install -g --prefix ${prefix} @anthropic-ai/claude-code@2.1.308`,
    })
    expect(none.argv).toBeUndefined()
  })

  it('Homebrew: `brew upgrade <name>`, one click only when brew’s version is the target', () => {
    const r = root()
    const brew = join(r, 'opt-homebrew')
    script(join(brew, 'Cellar/codex/0.153.4/bin/codex'))
    link('../Cellar/codex/0.153.4/bin/codex', join(brew, 'bin/codex'))
    script(join(brew, 'bin/brew'))
    const source = detectInstallSource(join(brew, 'bin/codex'), 'codex', {
      home: r,
    })
    expect(
      upgradeCommand(source, 'codex', '0.163.0', {
        homebrewVersion: '0.163.0',
      }),
    ).toMatchObject({
      oneClick: true,
      argv: [join(brew, 'bin/brew'), 'upgrade', 'codex'],
      env: { HOMEBREW_NO_AUTO_UPDATE: '1', HOMEBREW_NO_ENV_HINTS: '1' },
      command: 'brew upgrade codex',
    })
    // brew would install something else (or its version is unknown).
    for (const homebrewVersion of ['0.164.0', null])
      expect(
        upgradeCommand(source, 'codex', '0.163.0', { homebrewVersion }),
      ).toMatchObject({
        oneClick: false,
        manual: 'homebrew',
        command: 'brew upgrade codex',
      })
    script(join(brew, 'Caskroom/claude-code/2.1.281/claude'))
    link('../Caskroom/claude-code/2.1.281/claude', join(brew, 'bin/claude'))
    expect(
      upgradeCommand(
        detectInstallSource(join(brew, 'bin/claude'), 'claude-code', {
          home: r,
        }),
        'claude-code',
        '2.1.308',
        { homebrewVersion: '2.1.308' },
      ),
    ).toMatchObject({
      oneClick: true,
      argv: [join(brew, 'bin/brew'), 'upgrade', '--cask', 'claude-code'],
      command: 'brew upgrade --cask claude-code',
    })
  })

  it("Claude's installer: `claude install <version>`", () => {
    const home = root()
    script(join(home, '.local/share/claude/versions/2.1.281'))
    link(
      join(home, '.local/share/claude/versions/2.1.281'),
      join(home, '.local/bin/claude'),
    )
    const plan = upgradeCommand(
      detectInstallSource(join(home, '.local/bin/claude'), 'claude-code', {
        home,
      }),
      'claude-code',
      '2.1.308',
    )
    expect(plan).toMatchObject({
      oneClick: true,
      argv: [join(home, '.local/bin/claude'), 'install', '2.1.308'],
      command: 'claude install 2.1.308',
      writes: [join(home, '.local/share/claude'), join(home, '.local/bin')],
    })
  })

  it('desktop app or unknown: no one click', () => {
    const r = root()
    const app = join(r, 'Codex.app')
    script(join(app, 'Contents/Resources/codex'))
    expect(
      upgradeCommand(
        detectInstallSource(join(app, 'Contents/Resources/codex'), 'codex', {
          home: r,
        }),
        'codex',
        '0.163.0',
      ),
    ).toEqual({ oneClick: false, manual: 'desktop', command: null })
    script(join(r, 'tools/codex'))
    script(join(r, 'tools/claude'))
    expect(
      upgradeCommand(
        detectInstallSource(join(r, 'tools/codex'), 'codex', { home: r }),
        'codex',
        '0.163.0',
      ),
    ).toEqual({
      oneClick: false,
      manual: 'unknown',
      command: 'npm install -g @openai/codex@0.163.0',
    })
    expect(
      upgradeCommand(
        detectInstallSource(join(r, 'tools/claude'), 'claude-code', {
          home: r,
        }),
        'claude-code',
        '2.1.308',
      ),
    ).toEqual({ oneClick: false, manual: 'unknown', command: 'claude update' })
  })

  it('a path with spaces is quoted in the command to copy', () => {
    const r = root()
    const prefix = join(r, 'my tools')
    const claude = npmGlobal(
      prefix,
      '@anthropic-ai/claude-code',
      'bin/claude.exe',
      'claude',
      false,
    )
    script(join(r, 'node/bin/npm'))
    expect(
      upgradeCommand(
        detectInstallSource(claude, 'claude-code', {
          home: r,
          path: join(r, 'node/bin'),
        }),
        'claude-code',
        '2.1.308',
      ).command,
    ).toBe(
      `npm install -g --prefix '${prefix}' @anthropic-ai/claude-code@2.1.308`,
    )
  })
})
