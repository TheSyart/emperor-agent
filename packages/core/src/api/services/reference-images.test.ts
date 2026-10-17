import { expect, it, vi } from 'vitest'
import { mkdirSync, writeFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { makeApi } from '../test-helpers'
import { invokeCoreOperation } from '../operations'
import { fixtureDelegationRecord } from '../../harness/delegation/testing'
it('previews ordinary chat workspace images and keeps file links revealable without a Build project', async () => {
  const f = await makeApi()
  try {
    const sessionId = String(
      f.api.sessions.create({ title: 'chat image', mode: 'chat' }).id,
    )
    const cwd = f.api.host.sessionWorkspaceRoot(sessionId)
    mkdirSync(cwd, { recursive: true })
    const bytes = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j98sAAAAASUVORK5CYII=',
      'base64',
    )
    writeFileSync(join(cwd, 'sun.png'), bytes)
    for (const href of ['sun.png', join(cwd, 'sun.png')]) {
      const reference = f.api.references.resolve({
        sessionId,
        sourceMessageId: 'chat',
        href,
        label: 'sun',
      })
      expect(reference).toMatchObject({
        kind: 'external_file',
        available: true,
        actions: ['reveal'],
      })
      expect(
        (await f.api.references.image({ sessionId, referenceId: reference.id }))
          .dataBase64,
      ).toBe(bytes.toString('base64'))
      expect(
        f.api.references.revealPath({ sessionId, referenceId: reference.id }),
      ).toBe(realpathSync(join(cwd, 'sun.png')))
    }
  } finally {
    await f.api.close()
  }
})
it('previews only session-owned project or delegated raster images using reference capabilities', async () => {
  const f = await makeApi()
  try {
    const project = join(f.root, 'image-project'),
      outside = join(f.root, 'image-external')
    mkdirSync(project)
    mkdirSync(outside)
    const bytes = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j98sAAAAASUVORK5CYII=',
      'base64',
    )
    writeFileSync(join(project, 'sun.png'), bytes)
    writeFileSync(join(outside, 'result.png'), bytes)
    const session = String(
      f.api.sessions.create({
        title: 'images',
        mode: 'build',
        project_path: project,
      }).id,
    )
    const resolve = (href: string) =>
      f.api.references.resolve({
        sessionId: session,
        sourceMessageId: 'image-reply',
        href,
        label: 'image',
      })
    const local = resolve(join(project, 'sun.png')),
      external = resolve(join(outside, 'result.png'))
    expect(
      (
        await invokeCoreOperation(f.api, 'references.image', [
          { sessionId: session, referenceId: local.id },
        ])
      ).dataBase64,
    ).toBe(bytes.toString('base64'))
    await expect(
      invokeCoreOperation(f.api, 'references.image', [
        { sessionId: session, referenceId: external.id },
      ]),
    ).rejects.toThrow()
    const record = {
      ...fixtureDelegationRecord(),
      cwd: realpathSync(outside),
      owner: { ...fixtureDelegationRecord().owner, rootSessionId: session },
    }
    vi.spyOn(f.api.delegationRuntime, 'list').mockReturnValue([
      {
        record: { ...record, cwd: join(outside, 'removed-worktree') },
        runs: {},
        messages: {},
        interactions: {},
        outbox: {},
        lastSeq: 0,
      },
      {
        record,
        runs: {},
        messages: {},
        interactions: {},
        outbox: {},
        lastSeq: 0,
      },
    ])
    expect(
      (
        await invokeCoreOperation(f.api, 'references.image', [
          { sessionId: session, referenceId: external.id },
        ])
      ).dataBase64,
    ).toBe(bytes.toString('base64'))
    const other = String(f.api.sessions.create({ title: 'foreign' }).id)
    await expect(
      invokeCoreOperation(f.api, 'references.image', [
        { sessionId: other, referenceId: external.id },
      ]),
    ).rejects.toThrow()
    await expect(
      invokeCoreOperation(f.api, 'references.image', [
        { sessionId: session, referenceId: local.id, path: '/etc/passwd' },
      ]),
    ).rejects.toThrow()
  } finally {
    await f.api.close()
  }
})
