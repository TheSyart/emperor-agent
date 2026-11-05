// GRP-02: the contacts operations on the Core registry, the host checks
// behind them (registered tools, the global permission preset) and the
// `contacts_changed` host event (card test 12).
import { afterEach, describe, expect, it } from 'vitest'
import { RUNTIME_EVENT_NAMES } from '../harness/projection/wire-names'
import {
  CoreOperationArgumentsError,
  coreOperationKeys,
  invokeCoreOperation,
} from './operations'
import { makeApi, type ApiFixture } from './test-helpers'

const VIEW = { sessionId: null }
const CONTACT_OPERATIONS = [
  'contacts.capabilities.resolve',
  'contacts.chatDelegation',
  'contacts.chatSend',
  'contacts.create',
  'contacts.delete',
  'contacts.draftFromBrief',
  'contacts.duplicate',
  'contacts.experiences.list',
  'contacts.experiences.remove',
  'contacts.experiences.restore',
  'contacts.experiences.setStatus',
  'contacts.experiences.update',
  'contacts.feedback',
  'contacts.fromTemplate',
  'contacts.get',
  'contacts.importAgentFile',
  'contacts.list',
  'contacts.memory.delete',
  'contacts.memory.list',
  'contacts.memory.update',
  'contacts.openChat',
  'contacts.preview',
  'contacts.recommendAvatar',
  'contacts.restoreVersion',
  'contacts.stats',
  'contacts.stopTrial',
  'contacts.templates',
  'contacts.trial',
  'contacts.update',
  'contacts.versions',
]

const fixtures: ApiFixture[] = []

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.api.close()
})

async function api() {
  const fixture = await makeApi()
  fixtures.push(fixture)
  return fixture
}

function contactEvents(events: Array<Record<string, unknown>>) {
  return events
    .filter((event) => event.event === 'contacts_changed')
    .map(({ reason, contact_id, version }) => ({ reason, contact_id, version }))
}

