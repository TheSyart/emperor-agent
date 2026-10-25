import { afterEach, describe, expect, it, vi } from 'vitest'
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
import { invokeCoreOperation, isCoreOperationKey } from './operations'
import { makeApi } from './test-helpers'

// BUG-05: files.mediaUrl grants the Files pane a short-lived
// app://workspace-media/<token> address for a video it may preview; main
// alone looks the token up (files.mediaGrant, not a renderer operation).

const apis: CoreApi[] = []
const dirs: string[] = []
afterEach(async () => {
  vi.useRealTimers()
  for (const api of apis.splice(0)) await api.close()
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

async function setup() {
  const { api } = await makeApi()
  apis.push(api)
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'emperor-file-media-')))
  dirs.push(root)
  mkdirSync(join(root, 'clips'), { recursive: true })
  const path = 'clips/飞行 测试.mp4'
  writeFileSync(join(root, path), Buffer.from([0, 0, 0, 24]))
  writeFileSync(join(root, 'notes.md'), '# Notes\n')
  const sessionId = String(
    api.sessions.create({ title: 'Media', mode: 'build', project_path: root })
      .id,
  )
  return { api, sessionId, root, path }
}

function tokenOf(url: string): string {
  const match = /^app:\/\/workspace-media\/([0-9a-f]{32})$/.exec(url)
  if (!match) throw new Error(`not a media url: ${url}`)
  return match[1]!
}

describe('files.mediaUrl', () => {
  it('grants a token for a project video that main resolves to its real path', async () => {
    const { api, sessionId, root, path } = await setup()
    const input = { source: 'project' as const, sessionId, path }
    const { url } = await invokeCoreOperation(api, 'files.mediaUrl', [input])
    const token = tokenOf(url)
    expect(api.files.mediaGrant(token)).toMatchObject({
      token,
      absPath: join(root, path),
      filePath: join(root, path),
      streamable: true,
      sessionId,
      mimeType: 'video/mp4',
    })
    // The same file again: the same address while the grant lasts.
    expect(await invokeCoreOperation(api, 'files.mediaUrl', [input])).toEqual({
      url,
    })
    // main's lookup is not something the renderer can call.
    expect(isCoreOperationKey('files.mediaGrant')).toBe(false)
    expect(api.files.mediaGrant('f'.repeat(32))).toBeNull()
  })

  it('BUG-05 3 · refuses paths outside the project; other files are named, not streamed', async () => {
    const { api, sessionId, root } = await setup()
    writeFileSync(join(root, '..', 'outside.mp4'), '')
    dirs.push(join(root, '..', 'outside.mp4'))
    await expect(
      invokeCoreOperation(api, 'files.mediaUrl', [
        { source: 'project', sessionId, path: '../outside.mp4' },
      ]),
    ).rejects.toMatchObject({ code: 'workspace_path_invalid' })
    await expect(
      invokeCoreOperation(api, 'files.mediaUrl', [
        { source: 'project', sessionId, path: join(root, '..', 'outside.mp4') },
      ]),
    ).rejects.toThrow()
    // BUG-10: any file gets an address (it names the file for 用默认应用打开),
    // but only media is ever streamed from it.
    const notes = await invokeCoreOperation(api, 'files.mediaUrl', [
      { source: 'project', sessionId, path: 'notes.md' },
    ])
    expect(api.files.mediaGrant(tokenOf(notes.url))).toMatchObject({
      filePath: join(root, 'notes.md'),
      streamable: false,
    })
    await expect(
      invokeCoreOperation(api, 'files.mediaUrl', [
        { source: 'project', sessionId, path: 'clips' },
      ]),
    ).rejects.toMatchObject({ code: 'workspace_path_not_file' })
    await expect(
      invokeCoreOperation(api, 'files.mediaUrl', [
        { source: 'project', sessionId, path: 'clips/missing.mp4' },
      ]),
    ).rejects.toMatchObject({ code: 'workspace_path_missing' })
  })

  it('grants a video reference the session may preview, and nothing else', async () => {
    const { api, sessionId, root, path } = await setup()
    const reference = api.references.resolve({
      sessionId,
      sourceMessageId: 'm1',
      href: path,
      label: 'clip',
    })
    const input = {
      source: 'reference' as const,
      sessionId,
      referenceId: reference.id,
    }
    const { url } = await invokeCoreOperation(api, 'files.mediaUrl', [input])
    expect(api.files.mediaGrant(tokenOf(url))?.absPath).toBe(join(root, path))
    const other = String(api.sessions.create({ title: 'Other' }).id)
    await expect(
      invokeCoreOperation(api, 'files.mediaUrl', [
        { ...input, sessionId: other },
      ]),
    ).rejects.toThrow()
  })

  it('BUG-05 4 · an address stops working after ten minutes', async () => {
    const { api, sessionId, path } = await setup()
    vi.useFakeTimers({ toFake: ['Date'] })
    const input = { source: 'project' as const, sessionId, path }
    const { url } = await invokeCoreOperation(api, 'files.mediaUrl', [input])
    vi.setSystemTime(Date.now() + 10 * 60_000)
    expect(api.files.mediaGrant(tokenOf(url))).toBeNull()
    const again = await invokeCoreOperation(api, 'files.mediaUrl', [input])
    expect(again.url).not.toBe(url)
    expect(api.files.mediaGrant(tokenOf(again.url))).not.toBeNull()
  })
})
