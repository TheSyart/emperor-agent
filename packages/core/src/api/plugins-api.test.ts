import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { invokeCoreOperation } from './operations'
import { makeApi, tmp, type ApiFixture } from './test-helpers'
import {
  portablePackage,
  skillMarkdown,
  writePackage,
} from '../plugins/testing'

let fixture: ApiFixture | null = null

afterEach(async () => {
  await fixture?.api.close()
  fixture = null
})

async function installKit(api: ApiFixture['api']) {
  const source = writePackage(
    join(tmp('emperor-plugin-api-'), 'hello-kit'),
    portablePackage('hello-kit', {
      'skills/hello/SKILL.md': skillMarkdown('hello', 'Say hello'),
      'skills/wave/SKILL.md': skillMarkdown('wave', 'Wave'),
    }),
  )
  const preview = await api.plugins.inspect({ kind: 'local', path: source })
  return api.plugins.install({
    previewId: preview.previewId,
    digest: preview.digest,
    scope: 'user',
  })
}

describe('plugins through CoreApi', () => {
  it('serves the detail, feeds the Skill catalog and announces changes', async () => {
    fixture = await makeApi()
    const { api, events } = fixture
    await installKit(api)

    expect(events).toContainEqual(
      expect.objectContaining({ event: 'plugins_changed', reason: 'plugins' }),
    )
    const names = () => api.skills.list().skills.map((skill) => skill.name)
    expect(names()).toEqual(expect.arrayContaining(['hello', 'wave']))
    const detail = await invokeCoreOperation(api, 'plugins.getDetail', [
      { pluginId: 'hello-kit', scope: 'user' },
    ])
    expect(detail).toMatchObject({
      pluginId: 'hello-kit',
      format: 'portable',
      activation: 'active',
      components: [
        { kind: 'skill', id: 'hello', state: 'available' },
        { kind: 'skill', id: 'wave', state: 'available' },
      ],
    })

    events.length = 0
    api.plugins.setEnabled({
      pluginId: 'hello-kit',
      scope: 'user',
      enabled: false,
    })
    expect(events).toContainEqual(
      expect.objectContaining({ event: 'plugins_changed', reason: 'plugins' }),
    )
    expect(names()).not.toContain('hello')
  })

  it('marks a plugin Skill that a personal Skill of the same name overrides', async () => {
    fixture = await makeApi()
    const { api, stateRoot } = fixture
    mkdirSync(join(stateRoot, 'skills', 'hello'), { recursive: true })
    writeFileSync(
      join(stateRoot, 'skills', 'hello', 'SKILL.md'),
      skillMarkdown('hello', 'Mine'),
    )
    await installKit(api)
    expect(
      api.plugins
        .getDetail({ pluginId: 'hello-kit', scope: 'user' })
        .components.map(({ id, state, reason }) => [id, state, reason]),
    ).toEqual([
      ['hello', 'failed', '与个人的同名 Skill 冲突，未生效'],
      ['wave', 'available', null],
    ])
  })

  it('rejects an unknown plugin with a stable code', async () => {
    fixture = await makeApi()
    expect(() =>
      fixture!.api.plugins.getDetail({ pluginId: 'nobody', scope: 'user' }),
    ).toThrow(expect.objectContaining({ code: 'plugin_not_found' }))
  })
})