describe('contacts operations', () => {
  it('registers the contacts operations and the contacts_changed event', () => {
    expect(
      coreOperationKeys().filter((key) => key.startsWith('contacts.')),
    ).toEqual(CONTACT_OPERATIONS)
    expect(RUNTIME_EVENT_NAMES).toContain('contacts_changed')
  })

  it('lists, edits, disables, removes and restores an experience', async () => {
    const fixture = await api()
    const core = fixture.api
    const person = await invokeCoreOperation(core, 'contacts.create', [
      { name: '审稿人' },
    ])
    const { ContactExperienceStore } = await import('../contacts/experiences')
    const store = new ContactExperienceStore({
      stateRoot: fixture.stateRoot,
    })
    const [entry] = await store.add(
      person.id,
      [
        {
          text: '先跑测试',
          status: 'active',
          evidence: [{ kind: 'tool_result', ref: 'c1' }],
        },
      ],
      {
        sessionId: 's1',
        turnId: 't1',
        messageIds: ['m1'],
        roleVersion: person.version,
      },
    )
    const listing = await invokeCoreOperation(
      core,
      'contacts.experiences.list',
      [{ id: person.id }],
    )
    expect(listing.experiences[0]!.text).toBe('先跑测试')
    await invokeCoreOperation(core, 'contacts.experiences.setStatus', [
      { id: person.id, experienceId: entry!.id, status: 'disabled' },
    ])
    await invokeCoreOperation(core, 'contacts.experiences.remove', [
      { id: person.id, experienceId: entry!.id },
    ])
    const afterRemove = await invokeCoreOperation(
      core,
      'contacts.experiences.list',
      [{ id: person.id }],
    )
    expect(afterRemove.experiences[0]!.status).toBe('deleted')
    await invokeCoreOperation(core, 'contacts.experiences.restore', [
      { id: person.id, experienceId: entry!.id },
    ])
    const restored = await invokeCoreOperation(
      core,
      'contacts.experiences.list',
      [{ id: person.id }],
    )
    expect(restored.experiences[0]!.status).toBe('candidate')
  })

  it('runs a contact through its life and announces each change', async () => {
    const { api: core, events } = await api()
    const listed = await invokeCoreOperation(core, 'contacts.list', [])
    expect(listed.contacts.map((contact) => contact.id)).toEqual([
      'ct-emperor',
      'ct-claude-code',
      'ct-codex',
      'ct-role-creator',
    ])
    expect(listed.readOnly).toBeNull()
    expect(
      await invokeCoreOperation(core, 'contacts.templates', []),
    ).toHaveLength(18)

    const created = await invokeCoreOperation(core, 'contacts.fromTemplate', [
      { templateId: 'code-reviewer' },
    ])
    expect(created.name).toBe('代码审稿人')
    const updated = await invokeCoreOperation(core, 'contacts.update', [
      { id: created.id, patch: { role: { mission: '只看正确性' } } },
    ])
    expect(updated.version).toBe(2)
    expect(
      await invokeCoreOperation(core, 'contacts.get', [{ id: created.id }]),
    ).toEqual(updated)
    const versions = await invokeCoreOperation(core, 'contacts.versions', [
      { id: created.id },
    ])
    expect(versions.map((entry) => entry.version)).toEqual([1])
    const restored = await invokeCoreOperation(
      core,
      'contacts.restoreVersion',
      [{ id: created.id, version: 1 }],
    )
    expect(restored.version).toBe(3)
    const copy = await invokeCoreOperation(core, 'contacts.duplicate', [
      { id: created.id },
    ])
    expect(copy.name).toBe('代码审稿人 副本')
    await invokeCoreOperation(core, 'contacts.delete', [{ id: copy.id }])
    const own = await invokeCoreOperation(core, 'contacts.create', [
      { name: '审稿人', intro: '只看正确性' },
    ])

    expect(contactEvents(events)).toEqual([
      { reason: 'created', contact_id: created.id, version: 1 },
      { reason: 'updated', contact_id: created.id, version: 2 },
      { reason: 'restored', contact_id: created.id, version: 3 },
      { reason: 'created', contact_id: copy.id, version: 1 },
      { reason: 'deleted', contact_id: copy.id, version: null },
      { reason: 'created', contact_id: own.id, version: 1 },
    ])
  })

  it('rejects malformed arguments at the boundary', async () => {
    const { api: core } = await api()
    for (const [key, args] of [
      ['contacts.get', [{ id: '../etc/passwd' }]],
      ['contacts.create', [{ name: 'x', secret: true }]],
      ['contacts.update', [{ id: 'ct-emperor', patch: { builtin: false } }]],
      ['contacts.restoreVersion', [{ id: 'ct-emperor', version: 0 }]],
      ['contacts.fromTemplate', [{ templateId: '../../etc' }]],
    ] as const)
      await expect(
        invokeCoreOperation(core, key, args as never),
      ).rejects.toBeInstanceOf(CoreOperationArgumentsError)
  })

  it('checks tools against the host registry and permission against 新会话的权限', async () => {
    const { api: core } = await api()
    const reader = await core.contacts.create({
      name: '读者',
      capabilities: { tools: { preset: 'custom', allow: ['read', 'grep'] } },
    })
    expect(reader.capabilities.tools.allow).toEqual(['read', 'grep'])
    await expect(
      core.contacts.create({
        name: '幻想家',
        capabilities: { tools: { preset: 'custom', allow: ['teleport'] } },
      }),
    ).rejects.toMatchObject({ code: 'contact_invalid' })

    await core.sessions.setDefaults({ permission: 'read-only' }, VIEW)
    await expect(
      core.contacts.create({
        name: '写手',
        capabilities: { permission: 'workspace_write' },
      }),
    ).rejects.toMatchObject({
      code: 'contact_invalid',
      field: 'capabilities.permission',
    })
  })
})
