import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { makeApi, type ApiFixture } from './test-helpers'

/** Settings changes come from the app, which names no session here. */
const VIEW = { sessionId: null }

// 设置 › 常规 › 会话 › 新会话的权限 (UI-S07): the preset a session starts
// with (settings.json › sessions.defaultPermission). Sessions that already
// have a log keep theirs; drafts and sessions opened for the first time
// follow the default.

const fixtures: ApiFixture[] = []

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.api.close()
})

async function api(stateRoot?: string): Promise<ApiFixture> {
  const fixture = await makeApi(stateRoot ? { stateRoot } : {})
  fixtures.push(fixture)
  return fixture
}

function settings(stateRoot: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(stateRoot, 'settings.json'), 'utf8'))
}

describe('sessions.defaults', () => {
  it('starts new sessions in 工作区可写 until changed', async () => {
    const { api: core } = await api()
    expect(core.sessions.defaults()).toEqual({ permission: 'workspace-write' })
    expect(core.control.get(null).preset).toBe('workspace-write')
  })

  it('saves the default; new sessions and drafts follow, used sessions keep theirs', async () => {
    const { api: core } = await api()
    const used = (await core.sessions.create({ title: 'used' })) as {
      id: string
    }
    core.control.setPermissionMode('workspace-write', used.id)

    await expect(
      core.sessions.setDefaults({ permission: 'read-only' }, VIEW),
    ).resolves.toEqual({ permission: 'read-only' })
    const stateRoot = core.paths.stateRoot
    expect(settings(stateRoot).sessions).toEqual({
      defaultPermission: 'read-only',
    })

    expect(core.control.get(null).preset).toBe('read-only')
    const fresh = (await core.sessions.create({ title: 'fresh' })) as {
      id: string
    }
    core.host.agentFor(fresh.id)
    expect(core.control.get(fresh.id).preset).toBe('read-only')
    expect(core.control.get(used.id).preset).toBe('workspace-write')
  })

  it('reads the saved default after a restart, keeping other settings', async () => {
    const first = await api()
    const stateRoot = first.api.paths.stateRoot
    await first.api.tools.setNetworkSettings({ webFetch: false }, VIEW)
    await first.api.sessions.setDefaults(
      { permission: 'danger-full-access' },
      VIEW,
    )
    await first.api.close()
    fixtures.splice(fixtures.indexOf(first), 1)

    const second = await api(stateRoot)
    expect(second.api.sessions.defaults()).toEqual({
      permission: 'danger-full-access',
    })
    expect(second.api.control.get(null).preset).toBe('danger-full-access')
    expect(settings(stateRoot).webTools).toEqual({
      webFetch: false,
      webSearch: true,
    })
  })

  it('refuses a preset that does not exist and changes nothing', async () => {
    const { api: core } = await api()
    await expect(
      core.sessions.setDefaults({ permission: 'root' } as never, VIEW),
    ).rejects.toThrow('未知的权限')
    expect(core.sessions.defaults()).toEqual({ permission: 'workspace-write' })
  })
})
