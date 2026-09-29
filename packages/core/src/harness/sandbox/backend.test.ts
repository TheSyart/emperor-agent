import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { LocalSandbox } from './backend'

describe('Computer Use Seatbelt confinement', () => {
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
        const allowed = spawnSync(working.argv[0]!, working.argv.slice(1), {
          encoding: 'utf8',
          timeout: 5_000,
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
          [
            '/usr/bin/swiftc',
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
            timeout: 30_000,
          })
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
    'rejects connections to both helper socket directories',
    async () => {
      const directories = [
        join(homedir(), '.emperor', 'run'),
        join(tmpdir(), `emperor-${process.getuid?.() ?? 0}`),
      ]
      for (const directory of directories) {
        mkdirSync(directory, { recursive: true })
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
          const sandbox = new LocalSandbox()
          const confined = sandbox.confine([process.execPath, '-e', script], {
            mode: 'read-only',
            workspaceRoot: directory,
          })
          const denied = spawnSync(confined.argv[0]!, confined.argv.slice(1), {
            encoding: 'utf8',
            timeout: 5_000,
          })
          expect(denied.status).toBe(13)
          expect(denied.stderr).toContain('EPERM')
        } finally {
          await new Promise<void>((resolve) => server.close(() => resolve()))
          rmSync(socketPath, { force: true })
        }
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
