import { afterEach, describe, expect, it } from 'vitest'
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CoreApi } from './core-api'
import { invokeCoreOperation } from './operations'
import { makeApi } from './test-helpers'

// BUG-11: the 文件 pane follows the project; changes reach the session as
// workspace_files_changed with project-relative paths.

const apis: CoreApi[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const api of apis.splice(0)) await api.close()
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

async function setup() {
  const { api, events } = await makeApi()
  apis.push(api)
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'emperor-file-watch-')))
  dirs.push(root)
  mkdirSync(join(root, 'src'), { recursive: true })
  const sessionId = String(
    api.sessions.create({ title: 'Watch', mode: 'build', project_path: root })
      .id,
  )
  const changes = () =>
    events.filter(
      (e) =>
        e.event === 'workspace_files_changed' && e.session_id === sessionId,
    )
  return { api, root, sessionId, changes }
}

async function until(check: () => boolean, ms = 5000) {
  const end = Date.now() + ms
  while (!check() && Date.now() < end)
    await new Promise((r) => setTimeout(r, 50))
}

describe('files.watch (BUG-11)', () => {
  it('sends a change in the project to the session that watches it', async () => {
    const f = await setup()
    await expect(
      invokeCoreOperation(f.api, 'files.watch', [{ sessionId: f.sessionId }]),
    ).resolves.toEqual({ watching: true })
    await new Promise((r) => setTimeout(r, 200))
    writeFileSync(join(f.root, 'src', 'new.txt'), 'hi')
    await until(() =>
      f
        .changes()
        .some(
          (e) =>
            e.overflow === true ||
            (e.paths as string[]).includes('src/new.txt'),
        ),
    )
    expect(
      f
        .changes()
        .some(
          (e) =>
            e.overflow === true ||
            (e.paths as string[]).includes('src/new.txt'),
        ),
    ).toBe(true)
  }, 10_000)

  it('stops after files.unwatch, and watching twice does not double the events', async () => {
    const f = await setup()
    await invokeCoreOperation(f.api, 'files.watch', [
      { sessionId: f.sessionId },
    ])
    await invokeCoreOperation(f.api, 'files.watch', [
      { sessionId: f.sessionId },
    ])
    await new Promise((r) => setTimeout(r, 200))
    writeFileSync(join(f.root, 'a.md'), '1')
    await until(() => f.changes().length > 0)
    await new Promise((r) => setTimeout(r, 600))
    const named = f
      .changes()
      .filter((e) => (e.paths as string[]).includes('a.md'))
    expect(named.length).toBeLessThanOrEqual(1)
    await expect(
      invokeCoreOperation(f.api, 'files.unwatch', [{ sessionId: f.sessionId }]),
    ).resolves.toEqual({ watching: false })
    const before = f.changes().length
    writeFileSync(join(f.root, 'b.md'), '2')
    await new Promise((r) => setTimeout(r, 800))
    expect(f.changes().length).toBe(before)
  }, 10_000)

  it('refuses a session without a project', async () => {
    const { api } = await makeApi()
    apis.push(api)
    const sessionId = String(api.sessions.create({ title: 'chat' }).id)
    await expect(
      invokeCoreOperation(api, 'files.watch', [{ sessionId }]),
    ).rejects.toMatchObject({ code: 'workspace_project_required' })
  })

  it('rejects unknown arguments', async () => {
    const { api } = await makeApi()
    apis.push(api)
    await expect(
      invokeCoreOperation(api, 'files.watch', [{ sessionId: 's', extra: 1 }]),
    ).rejects.toMatchObject({ code: 'invalid_core_arguments' })
  })
})
