import { afterEach, describe, expect, it } from 'vitest'
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CoreApi } from './core-api'
import { invokeCoreOperation } from './operations'
import { makeApi } from './test-helpers'

// FIX-05 (UI-25): the Files pane asks for a file's size and mtime before it
// shows an open tab again, and rereads it only when either changed.

const apis: CoreApi[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const api of apis.splice(0)) await api.close()
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

async function setup() {
  const { api } = await makeApi()
  apis.push(api)
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'emperor-file-stat-')))
  dirs.push(root)
  mkdirSync(join(root, 'src'), { recursive: true })
  const path = 'src/中文 notes.md'
  writeFileSync(join(root, path), '# First\n')
  const sessionId = String(
    api.sessions.create({ title: 'Stats', mode: 'build', project_path: root })
      .id,
  )
  return { api, sessionId, root, path }
}

describe('files.stat', () => {
  it('reports the size and mtime a preview carries, and follows changes on disk', async () => {
    const { api, sessionId, root, path } = await setup()
    const input = { source: 'project' as const, sessionId, path }
    const first = await invokeCoreOperation(api, 'files.stat', [input])
    const onDisk = statSync(join(root, path))
    expect(first).toEqual({ bytes: onDisk.size, modifiedAt: onDisk.mtimeMs })
    const preview = await invokeCoreOperation(api, 'files.preview', [input])
    expect(preview).toMatchObject({
      bytes: first.bytes,
      modifiedAt: first.modifiedAt,
    })

    writeFileSync(join(root, path), '# Second, longer\n')
    const later = new Date(onDisk.mtimeMs + 5_000)
    utimesSync(join(root, path), later, later)
    const second = await invokeCoreOperation(api, 'files.stat', [input])
    expect(second.bytes).toBe(Buffer.byteLength('# Second, longer\n'))
    expect(second.modifiedAt).toBe(statSync(join(root, path)).mtimeMs)
    expect(second.modifiedAt).not.toBe(first.modifiedAt)
  })

  it('stats a reference the session may preview, and nothing else', async () => {
    const { api, sessionId, root, path } = await setup()
    const reference = api.references.resolve({
      sessionId,
      sourceMessageId: 'm1',
      href: `${path}#L1`,
      label: 'notes',
    })
    const input = {
      source: 'reference' as const,
      sessionId,
      referenceId: reference.id,
    }
    expect(await invokeCoreOperation(api, 'files.stat', [input])).toEqual({
      bytes: statSync(join(root, path)).size,
      modifiedAt: statSync(join(root, path)).mtimeMs,
    })
    // Another session cannot use this reference.
    const other = String(api.sessions.create({ title: 'Other' }).id)
    await expect(
      invokeCoreOperation(api, 'files.stat', [{ ...input, sessionId: other }]),
    ).rejects.toThrow()
    // A file outside the session root is only revealable, never read.
    const external = join(root, '..', 'external.txt')
    writeFileSync(external, 'external content')
    const outside = api.references.resolve({
      sessionId,
      sourceMessageId: 'm1',
      href: external,
      label: 'external',
    })
    await expect(
      invokeCoreOperation(api, 'files.stat', [
        { source: 'reference', sessionId, referenceId: outside.id },
      ]),
    ).rejects.toThrow(/无法预览/)
  })

  it('refuses paths outside the project, directories and the immutable sources', async () => {
    const { api, sessionId } = await setup()
    await expect(
      invokeCoreOperation(api, 'files.stat', [
        { source: 'project', sessionId, path: '../outside.txt' },
      ]),
    ).rejects.toThrow()
    await expect(
      invokeCoreOperation(api, 'files.stat', [
        { source: 'project', sessionId, path: 'src' },
      ]),
    ).rejects.toThrow(/不是文件/)
    await expect(
      invokeCoreOperation(api, 'files.stat', [
        { source: 'project', sessionId, path: 'src/missing.md' },
      ]),
    ).rejects.toThrow(/不存在/)
    // Turn snapshots and attachments never change: no stat for them.
    await expect(
      invokeCoreOperation(api, 'files.stat', [
        {
          source: 'turn',
          sessionId,
          path: 'src/中文 notes.md',
          turn: 1,
        } as never,
      ]),
    ).rejects.toThrow()
    await expect(
      invokeCoreOperation(api, 'files.stat', [
        { source: 'attachment', attachmentId: 'att_2026-10_12345678' } as never,
      ]),
    ).rejects.toThrow()
  })
})
