import { expect, it } from 'vitest'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { makeApi } from '../test-helpers'
import { invokeCoreOperation } from '../operations'
it('lists disabled executor defaults and revision-fences configuration without credential fields', async () => {
  const { api } = await makeApi()
  try {
    const initial = api.executors.list()
    expect(initial.config?.profiles).toHaveLength(2)
    const updated = await api.executors.configure({
      expectedRevision: 0,
      config: initial.config!,
    })
    expect(updated.revision).toBe(1)
    await expect(
      api.executors.configure({ expectedRevision: 0, config: initial.config! }),
    ).rejects.toThrow('STALE_REVISION')
    await expect(
      invokeCoreOperation(api, 'executors.configure', [
        { expectedRevision: 1, config: updated, env: { KEY: 'secret' } },
      ]),
    ).rejects.toThrow()
    await expect(
      invokeCoreOperation(api, 'delegations.send', [
        {
          id: 'dlg-x',
          text: 'x',
          messageId: 'dgm-x',
          delivery: 'queue',
          owner: 'another',
        },
      ]),
    ).rejects.toThrow()
  } finally {
    await api.close()
  }
})
it('keeps invalid optional executor config intact and the ordinary chat API usable', async () => {
  const f = await makeApi()
  const path = f.api.executorConfig.file
  mkdirSync(f.api.paths.delegationsRoot, { recursive: true })
  writeFileSync(path, '{"schemaVersion":999}')
  await f.api.close()
  const next = await makeApi({
    root: f.root,
    stateRoot: f.stateRoot,
    replies: [{ text: 'normal chat works' }],
  })
  try {
    expect(next.api.executors.list()).toMatchObject({
      config: null,
      diagnostic: expect.stringContaining('EXECUTOR_CONFIG_INVALID'),
    })
    const session = next.api.sessions.create({ title: 'still usable' })
    expect(
      (
        await next.api.chat.submit({
          content: 'hello',
          sessionId: String(session.id),
        })
      ).content,
    ).toBe('normal chat works')
    expect(readFileSync(path, 'utf8')).toBe('{"schemaVersion":999}')
  } finally {
    await next.api.close()
  }
})
