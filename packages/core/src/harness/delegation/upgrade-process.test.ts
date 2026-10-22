/**
 * AGT-13: the upgrade command runs as its own process group outside the
 * sandbox, never as root; its output reaches the UI line by line with
 * credentials, ANSI and the home folder taken out; 取消 and the time limit
 * stop the whole group. Fake commands only.
 */
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  classifyUpgradeFailure,
  sanitizeUpgradeLine,
  startUpgradeProcess,
} from './upgrade-process'
import { delegationTestDirectory } from './testing'

const cleanup: Array<() => void> = []
afterEach(() => cleanup.splice(0).forEach((f) => f()))
function dir() {
  const d = delegationTestDirectory()
  cleanup.push(d.cleanup)
  return d.root
}
function script(path: string, body: string) {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
async function until(check: () => boolean, ms = 10_000) {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 25))
  }
}

describe('upgrade process', () => {
  it('streams sanitised lines and ends with the exit code', async () => {
    const root = dir()
    const home = join(root, 'home')
    script(
      join(root, 'npm'),
      [
        'echo "npm http fetch GET 200 https://registry.npmjs.org/@openai%2fcodex 120ms"',
        'printf "\\033[32madded 1 package\\033[0m in 2s\\n"',
        `echo "//registry.npmjs.org/:_authToken=npm_${'a'.repeat(36)}"`,
        'echo "fetch https://ci:s3cr3t-pass@npm.example.com/pkg" >&2',
        `echo "wrote ${home}/.npmrc"`,
        'exit 0',
      ].join('\n'),
    )
    const lines: string[] = []
    const run = await startUpgradeProcess({
      argv: [join(root, 'npm'), 'install', '-g', '@openai/codex@0.163.0'],
      env: { PATH: '/usr/bin:/bin' },
      cwd: root,
      home,
      onLine: (line) => lines.push(line),
    })
    expect(run.started).toBe(true)
    const outcome = await run.done
    expect(outcome).toMatchObject({ ended: 'exit', exitCode: 0 })
    const text = lines.join('\n')
    expect(text).toContain('added 1 package in 2s')
    expect(text).not.toContain('\u001b[')
    expect(text).not.toContain('npm_aaaa')
    expect(text).not.toContain('s3cr3t-pass')
    expect(text).toContain('~/.npmrc')
    expect(text).not.toContain(home)
    expect(outcome.output).toContain('added 1 package')
  })

  it('取消 stops the command and everything it started', async () => {
    const root = dir()
    script(
      join(root, 'npm'),
      `sleep 600 & echo "$$ $!" > "${root}/pids"; echo started; wait`,
    )
    const run = await startUpgradeProcess({
      argv: [join(root, 'npm'), 'install', '-g', 'x@1.0.0'],
      env: { PATH: '/usr/bin:/bin' },
      cwd: root,
      home: root,
      graceMs: 200,
    })
    await until(() => existsSync(join(root, 'pids')))
    const { readFileSync } = await import('node:fs')
    const pids = readFileSync(join(root, 'pids'), 'utf8')
      .trim()
      .split(/\s+/)
      .map(Number)
    expect(pids.every(alive)).toBe(true)
    const outcome = await run.cancel()
    expect(outcome.ended).toBe('cancelled')
    await until(() => pids.every((pid) => !alive(pid)))
  })

  it('the time limit stops it too', async () => {
    const root = dir()
    script(join(root, 'npm'), 'sleep 600')
    const run = await startUpgradeProcess({
      argv: [join(root, 'npm')],
      env: { PATH: '/usr/bin:/bin' },
      cwd: root,
      home: root,
      timeoutMs: 150,
      graceMs: 100,
    })
    expect((await run.done).ended).toBe('timeout')
  })

  it('a command that cannot start says so', async () => {
    const root = dir()
    const run = await startUpgradeProcess({
      argv: [join(root, 'missing-npm'), 'install'],
      env: { PATH: '/usr/bin:/bin' },
      cwd: root,
      home: root,
    })
    expect(run.started).toBe(false)
    expect(await run.done).toMatchObject({ ended: 'start', exitCode: null })
  })

  it('never runs with sudo', async () => {
    await expect(
      startUpgradeProcess({
        argv: ['/usr/bin/sudo', 'npm', 'install'],
        env: {},
        cwd: '/',
        home: '/',
      }),
    ).rejects.toThrow(/sudo/)
  })

  it('tells a missing write permission and a network failure from the rest', () => {
    const eacces = [
      'npm error code EACCES',
      'npm error syscall mkdir',
      'npm error path /opt/homebrew/lib/node_modules/@openai/codex',
      "npm error Error: EACCES: permission denied, mkdir '/opt/homebrew/lib/node_modules/@openai/codex'",
    ].join('\n')
    expect(classifyUpgradeFailure(eacces)).toBe('permission')
    expect(
      classifyUpgradeFailure('Error: EPERM: operation not permitted'),
    ).toBe('permission')
    expect(
      classifyUpgradeFailure('Error: Permission denied @ dir_s_mkdir'),
    ).toBe('permission')
    for (const net of [
      'npm error code ENOTFOUND',
      'npm error network request to https://registry.npmjs.org failed, reason: getaddrinfo EAI_AGAIN',
      'npm error code ETIMEDOUT',
      'curl: (6) Could not resolve host: formulae.brew.sh',
      'npm error code ECONNRESET',
    ])
      expect(classifyUpgradeFailure(net)).toBe('network')
    expect(classifyUpgradeFailure('npm error code E404')).toBe('exit')
    expect(classifyUpgradeFailure('')).toBe('exit')
  })

  it('cleans one line for the UI', () => {
    expect(
      sanitizeUpgradeLine(
        '\u001b[1mBearer abc\u001b[0m Authorization: Bearer tok123',
        {
          home: '/Users/ada',
        },
      ),
    ).toBe('Bearer abc Authorization: Bearer [REDACTED]')
    expect(
      sanitizeUpgradeLine('cd /Users/ada/project && npm i', {
        home: '/Users/ada',
      }),
    ).toBe('cd ~/project && npm i')
    expect(sanitizeUpgradeLine('x'.repeat(2000), { home: '/h' })).toHaveLength(
      500,
    )
  })
})
