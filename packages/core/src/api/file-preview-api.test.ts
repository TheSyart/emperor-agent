import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CoreApi } from './core-api'
import { invokeCoreOperation } from './operations'
import { makeApi } from './test-helpers'

const apis: CoreApi[] = []
afterEach(async () => {
  for (const api of apis.splice(0)) await api.close()
})
async function setup() {
  const { api } = await makeApi({ replies: [{ text: 'ready' }] })
  apis.push(api)
  const sessionId = String(api.sessions.create({ title: 'Previews' }).id)
  await api.chat.submit({ sessionId, content: 'initialize' })
  const root = api.host.sessionWorkspaceRoot(sessionId)
  mkdirSync(root, { recursive: true })
  const path = '中文 with spaces.md'
  writeFileSync(join(root, path), '# Current content\n')
  api.host.sessionLog(sessionId)!.append('turn/files', {
    turn: 1,
    mode: 'tools',
    status: 'recorded',
    files: [{ path, status: 'added', additions: 1, deletions: 0 }],
    totals: { files: 1, additions: 1, deletions: 0 },
  })
  return { api, sessionId, root, path }
}
describe('unified file previews', () => {
  it('previews recorded Chat files, re-reads current content, and never changes logs', async () => {
    const { api, sessionId, root, path } = await setup()
    const input = { source: 'turn' as const, sessionId, path, turn: 1 }
    const events = api.host.sessionLog(sessionId)!.events.slice()
    const first = await invokeCoreOperation(api, 'files.preview', [input])
    expect(first).toMatchObject({
      name: path,
      kind: 'text',
      content: '# Current content\n',
    })
    writeFileSync(join(root, path), 'updated')
    expect(
      await invokeCoreOperation(api, 'files.preview', [input]),
    ).toMatchObject({ content: 'updated', id: first.id })
    expect(api.host.sessionLog(sessionId)!.events).toEqual(events)
    await expect(
      invokeCoreOperation(api, 'files.preview', [
        { ...input, path: '../outside.txt' },
      ]),
    ).rejects.toThrow()
    await expect(
      invokeCoreOperation(api, 'files.preview', [{ ...input, turn: 2 }]),
    ).rejects.toThrow()
  })
  it('reads project file references but never reads a file outside the session root', async () => {
    const { api, sessionId, root, path } = await setup()
    const reference = api.references.resolve({
      sessionId,
      sourceMessageId: 'm1',
      href: path,
      label: path,
    })
    expect(
      await invokeCoreOperation(api, 'files.preview', [
        { source: 'reference', sessionId, referenceId: reference.id },
      ]),
    ).toMatchObject({ content: '# Current content\n' })
    const external = join(root, '..', 'external.txt')
    writeFileSync(external, 'external content')
    const ref = api.references.resolve({
      sessionId,
      sourceMessageId: 'm1',
      href: external,
      label: 'external',
    })
    expect(ref.actions).toEqual(['reveal'])
    const input = {
      source: 'reference' as const,
      sessionId,
      referenceId: ref.id,
    }
    await expect(
      invokeCoreOperation(api, 'files.preview', [input]),
    ).rejects.toThrow(/无法预览/)
    const other = String(api.sessions.create({ title: 'Other' }).id)
    await expect(
      invokeCoreOperation(api, 'files.preview', [
        { ...input, sessionId: other },
      ]),
    ).rejects.toThrow()
  })
  it('previews unsent managed attachments without creating a session and reports removal', async () => {
    const { api } = await makeApi()
    apis.push(api)
    const attachment = api.attachments.save({
      raw: Buffer.from('draft body'),
      name: '草稿.txt',
      mime: 'text/plain',
    })
    const before = api.sessions.list()
    const input = { source: 'attachment' as const, attachmentId: attachment.id }
    expect(
      await invokeCoreOperation(api, 'files.preview', [input]),
    ).toMatchObject({ name: '草稿.txt', content: 'draft body' })
    expect(api.sessions.list()).toEqual(before)
    rmSync(join(api.attachmentStore.root, attachment.rel_path))
    await expect(
      invokeCoreOperation(api, 'files.preview', [input]),
    ).rejects.toThrow()
  })
  it('bounds text and raster data, preserves unsupported files as metadata', async () => {
    const { api } = await makeApi()
    apis.push(api)
    for (const [name, mime, raw, expected] of [
      [
        'large.txt',
        'text/plain',
        Buffer.alloc(1024 * 1024 + 10, 65),
        { kind: 'text', truncated: true },
      ],
      [
        'large.png',
        'image/png',
        Buffer.alloc(8 * 1024 * 1024 + 1),
        { kind: 'image', truncated: true },
      ],
      [
        'document.pdf',
        'application/pdf',
        Buffer.from('%PDF-1.4\nmetadata only'),
        { kind: 'binary' },
      ],
    ] as const) {
      const ref = api.attachments.save({ name, mime, raw })
      const result = await invokeCoreOperation(api, 'files.preview', [
        { source: 'attachment', attachmentId: ref.id },
      ])
      expect(result).toMatchObject(expected)
      expect(result.content?.length ?? 0).toBeLessThanOrEqual(1024 * 1024)
      if (name === 'large.png') expect(result.dataBase64).toBeUndefined()
    }
  })
})
