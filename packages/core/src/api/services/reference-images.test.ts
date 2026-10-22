import { expect, it, vi } from 'vitest'
import { mkdirSync, writeFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { makeApi } from '../test-helpers'
import { invokeCoreOperation } from '../operations'
import { fixtureDelegationRecord } from '../../harness/delegation/testing'
it('previews ordinary chat workspace images and keeps file links previewable and revealable without a Build project', async () => {
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
      // Chat workspace files open in Files (preview) and stay revealable.
      expect(reference).toMatchObject({
        kind: 'project_file',
        available: true,
        actions: ['open_files', 'preview', 'reveal'],
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
it('resolves delegation relative images with root ownership and rejects escaped symlinks', async () => {
  const f = await makeApi()
  try {
    const sessionId = String(
      f.api.sessions.create({ title: 'child images', mode: 'chat' }).id,
    )
    const cwd = join(f.root, 'child-images')
    mkdirSync(cwd)
    const bytes = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j98sAAAAASUVORK5CYII=',
      'base64',
    )
    writeFileSync(join(cwd, 'sun.png'), bytes)
    const record = {
      ...fixtureDelegationRecord(),
      cwd,
      owner: { ...fixtureDelegationRecord().owner, rootSessionId: sessionId },
    }
    const state = {
      record,
      runs: {},
      messages: {},
      interactions: {},
      outbox: {},
      lastSeq: 0,
    }
    vi.spyOn(f.api.delegationRuntime, 'inspect').mockReturnValue(state)
    vi.spyOn(f.api.delegationRuntime, 'list').mockReturnValue([state])
    const reference = await invokeCoreOperation(f.api, 'references.resolve', [
      {
        sessionId,
        delegationId: record.id,
        sourceMessageId: 'child',
        href: 'sun.png',
        label: 'sun',
      },
    ])
    expect(reference.available).toBe(true)
    expect(
      (await f.api.references.image({ sessionId, referenceId: reference.id }))
        .dataBase64,
    ).toBe(bytes.toString('base64'))
    writeFileSync(join(cwd, 'large.png'), Buffer.alloc(8 * 1024 * 1024 + 1))
    const large = await invokeCoreOperation(f.api, 'references.resolve', [
      {
        sessionId,
        delegationId: record.id,
        sourceMessageId: 'child-large',
        href: 'large.png',
        label: 'large',
      },
    ])
    expect(
      await f.api.references.image({ sessionId, referenceId: large.id }),
    ).toMatchObject({ kind: 'image', truncated: true })
    const other = String(f.api.sessions.create({ title: 'other' }).id)
    await expect(
      invokeCoreOperation(f.api, 'references.resolve', [
        {
          sessionId: other,
          delegationId: record.id,
          sourceMessageId: 'child',
          href: 'sun.png',
          label: 'sun',
        },
      ]),
    ).rejects.toThrow()
    const { symlinkSync } = await import('node:fs')
    symlinkSync(join(f.root, 'outside.png'), join(cwd, 'escape.png'))
    writeFileSync(join(f.root, 'outside.png'), bytes)
    await expect(
      invokeCoreOperation(f.api, 'references.resolve', [
        {
          sessionId,
          delegationId: record.id,
          sourceMessageId: 'child',
          href: 'escape.png',
          label: 'escape',
        },
      ]),
    ).rejects.toThrow()
  } finally {
    await f.api.close()
  }
})

it('previews native Codex generated images only for the owning root and child', async () => {
  const f = await makeApi()
  try {
    const sessionId = String(
      f.api.sessions.create({ title: 'native image', mode: 'chat' }).id,
    )
    const record = {
      ...fixtureDelegationRecord(),
      cwd: join(f.root, 'project'),
      owner: { ...fixtureDelegationRecord().owner, rootSessionId: sessionId },
    }
    mkdirSync(record.cwd)
    const base = join(
        f.api.paths.delegationsRoot,
        'runtime',
        'codex-default',
        record.id,
        'codex',
      ),
      generated = join(base, 'generated_images')
    mkdirSync(generated, { recursive: true })
    const bytes = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j98sAAAAASUVORK5CYII=',
      'base64',
    )
    const file = join(generated, 'native.png')
    writeFileSync(file, bytes)
    writeFileSync(join(base, 'private.png'), bytes)
    const state = {
      record,
      runs: {},
      messages: {},
      interactions: {},
      outbox: {},
      lastSeq: 0,
    }
    vi.spyOn(f.api.delegationRuntime, 'inspect').mockReturnValue(state)
    vi.spyOn(f.api.delegationRuntime, 'list').mockReturnValue([state])
    for (const delegationId of [undefined, record.id]) {
      const r = f.api.references.resolve({
        sessionId,
        delegationId,
        sourceMessageId: 'native',
        href: file,
        label: 'native',
      })
      expect(
        (await f.api.references.image({ sessionId, referenceId: r.id }))
          .dataBase64,
      ).toBe(bytes.toString('base64'))
    }
    expect(() =>
      f.api.references.resolve({
        sessionId,
        delegationId: record.id,
        sourceMessageId: 'private',
        href: join(base, 'private.png'),
        label: 'private',
      }),
    ).toThrow()
    const other = String(f.api.sessions.create({ title: 'other' }).id),
      r = f.api.references.resolve({
        sessionId: other,
        sourceMessageId: 'cross',
        href: file,
        label: 'cross',
      })
    await expect(
      f.api.references.image({ sessionId: other, referenceId: r.id }),
    ).rejects.toThrow()
    const { symlinkSync } = await import('node:fs')
    symlinkSync(join(base, 'private.png'), join(generated, 'escape.png'))
    expect(() =>
      f.api.references.resolve({
        sessionId,
        delegationId: record.id,
        sourceMessageId: 'escape',
        href: join(generated, 'escape.png'),
        label: 'escape',
      }),
    ).toThrow()
  } finally {
    await f.api.close()
  }
})
