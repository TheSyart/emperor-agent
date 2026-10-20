// AGT-08 (finding SUB-12): a delegated task runs under an isolated HOME, so
// it could not see the user's git identity, SSH agent, toolchains or gh
// login. Each is passed through on its own switch (设置 › 子智能体 › 高级):
// git identity and proxies by default, the rest only when turned on.
import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_DEVELOPMENT_ENVIRONMENT,
  developmentEnvironment,
  projectInstructions,
  type DevelopmentEnvironmentSettings,
} from './dev-environment'

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

function tmp(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)))
}

/** A user home with a git identity, nvm, volta, cargo and pyenv installed. */
function userHome(): string {
  const home = tmp('emperor-agt08-home-')
  writeFileSync(
    join(home, '.gitconfig'),
    '[user]\n\tname = Ada Lovelace\n\temail = ada@example.com\n',
  )
  const node = join(home, '.nvm', 'versions', 'node', 'v20.11.1', 'bin')
  mkdirSync(node, { recursive: true })
  writeFileSync(join(node, 'node'), '#!/bin/sh\necho v20.11.1\n')
  chmodSync(join(node, 'node'), 0o755)
  mkdirSync(join(home, '.nvm', 'versions', 'node', 'v18.19.0', 'bin'), {
    recursive: true,
  })
  mkdirSync(join(home, '.nvm', 'alias'), { recursive: true })
  writeFileSync(join(home, '.nvm', 'alias', 'default'), '20\n')
  for (const bin of [
    ['.volta', 'bin'],
    ['.cargo', 'bin'],
    ['.pyenv', 'shims'],
  ])
    mkdirSync(join(home, ...bin), { recursive: true })
  mkdirSync(join(home, '.rustup'), { recursive: true })
  return home
}

function settings(
  patch: Partial<DevelopmentEnvironmentSettings> = {},
): DevelopmentEnvironmentSettings {
  return { ...DEFAULT_DEVELOPMENT_ENVIRONMENT, ...patch }
}

const noLoginShell = { read: async () => ({}) }

