import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  classifyConfinedStderr,
  LocalSandbox,
  seatbeltGuardArgs,
  seatbeltProfileArgs,
} from './backend'
import type { SandboxPolicy } from './policy'
import { protectedEntries } from './protected-state'

describe('Seatbelt runner (SEC-04)', () => {
  it('confines through /usr/bin/sandbox-exec, never a sandbox-exec found on PATH', () => {
    const confined = new LocalSandbox({ platform: 'darwin' }).confine(
      ['/usr/bin/true'],
      { mode: 'read-only', workspaceRoot: '/tmp' },
    )
    expect(confined.argv[0]).toBe('/usr/bin/sandbox-exec')
  })
})

describe('Computer Use Seatbelt confinement', () => {
  it('denies Shell reads of exactly the directories the file tools refuse', () => {
    const root = mkdtempSync(join(tmpdir(), 'emperor-cu-profile-'))
    try {
      const state = join(root, 'state')
      mkdirSync(join(state, 'computer-use'), { recursive: true })
      const profile = seatbeltProfileArgs(
        { mode: 'workspace-write', workspaceRoot: root },
        state,
      )[1]!
      // SEC-06: reads and writes, and the rest of the table beside them.
      const denied = [
        ...profile.matchAll(
          /\(deny file-read\* file-write\* \(subpath "([^"]+)"\)\)/g,
        ),
      ]
        .map((match) => match[1]!)
        .filter((path) => path.startsWith(realpathSync(state)))
      expect(denied).toEqual(
        protectedEntries({ stateRoot: state, home: homedir() })
          .filter((entry) => entry.class === 'state')
          .map((entry) => entry.path),
      )
      expect(denied).toHaveLength(2)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('refuses the helper socket directory under a custom Emperor Home too (MAIN-25)', () => {
    const root = mkdtempSync(join(tmpdir(), 'emperor-run-profile-'))
    try {
      const state = join(root, 'state')
      mkdirSync(join(state, 'run'), { recursive: true })
      const profile = seatbeltProfileArgs(
        { mode: 'workspace-write', workspaceRoot: root },
        state,
      )[1]!
      const sockets = [
        ...profile.matchAll(
          /\(deny network-outbound \(remote unix-socket \(path-regex "([^"]+)"\)\)\)/g,
        ),
      ].map((match) => match[1]!)
      expect(sockets.some((regex) => regex.includes('/state/run/'))).toBe(true)
      expect(sockets.some((regex) => regex.includes('.emperor/run/'))).toBe(
        true,
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform !== 'darwin')(
    'keeps ordinary CLI reads working while refusing Computer Use state',
    () => {
      const root = mkdtempSync(join(tmpdir(), 'emperor-cu-seatbelt-'))
      try {
        const state = join(root, 'state')
        const privateDir = join(state, 'computer-use')
        mkdirSync(privateDir, { recursive: true })
        const secret = join(privateDir, 'fixture.txt')
        writeFileSync(secret, 'fixture-only')
        const profileDir = join(state, 'browser', 'profiles', 'fixture')
        mkdirSync(profileDir, { recursive: true })
        const profileSecret = join(profileDir, 'cookie.txt')
        writeFileSync(profileSecret, 'profile-only')
        const sandbox = new LocalSandbox({ protectedStateRoot: state })
        const policy = { mode: 'workspace-write' as const, workspaceRoot: root }
        const confined = sandbox.confine(['/bin/cat', secret], policy)
        const denied = spawnSync(confined.argv[0]!, confined.argv.slice(1), {
          encoding: 'utf8',
          timeout: 5_000,
        })
        expect(denied.status).not.toBe(0)
        expect(denied.stdout).not.toContain('fixture-only')
        expect(denied.stderr).toContain('Operation not permitted')
        const profileRead = sandbox.confine(['/bin/cat', profileSecret], policy)
        const profileDenied = spawnSync(
          profileRead.argv[0]!,
          profileRead.argv.slice(1),
          {
            encoding: 'utf8',
            timeout: 5_000,
          },
        )
        expect(profileDenied.status).not.toBe(0)
        expect(profileDenied.stdout).not.toContain('profile-only')
        // Remembered tabs hold full URLs; the download inbox holds files
        // the user has not moved into the workspace yet.
        const restorable = join(state, 'browser', 'restorable.json')
        writeFileSync(restorable, '{"tabs":["https://private.test/?t=1"]}')
        const restorableRead = sandbox.confine(['/bin/cat', restorable], policy)
        const restorableDenied = spawnSync(
          restorableRead.argv[0]!,
          restorableRead.argv.slice(1),
          { encoding: 'utf8', timeout: 5_000 },
        )
        expect(restorableDenied.status).not.toBe(0)
        expect(restorableDenied.stdout).not.toContain('private.test')
        const working = sandbox.confine(['/usr/bin/git', '--version'], policy)
        // A fresh machine's first git call resolves the developer tools,
        // which can take several seconds.
        const allowed = spawnSync(working.argv[0]!, working.argv.slice(1), {
          encoding: 'utf8',
          timeout: 30_000,
        })
        expect(allowed.status).toBe(0)
        expect(allowed.stdout).toContain('git version')
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    },
  )

  it.skipIf(process.platform !== 'darwin')(
    'runs common development commands inside the workspace-write profile',
    () => {
      const root = mkdtempSync(join(tmpdir(), 'emperor-cu-dev-'))
      try {
        writeFileSync(
          join(root, 'package.json'),
          '{"name":"sandbox-fixture","version":"1.0.0"}\n',
        )
        writeFileSync(join(root, 'main.swift'), 'print("sandbox-fixture")\n')
        writeFileSync(
          join(root, 'hello.c'),
          '#include <stdio.h>\nint main(void){puts("c-fixture");return 0;}\n',
        )
        writeFileSync(
          join(root, 'Makefile'),
          'out.txt:\n\tprintf made > out.txt\n',
        )
        const sandbox = new LocalSandbox({
          protectedStateRoot: join(root, 'state'),
        })
        const policy = { mode: 'workspace-write' as const, workspaceRoot: root }
        const git = (...args: string[]) => [
          '/usr/bin/git',
          '-C',
          'repo',
          '-c',
          'user.name=Fixture',
          '-c',
          'user.email=fixture@example.invalid',
          ...args,
        ]
        // E-M13: the confinement must not break everyday development work.
        const commands = [
          ['/usr/bin/git', 'init', '-q', 'repo'],
          ['/bin/sh', '-c', 'printf x > repo/a.txt'],
          git('add', 'a.txt'),
          git('commit', '-q', '-m', 'fixture'),
          git('log', '--oneline'),
          git('status', '--short'),
          ['/usr/bin/env', 'npm', 'pkg', 'set', 'version=1.0.1'],
          ['/usr/bin/env', 'npm', 'pkg', 'set', 'scripts.hello=echo hi'],
          ['/usr/bin/env', 'npm', 'run', '--silent', 'hello'],
          [
            process.execPath,
            '-e',
            "require('node:fs').writeFileSync('node.txt', 'ok')",
          ],
          ['/usr/bin/python3', '-c', "open('py.txt','w').write('ok')"],
          ['/usr/bin/make', '-s'],
          ['/usr/bin/cc', '-o', join(root, 'hello-c'), join(root, 'hello.c')],
          [join(root, 'hello-c')],
          // Its module cache lives in the workspace: a fresh machine has no
          // user cache to read, and the profile keeps that directory closed.
          [
            '/usr/bin/swiftc',
            '-module-cache-path',
            join(root, 'module-cache'),
            '-o',
            join(root, 'hello'),
            join(root, 'main.swift'),
          ],
          [join(root, 'hello')],
          ['/usr/bin/tar', '-czf', 'bundle.tgz', 'node.txt', 'py.txt'],
          ['/usr/bin/grep', '-r', 'ok', 'node.txt'],
        ]
        for (const command of commands) {
          const confined = sandbox.confine(command, policy)
          const result = spawnSync(confined.argv[0]!, confined.argv.slice(1), {
            cwd: root,
            env: { ...process.env, npm_config_cache: join(root, 'npm-cache') },
            encoding: 'utf8',
            // A cold macOS 26 SDK module cache on Intel CI can take more
            // than 30 seconds; other commands retain their normal bound.
            timeout: command[0] === '/usr/bin/swiftc' ? 120_000 : 30_000,
          })
          expect(
            result.error,
            `${command.join(' ')}: ${result.stderr}`,
          ).toBeUndefined()
          expect(result.status, `${command.join(' ')}: ${result.stderr}`).toBe(
            0,
          )
        }
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    },
  )

  it.skipIf(process.platform !== 'darwin')(
    'keeps a confined Shell from planting git hooks but lets git init write samples',
    () => {
      const root = mkdtempSync(join(tmpdir(), 'emperor-git-hooks-'))
      try {
        const sandbox = new LocalSandbox({
          protectedStateRoot: join(root, 'state'),
        })
        const policy = { mode: 'workspace-write' as const, workspaceRoot: root }
        const run = (command: string[]) => {
          const confined = sandbox.confine(command, policy)
          return spawnSync(confined.argv[0]!, confined.argv.slice(1), {
            cwd: root,
            encoding: 'utf8',
            timeout: 30_000,
          })
        }
        expect(run(['/usr/bin/git', 'init', '-q', 'repo']).status).toBe(0)
        const planted = run([
          '/bin/sh',
          '-c',
          'printf "#!/bin/sh\\ntouch pwned" > repo/.git/hooks/pre-commit',
        ])
        expect(planted.status).not.toBe(0)
        const sample = run([
          '/bin/sh',
          '-c',
          'printf x > repo/.git/hooks/custom.sample',
        ])
        expect(sample.status).toBe(0)
        expect(
          run(['/bin/sh', '-c', 'printf "* text\\n" > repo/.gitattributes'])
            .status,
        ).toBe(0)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    },
  )

  it.skipIf(process.platform !== 'darwin')(
    'rejects connections to both helper socket directories',
    async () => {
      // Never the real ~/.emperor/run: a test must not write in the user's
      // Emperor Home, and a 0755 run folder it leaves on a CI runner makes
      // the packaged Native Messaging host refuse its socket as insecure.
      // The home folder gets the same rule as a custom Emperor Home's run
      // folder (emperorSocketDirectories), exercised here with a temporary
      // state root; the per-user temp folder is created (0700) and removed
      // only when the test made it.
      const stateRoot = mkdtempSync(join(tmpdir(), 'emperor-socket-state-'))
      const workspace = mkdtempSync(join(tmpdir(), 'emperor-socket-ws-'))
      const userTemp = join(tmpdir(), `emperor-${process.getuid?.() ?? 0}`)
      const madeUserTemp = !existsSync(userTemp)
      const cases = [
        {
          directory: join(stateRoot, 'run'),
          sandbox: new LocalSandbox({ protectedStateRoot: stateRoot }),
        },
        { directory: userTemp, sandbox: new LocalSandbox() },
      ]
      try {
        for (const { directory, sandbox } of cases) {
          mkdirSync(directory, { recursive: true, mode: 0o700 })
          const socketPath = join(
            directory,
            `st-${randomUUID().slice(0, 8)}.sock`,
          )
          const server = createServer()
          try {
            await new Promise<void>((resolve, reject) => {
              server.once('error', reject)
              server.listen(socketPath, resolve)
            })
            const script =
              `require('node:net').createConnection(${JSON.stringify(socketPath)})` +
              `.on('connect', () => process.exit(0))` +
              `.on('error', e => { console.error(e.code); process.exit(13) })`
            const direct = spawnSync(process.execPath, ['-e', script], {
              encoding: 'utf8',
              timeout: 5_000,
            })
            expect(direct.status).toBe(0)
            const confined = sandbox.confine([process.execPath, '-e', script], {
              mode: 'read-only',
              workspaceRoot: workspace,
            })
            const denied = spawnSync(
              confined.argv[0]!,
              confined.argv.slice(1),
              { encoding: 'utf8', timeout: 5_000 },
            )
            expect(denied.status).toBe(13)
            expect(denied.stderr).toContain('EPERM')
          } finally {
            await new Promise<void>((resolve) => server.close(() => resolve()))
            rmSync(socketPath, { force: true })
          }
        }
      } finally {
        rmSync(stateRoot, { recursive: true, force: true })
        rmSync(workspace, { recursive: true, force: true })
        if (madeUserTemp) rmSync(userTemp, { recursive: true, force: true })
      }
    },
  )

  it.skipIf(process.platform !== 'darwin')(
    'blocks Apple Events and WindowServer access',
    () => {
      const root = mkdtempSync(join(tmpdir(), 'emperor-cu-mac-'))
      try {
        const source = join(root, 'probe.c')
        const binary = join(root, 'probe')
        writeFileSync(
          source,
          `
#include <CoreGraphics/CoreGraphics.h>
#include <dlfcn.h>
#include <stdio.h>
#include <unistd.h>
typedef int (*sandbox_check_fn)(pid_t, const char *, int, ...);
int main(void) {
  sandbox_check_fn check = (sandbox_check_fn)dlsym(RTLD_DEFAULT, "sandbox_check");
  if (!check) return 90;
  printf("appleevent=%d\\n", check(getpid(), "appleevent-send", 0));
  CFArrayRef windows = CGWindowListCopyWindowInfo(kCGWindowListOptionAll, kCGNullWindowID);
  printf("windows=%ld\\n", windows ? (long)CFArrayGetCount(windows) : -1L);
  if (windows) CFRelease(windows);
  return 0;
}
`,
        )
        const compile = spawnSync(
          '/usr/bin/clang',
          [
            source,
            '-framework',
            'CoreGraphics',
            '-framework',
            'CoreFoundation',
            '-o',
            binary,
          ],
          {
            encoding: 'utf8',
            timeout: 30_000,
          },
        )
        expect(compile.status, compile.stderr).toBe(0)
        const baseline = spawnSync(binary, [], {
          encoding: 'utf8',
          timeout: 5_000,
        })
        expect(baseline.status, baseline.stderr).toBe(0)
        expect(baseline.stdout).toContain('appleevent=0')
        const sandbox = new LocalSandbox()
        const confined = sandbox.confine([binary], {
          mode: 'read-only',
          workspaceRoot: root,
        })
        const denied = spawnSync(confined.argv[0]!, confined.argv.slice(1), {
          encoding: 'utf8',
          timeout: 5_000,
        })
        expect(denied.status, denied.stderr).toBe(0)
        expect(denied.stdout).toContain('appleevent=1')
        if (/windows=\d+/.test(baseline.stdout))
          expect(denied.stdout).toContain('windows=-1')
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    },
  )
})

describe('host-granted single-file writes', () => {
  it('allows writing exactly the granted files', () => {
    const profile = seatbeltProfileArgs({
      mode: 'read-only',
      workspaceRoot: '/fixture',
      privateTempRoot: '/fixture-tmp',
      writableFiles: ['/Users/fixture/.codex/auth.json'],
    })[1]!
    expect(profile).toContain(
      '(allow file-write* (literal "/Users/fixture/.codex/auth.json"))',
    )
    expect(profile).not.toContain('(subpath "/Users/fixture/.codex")')
  })

  it.skipIf(process.platform !== 'darwin')(
    'a confined process can rewrite the granted file but not its neighbours',
    () => {
      const root = mkdtempSync(join(tmpdir(), 'emperor-file-grant-'))
      try {
        const home = join(root, 'home', '.codex')
        mkdirSync(home, { recursive: true })
        const granted = join(home, 'auth.json'),
          neighbour = join(home, 'config.toml')
        writeFileSync(granted, 'old')
        writeFileSync(neighbour, 'old')
        const sandbox = new LocalSandbox()
        const policy = {
          mode: 'read-only' as const,
          workspaceRoot: root,
          privateTempRoot: join(root, 'tmp'),
          writableFiles: [granted],
        }
        mkdirSync(policy.privateTempRoot)
        const write = (path: string) => {
          const confined = sandbox.confine(
            ['/bin/sh', '-c', `printf new > ${JSON.stringify(path)}`],
            policy,
          )
          return spawnSync(confined.argv[0]!, confined.argv.slice(1), {
            encoding: 'utf8',
            timeout: 5_000,
          })
        }
        expect(write(granted).status).toBe(0)
        expect(write(neighbour).status).not.toBe(0)
        expect(write(join(home, 'auth.json.tmp')).status).not.toBe(0)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    },
  )
})

describe('protected paths in Shell (SEC-06)', () => {
  /** Emperor Home inside a fixture home, as ~/.emperor sits in ~. */
  function fixture() {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'emperor-sec06-')))
    const home = join(root, 'home')
    const state = join(home, '.emperor')
    const workspace = join(root, 'ws')
    mkdirSync(join(state, 'computer-use'), { recursive: true })
    mkdirSync(join(home, '.ssh'), { recursive: true })
    mkdirSync(join(home, '.codex'), { recursive: true })
    mkdirSync(workspace)
    writeFileSync(join(state, 'model_config.json'), 'MODEL-CONFIG-FIXTURE')
    writeFileSync(join(state, 'mcp_config.json'), 'MCP-CONFIG-FIXTURE')
    writeFileSync(join(state, 'settings.json'), '{}')
    writeFileSync(join(state, 'computer-use', 'vault.json'), 'VAULT-FIXTURE')
    writeFileSync(join(home, '.ssh', 'id_rsa'), 'SSH-KEY-FIXTURE')
    writeFileSync(join(home, '.codex', 'auth.json'), 'CODEX-AUTH-FIXTURE')
    const sandbox = new LocalSandbox({
      protectedStateRoot: state,
      protectedHome: home,
    })
    const run = (
      command: string,
      mode: 'read-only' | 'workspace-write' | 'danger-full-access',
      extra: Partial<SandboxPolicy> = {},
    ) => {
      const argv = ['/bin/sh', '-c', command]
      const wrapped =
        mode === 'danger-full-access'
          ? (sandbox.guard(argv) ?? { argv })
          : sandbox.confine(argv, { mode, workspaceRoot: workspace, ...extra })
      return spawnSync(wrapped.argv[0]!, wrapped.argv.slice(1), {
        cwd: workspace,
        encoding: 'utf8',
        timeout: 10_000,
      })
    }
    return { root, home, state, workspace, sandbox, run }
  }

  it('writes the table into the Seatbelt profile', () => {
    const f = fixture()
    try {
      const profile = seatbeltProfileArgs(
        { mode: 'workspace-write', workspaceRoot: f.workspace },
        f.state,
        f.home,
      )[1]!
      expect(profile).toContain(
        `(deny file-read* file-write* (subpath "${join(f.state, 'computer-use')}"))`,
      )
      expect(profile).toContain(
        `(deny file-read* file-write* (subpath "${join(f.home, '.ssh')}"))`,
      )
      expect(profile).toMatch(
        /\(deny file-read\* file-write\* \(regex "\^.*model_config\|mcp_config/,
      )
      const guard = seatbeltGuardArgs(f.state, f.home)[1]!
      expect(guard).toContain('(allow default)')
      expect(guard).not.toContain('(deny file-write*)')
      expect(guard).toContain(
        `(deny file-write* (subpath "${join(f.home, '.ssh')}"))`,
      )
      expect(guard).not.toContain(
        `(deny file-read* file-write* (subpath "${join(f.home, '.ssh')}"))`,
      )
    } finally {
      rmSync(f.root, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform !== 'darwin')(
    'reports a full-access denial only when it names a protected path',
    () => {
      const f = fixture()
      try {
        const guarded = f.sandbox.guard(['/bin/true'])!
        expect(guarded.argv[0]).toBe('/usr/bin/sandbox-exec')
        const denied = (line: string) =>
          classifyConfinedStderr(guarded, line, 1).denied
        expect(
          denied(
            `cat: ${join(f.state, 'model_config.json')}: Operation not permitted`,
          ),
        ).toBe(true)
        expect(
          denied(
            `sh: ${join(f.home, '.ssh', 'config')}: Operation not permitted`,
          ),
        ).toBe(true)
        // Privacy-protected folders and root-owned files say the same words.
        expect(
          denied('ls: /Users/someone/Library/Mail: Operation not permitted'),
        ).toBe(false)
        expect(denied('rm: /System/x: Operation not permitted')).toBe(false)
      } finally {
        rmSync(f.root, { recursive: true, force: true })
      }
    },
  )

  it.skipIf(process.platform !== 'darwin')(
    'cat ~/.emperor/model_config.json is denied by Seatbelt, with or without escalation (card 6)',
    () => {
      const f = fixture()
      try {
        for (const mode of [
          'read-only',
          'workspace-write',
          'danger-full-access',
        ] as const) {
          for (const name of ['model_config.json', 'mcp_config.json']) {
            const result = f.run(
              `cat ${JSON.stringify(join(f.state, name))}`,
              mode,
            )
            expect(result.status, `${mode} ${name}`).not.toBe(0)
            expect(result.stdout).not.toContain('CONFIG-FIXTURE')
            expect(result.stderr).toContain('Operation not permitted')
          }
          const vault = f.run(
            `cat ${JSON.stringify(join(f.state, 'computer-use', 'vault.json'))}`,
            mode,
          )
          expect(vault.stdout, mode).not.toContain('VAULT-FIXTURE')
          // Overwriting a config file or moving Emperor Home aside fails too.
          expect(
            f.run(
              `printf x > ${JSON.stringify(join(f.state, 'settings.json'))}`,
              mode,
            ).status,
            mode,
          ).not.toBe(0)
          expect(
            f.run(
              `mv ${JSON.stringify(f.state)} ${JSON.stringify(`${f.state}-moved`)}`,
              mode,
            ).status,
            mode,
          ).not.toBe(0)
          expect(existsSync(join(f.state, 'model_config.json'))).toBe(true)
        }
        // The rest of Emperor Home and ordinary work stay as they were.
        writeFileSync(join(f.state, 'notes.txt'), 'NOTES')
        expect(
          f.run(
            `cat ${JSON.stringify(join(f.state, 'notes.txt'))}`,
            'danger-full-access',
          ).stdout,
        ).toBe('NOTES')
        expect(
          f.run(
            `printf ok > ${JSON.stringify(join(f.workspace, 'out.txt'))}`,
            'workspace-write',
          ).status,
        ).toBe(0)
      } finally {
        rmSync(f.root, { recursive: true, force: true })
      }
    },
  )

  it.skipIf(process.platform !== 'darwin')(
    'credential files: confined reads are denied, full access reads them, nobody writes them',
    () => {
      const f = fixture()
      const key = JSON.stringify(join(f.home, '.ssh', 'id_rsa'))
      try {
        for (const mode of ['read-only', 'workspace-write'] as const) {
          const read = f.run(`cat ${key}`, mode)
          expect(read.status, mode).not.toBe(0)
          expect(read.stdout).not.toContain('SSH-KEY-FIXTURE')
        }
        expect(f.run(`cat ${key}`, 'danger-full-access').stdout).toBe(
          'SSH-KEY-FIXTURE',
        )
        const planted = f.run(
          `printf attacker >> ${JSON.stringify(join(f.home, '.ssh', 'authorized_keys'))}`,
          'danger-full-access',
        )
        expect(planted.status).not.toBe(0)
        expect(existsSync(join(f.home, '.ssh', 'authorized_keys'))).toBe(false)
        // A workspace that is the home folder itself still cannot reach them.
        const atHome = f.sandbox.confine(
          ['/bin/cat', join(f.home, '.ssh', 'id_rsa')],
          {
            mode: 'workspace-write',
            workspaceRoot: f.home,
          },
        )
        const homeRead = spawnSync(atHome.argv[0]!, atHome.argv.slice(1), {
          encoding: 'utf8',
          timeout: 10_000,
        })
        expect(homeRead.stdout).not.toContain('SSH-KEY-FIXTURE')
      } finally {
        rmSync(f.root, { recursive: true, force: true })
      }
    },
  )

  it.skipIf(process.platform !== 'darwin')(
    "keeps the Codex child's own auth.json grant working (AGT-03)",
    () => {
      const f = fixture()
      const auth = join(f.home, '.codex', 'auth.json')
      try {
        // The Agent's Shell: no grant, so no read.
        expect(
          f.run(`cat ${JSON.stringify(auth)}`, 'read-only').stdout,
        ).not.toContain('CODEX-AUTH-FIXTURE')
        // The Codex process Emperor launches: host-granted, read and rewrite.
        const tmp = join(f.root, 'tmp')
        mkdirSync(tmp)
        const granted = {
          privateTempRoot: tmp,
          runtimeStateRoots: [join(f.root, 'runtime')],
          writableFiles: [auth],
        }
        expect(
          f.run(`cat ${JSON.stringify(auth)}`, 'read-only', granted).stdout,
        ).toBe('CODEX-AUTH-FIXTURE')
        expect(
          f.run(
            `printf refreshed > ${JSON.stringify(auth)}`,
            'read-only',
            granted,
          ).status,
        ).toBe(0)
        expect(readFileSync(auth, 'utf8')).toBe('refreshed')
        // The grant never reaches Emperor's own config files.
        expect(
          f.run(
            `cat ${JSON.stringify(join(f.state, 'model_config.json'))}`,
            'read-only',
            {
              ...granted,
              writableFiles: [auth, join(f.state, 'model_config.json')],
            },
          ).stdout,
        ).not.toContain('MODEL-CONFIG-FIXTURE')
      } finally {
        rmSync(f.root, { recursive: true, force: true })
      }
    },
  )
})
