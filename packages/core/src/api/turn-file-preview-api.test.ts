import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CoreApi } from './core-api'
import { CORE_OPERATION_REGISTRY, invokeCoreOperation } from './operations'
import { makeApi } from './test-helpers'

const apis: CoreApi[] = []
afterEach(async () => {
  for (const api of apis.splice(0)) await api.close()
})

async function setup(path = '报告 with spaces.md') {
  const { api } = await makeApi({ replies: [{ text: 'ready' }] })
  apis.push(api)
  const sessionId = String(api.sessions.create({ title: 'File preview' }).id)
  await api.chat.submit({ sessionId, content: 'initialize' })
  const root = api.host.sessionWorkspaceRoot(sessionId)
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, path), '# Preview\nRecorded content\n')
  api.host.sessionLog(sessionId)!.append('turn/files', {
    turn: 1,
    mode: 'tools',
    status: 'recorded',
    files: [{ path, status: 'added', additions: 2, deletions: 0 }],
    totals: { files: 1, additions: 2, deletions: 0 },
  })
  return { api, sessionId, root, path }
}

describe('recorded turn file previews', () => {
  it('reads a recorded Chat file through the typed boundary without changing its log', async () => {
    const { api, sessionId, path } = await setup()
    const events = api.host.sessionLog(sessionId)!.events.slice()
    const value = await invokeCoreOperation(api, 'files.read', [
      { sessionId, relativePath: path, turn: 1 },
    ])
    expect(value).toMatchObject({
      kind: 'text',
      content: '# Preview\nRecorded content\n',
      truncated: false,
    })
    expect(api.host.sessionLog(sessionId)!.events).toEqual(events)
    await expect(
      api.files.read({ sessionId, relativePath: path }),
    ).rejects.toThrow('Build')
  })

  it('rejects another file, another turn and a different session', async () => {
    const { api, sessionId, root, path } = await setup()
    writeFileSync(join(root, 'unrecorded.txt'), 'not part of this turn')
    const other = String(api.sessions.create({ title: 'Other' }).id)
    for (const input of [
      { sessionId, relativePath: 'unrecorded.txt', turn: 1 },
      { sessionId, relativePath: path, turn: 2 },
      { sessionId: other, relativePath: path, turn: 1 },
    ])
      await expect(
        invokeCoreOperation(api, 'files.read', [input]),
      ).rejects.toThrow()
  })

  it('rechecks paths and refuses a recorded file replaced with an outside symlink', async () => {
    const { api, sessionId, root, path } = await setup()
    const outside = join(root, '..', 'outside-preview.txt')
    writeFileSync(outside, 'outside')
    rmSync(join(root, path))
    symlinkSync(outside, join(root, path))
    await expect(
      invokeCoreOperation(api, 'files.read', [
        { sessionId, relativePath: path, turn: 1 },
      ]),
    ).rejects.toThrow()
  })

  it('reports missing files and rejects malformed turn inputs', async () => {
    const { api, sessionId, root, path } = await setup()
    rmSync(join(root, path))
    await expect(
      invokeCoreOperation(api, 'files.read', [
        { sessionId, relativePath: path, turn: 1 },
      ]),
    ).rejects.toThrow()
    for (const turn of [-1, 1.5, '1'])
      expect(() =>
        CORE_OPERATION_REGISTRY['files.read'].args.parse([
          { sessionId, relativePath: path, turn },
        ]),
      ).toThrow()
  })
})
