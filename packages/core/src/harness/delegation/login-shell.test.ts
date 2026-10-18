import { afterEach, expect, it } from 'vitest'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createLoginShellEnvironment } from './login-shell'
import { delegationTestDirectory } from './testing'

const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach((c) => c()))

function shell(body: string): string {
  const f = delegationTestDirectory()
  cleanups.push(f.cleanup)
  const path = join(f.root, 'fake-zsh')
  // Stands in for `zsh -ilc <command>`: rc-file noise, exports, then the command.
  writeFileSync(path, '#!/bin/sh\n' + body + '\nexec /bin/sh -c "$2"\n', {
    mode: 0o700,
  })
  return path
}

it('imports only the requested variables from the login shell, past rc-file output', async () => {
  const login = createLoginShellEnvironment({
    shell: shell(
      'echo "Welcome back"\nprintf "MOTD=x\\n"\nexport TEAM_TOKEN=from-zshrc\n' +
        'export MULTI_LINE="a\nb"\nexport UNRELATED_SECRET=never',
    ),
    environment: { PATH: '/usr/bin:/bin' },
  })
  expect(
    await login.read(['TEAM_TOKEN', 'MULTI_LINE', 'MISSING', 'MOTD']),
  ).toEqual({ TEAM_TOKEN: 'from-zshrc', MULTI_LINE: 'a\nb' })
})

it('gives up after the timeout and falls back to nothing', async () => {
  const login = createLoginShellEnvironment({
    shell: shell('sleep 5'),
    environment: { PATH: '/usr/bin:/bin' },
    timeoutMs: 200,
  })
  const started = Date.now()
  expect(await login.read(['TEAM_TOKEN'])).toEqual({})
  expect(Date.now() - started).toBeLessThan(2000)
})

it('runs the shell once per set of names', async () => {
  const f = delegationTestDirectory()
  cleanups.push(f.cleanup)
  const counter = join(f.root, 'count')
  const login = createLoginShellEnvironment({
    shell: shell(`echo x >> ${JSON.stringify(counter)}\nexport A=1`),
    environment: { PATH: '/usr/bin:/bin' },
  })
  await Promise.all([login.read(['A']), login.read(['A'])])
  await login.read(['A'])
  const { readFileSync } = await import('node:fs')
  expect(readFileSync(counter, 'utf8').trim().split('\n')).toHaveLength(1)
  expect(await login.read([])).toEqual({})
})
