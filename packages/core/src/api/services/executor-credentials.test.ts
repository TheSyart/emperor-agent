import { expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeApi, tmp } from '../test-helpers'
import { invokeCoreOperation } from '../operations'

/**
 * AGT-02 · 设置 › 子智能体 › Claude Code「设置令牌」: the token is sealed
 * with Emperor's local key, never read back to the renderer, and the
 * probe reports the sign-in it found. A temporary home stands in for ~.
 */
const VIEW = { view: { sessionId: null } }
const TOKEN = 'sk-ant-oat01-fixture-settings-token-7f3e'

async function api() {
  const root = tmp('emperor-agt02-')
  const home = join(root, 'executor-home')
  mkdirSync(home, { recursive: true })
  const { api } = await makeApi({
    root,
    extra: {
      executorHome: {
        home,
        environment: { PATH: '/usr/bin:/bin' },
        loginShell: { read: async () => ({}) },
      },
    } as never,
  })
  // The CLI's --version is not what this test is about.
  vi.spyOn(api.executorRegistry, 'probe').mockImplementation(async (p) => ({
    status: 'available',
    checkedAt: Date.now(),
    authVerified: false,
    capabilities: api.executorRegistry.capabilities(p.backend),
  }))
  return api
}

it('1 · 设置令牌 seals the pasted token and the list shows only 末 4 位', async () => {
  const core = await api()
  try {
    // A renderer call without a view is refused like any other mutation.
    await expect(
      invokeCoreOperation(core, 'executors.setCredential', [
        { profileId: 'claude-default', kind: 'oauth-token', token: TOKEN },
      ]),
    ).rejects.toMatchObject({ code: 'SESSION_REQUIRED' })
    const saved = await invokeCoreOperation(
      core,
      'executors.setCredential',
      [{ profileId: 'claude-default', kind: 'oauth-token', token: TOKEN }],
      VIEW,
    )
    expect(saved).toMatchObject({
      credential: { kind: 'oauth-token', last4: '7f3e' },
      probe: {
        status: 'available',
        auth: { source: 'emperor', kind: 'oauth-token' },
      },
    })
    expect(JSON.stringify(saved)).not.toContain(TOKEN)
    const listed = core.executors.list()
    expect(
      listed.profiles.find((p) => p.profile.id === 'claude-default'),
    ).toMatchObject({ credential: { kind: 'oauth-token', last4: '7f3e' } })
    expect(JSON.stringify(listed)).not.toContain(TOKEN)
    const file = join(core.paths.delegationsRoot, 'credentials.json')
    expect(readFileSync(file, 'utf8')).toContain('el1:')
    expect(readFileSync(file, 'utf8')).not.toContain(TOKEN)
    // Whitespace and line breaks never reach the CLI.
    await expect(
      invokeCoreOperation(
        core,
        'executors.setCredential',
        [{ profileId: 'claude-default', kind: 'api-key', token: 'a b\nc' }],
        VIEW,
      ),
    ).rejects.toThrow()
    // Codex keeps its own login.
    await expect(
      invokeCoreOperation(
        core,
        'executors.setCredential',
        [{ profileId: 'codex-default', kind: 'api-key', token: TOKEN }],
        VIEW,
      ),
    ).rejects.toThrow('UNSUPPORTED')
  } finally {
    await core.close()
  }
})

it('5 · without any sign-in the settings probe says 需要登录; removing the token goes back to that', async () => {
  const core = await api()
  try {
    await invokeCoreOperation(
      core,
      'executors.setCredential',
      [{ profileId: 'claude-default', kind: 'api-key', token: TOKEN }],
      VIEW,
    )
    await expect(
      invokeCoreOperation(core, 'executors.clearCredential', [
        { profileId: 'claude-default' },
      ]),
    ).rejects.toMatchObject({ code: 'SESSION_REQUIRED' })
    const cleared = await invokeCoreOperation(
      core,
      'executors.clearCredential',
      [{ profileId: 'claude-default' }],
      VIEW,
    )
    expect(cleared).toMatchObject({
      credential: null,
      probe: {
        status: 'needs_auth',
        diagnostic: 'AUTH_REQUIRED',
        auth: { source: null, problem: 'missing' },
      },
    })
    expect(
      core.executors
        .list()
        .profiles.find((p) => p.profile.id === 'claude-default')?.credential,
    ).toBeNull()
    expect(
      await core.executors.probe({ profileId: 'claude-default' }),
    ).toMatchObject({ status: 'needs_auth', localAuthChecked: false })
    expect(
      existsSync(join(core.paths.delegationsRoot, 'credentials.json')),
    ).toBe(true)
  } finally {
    await core.close()
  }
})