describe('development environment of a delegated task (AGT-08)', () => {
  it('defaults: git identity and proxies on; SSH, toolchains and GitHub off', () => {
    expect(DEFAULT_DEVELOPMENT_ENVIRONMENT).toEqual({
      gitIdentity: true,
      proxy: true,
      sshAgent: false,
      toolchains: false,
      github: false,
    })
  })

  it('1 · a git commit in the task uses the user’s identity', async () => {
    const home = userHome()
    const result = await developmentEnvironment({
      settings: settings(),
      ambient: { HOME: home, PATH: process.env.PATH },
      home,
      loginShell: noLoginShell,
    })
    expect(result.env).toMatchObject({
      GIT_AUTHOR_NAME: 'Ada Lovelace',
      GIT_AUTHOR_EMAIL: 'ada@example.com',
      GIT_COMMITTER_NAME: 'Ada Lovelace',
      GIT_COMMITTER_EMAIL: 'ada@example.com',
    })
    // A child under an isolated HOME (no ~/.gitconfig) commits as the user.
    const repo = tmp('emperor-agt08-repo-')
    const isolated = tmp('emperor-agt08-isolated-')
    const env = {
      PATH: process.env.PATH ?? '',
      HOME: isolated,
      GIT_CONFIG_NOSYSTEM: '1',
      ...result.env,
    }
    execFileSync('git', ['init', '-q'], { cwd: repo, env })
    writeFileSync(join(repo, 'a.txt'), 'a\n')
    execFileSync('git', ['add', '.'], { cwd: repo, env })
    execFileSync('git', ['commit', '-qm', 'task'], { cwd: repo, env })
    expect(
      execFileSync('git', ['log', '-1', '--format=%an <%ae>|%cn <%ce>'], {
        cwd: repo,
        env,
        encoding: 'utf8',
      }).trim(),
    ).toBe('Ada Lovelace <ada@example.com>|Ada Lovelace <ada@example.com>')
  })

  it.runIf(process.platform !== 'win32')(
    '2 · with SSH on, the task reaches the user’s SSH agent',
    async () => {
      const home = userHome()
      const socket = join(tmp('emperor-agt08-ssh-'), 'agent.sock')
      let connections = 0
      const agent: Server = createServer((connection) => {
        connections += 1
        connection.end()
      })
      await new Promise<void>((resolve) => agent.listen(socket, resolve))
      cleanups.push(
        () => new Promise<void>((resolve) => agent.close(() => resolve())),
      )
      const off = await developmentEnvironment({
        settings: settings(),
        ambient: { HOME: home, SSH_AUTH_SOCK: socket },
        home,
        loginShell: noLoginShell,
      })
      expect(off.env.SSH_AUTH_SOCK).toBeUndefined()
      const on = await developmentEnvironment({
        settings: settings({ sshAgent: true }),
        ambient: { HOME: home },
        home,
        // Started from the Dock: only the login shell knows the agent.
        loginShell: { read: async () => ({ SSH_AUTH_SOCK: socket }) },
      })
      expect(on.env.SSH_AUTH_SOCK).toBe(socket)
      const child = spawnSync(
        process.execPath,
        [
          '-e',
          "require('node:net').connect(process.env.SSH_AUTH_SOCK).on('connect', () => process.exit(0)).on('error', () => process.exit(3))",
        ],
        { env: { PATH: process.env.PATH ?? '', ...on.env }, timeout: 5000 },
      )
      expect(child.status).toBe(0)
      // The agent accepts once the event loop runs again.
      for (let tick = 0; tick < 100 && connections === 0; tick += 1)
        await new Promise((resolve) => setTimeout(resolve, 10))
      expect(connections).toBe(1)
    },
  )

  it('3 · proxy variables are visible, and only while the proxy switch is on', async () => {
    const home = userHome()
    const ambient = {
      HOME: home,
      HTTPS_PROXY: 'http://proxy.example:8080',
      NO_PROXY: 'localhost,127.0.0.1',
    }
    // On: the runtime's own proxy variables stay (nothing removed).
    const on = await developmentEnvironment({
      settings: settings(),
      ambient,
      home,
      loginShell: noLoginShell,
    })
    expect(on.remove).not.toContain('HTTPS_PROXY')
    const off = await developmentEnvironment({
      settings: settings({ proxy: false }),
      ambient,
      home,
      loginShell: noLoginShell,
    })
    expect(off.remove).toEqual(
      expect.arrayContaining(['HTTPS_PROXY', 'NO_PROXY']),
    )
    expect(off.env.HTTPS_PROXY).toBeUndefined()
  })

  it('4 · with toolchains on, the nvm default node is on PATH, with volta, cargo and pyenv', async () => {
    const home = userHome()
    const off = await developmentEnvironment({
      settings: settings(),
      ambient: { HOME: home },
      home,
      loginShell: noLoginShell,
    })
    expect(off.pathPrefix).toEqual([])
    expect(off.env.NVM_DIR).toBeUndefined()
    const on = await developmentEnvironment({
      settings: settings({ toolchains: true }),
      ambient: { HOME: home },
      home,
      loginShell: noLoginShell,
    })
    expect(on.env).toMatchObject({
      NVM_DIR: join(home, '.nvm'),
      VOLTA_HOME: join(home, '.volta'),
      CARGO_HOME: join(home, '.cargo'),
      RUSTUP_HOME: join(home, '.rustup'),
      PYENV_ROOT: join(home, '.pyenv'),
    })
    expect(on.pathPrefix).toEqual([
      join(home, '.nvm', 'versions', 'node', 'v20.11.1', 'bin'),
      join(home, '.volta', 'bin'),
      join(home, '.cargo', 'bin'),
      join(home, '.pyenv', 'shims'),
    ])
    const node = spawnSync('node', [], {
      env: {
        PATH: [...on.pathPrefix, '/usr/bin', '/bin'].join(':'),
        HOME: tmp('emperor-agt08-isolated-'),
      },
      encoding: 'utf8',
    })
    expect(node.stdout.trim()).toBe('v20.11.1')
  })

  it('5 · no GH_TOKEN unless GitHub sign-in is allowed', async () => {
    const home = userHome()
    let asked = 0
    const readGhToken = async () => {
      asked += 1
      return 'gho_secret_token_value'
    }
    const off = await developmentEnvironment({
      settings: settings(),
      ambient: { HOME: home, GH_TOKEN: 'from-the-shell' },
      home,
      loginShell: noLoginShell,
      readGhToken,
    })
    expect(off.env.GH_TOKEN).toBeUndefined()
    expect(off.remove).toEqual(
      expect.arrayContaining(['GH_TOKEN', 'GITHUB_TOKEN']),
    )
    expect(asked).toBe(0)
    const on = await developmentEnvironment({
      settings: settings({ github: true }),
      ambient: { HOME: home },
      home,
      loginShell: noLoginShell,
      readGhToken,
    })
    expect(on.env.GH_TOKEN).toBe('gho_secret_token_value')
    expect(on.secrets).toContain('gho_secret_token_value')
  })

  it('8 · with every switch off, nothing is added', async () => {
    const home = userHome()
    const result = await developmentEnvironment({
      settings: {
        gitIdentity: false,
        proxy: true,
        sshAgent: false,
        toolchains: false,
        github: false,
      },
      ambient: { HOME: home, SSH_AUTH_SOCK: '/tmp/agent', NVM_DIR: '/x' },
      home,
      loginShell: noLoginShell,
    })
    // Proxy on keeps what the runtime already passed; nothing new appears.
    expect(result.env).toEqual({})
    expect(result.pathPrefix).toEqual([])
    expect(result.secrets).toEqual([])
  })

  it('a user without a git identity gets none, and a slow git is cut off', async () => {
    const home = tmp('emperor-agt08-empty-')
    const result = await developmentEnvironment({
      settings: settings(),
      ambient: { HOME: home },
      home,
      loginShell: noLoginShell,
    })
    expect(result.env.GIT_AUTHOR_NAME).toBeUndefined()
    expect(result.env.GIT_COMMITTER_EMAIL).toBeUndefined()
  })
})

describe('project instructions for a delegated task (AGT-08)', () => {
  it('reads CLAUDE.md and AGENTS.md at the project root, bounded', () => {
    const root = tmp('emperor-agt08-project-')
    writeFileSync(join(root, 'CLAUDE.md'), '# House rules\nUse pnpm.\n')
    writeFileSync(join(root, 'AGENTS.md'), `# Agents\n${'x'.repeat(20_000)}\n`)
    const claude = projectInstructions(root, ['CLAUDE.md'])
    expect(claude).toContain('CLAUDE.md')
    expect(claude).toContain('Use pnpm.')
    const agents = projectInstructions(root, ['AGENTS.md'], 4_000)!
    expect(agents).toContain('AGENTS.md')
    expect(agents.length).toBeLessThan(4_400)
    expect(agents).toMatch(/截断|truncated/i)
    expect(
      projectInstructions(tmp('emperor-agt08-bare-'), ['CLAUDE.md']),
    ).toBeNull()
  })
})
