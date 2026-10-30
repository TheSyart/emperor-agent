// GRP-02: the contacts store — builtins, validation, versions, read-only
// mode on a corrupt file, and the change notifications (card tests 1–9, 12).
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ContactStore, type ContactStoreOptions } from './store'
import { BUILTIN_CONTACT_IDS, type ContactsChange } from './types'

const TEMPLATES_DIR = join(__dirname, '..', '..', '..', '..', 'templates')
const PERSONA = readFileSync(
  join(TEMPLATES_DIR, 'agent', 'persona.md'),
  'utf8',
).trim()

/** A registry's worth of builtin tool names. */
const TOOL_NAMES = [
  'bash',
  'edit',
  'glob',
  'grep',
  'read',
  'skill',
  'todo_write',
  'web_fetch',
  'web_search',
  'write',
]

function setup(
  options: Partial<ContactStoreOptions> & { stateRoot?: string } = {},
) {
  const stateRoot =
    options.stateRoot ?? mkdtempSync(join(tmpdir(), 'emperor-contacts-'))
  let clock = 1_800_000_000_000
  const changes: ContactsChange[] = []
  const make = (extra: Partial<ContactStoreOptions> = {}) =>
    new ContactStore({
      stateRoot,
      templatesDir: TEMPLATES_DIR,
      toolNames: () => TOOL_NAMES,
      globalPermission: () => 'workspace-write',
      now: () => (clock += 1000),
      onChange: (change) => changes.push(change),
      ...options,
      ...extra,
    })
  return { store: make(), make, stateRoot, changes }
}

function contactsFile(stateRoot: string) {
  return join(stateRoot, 'contacts', 'contacts.json')
}

describe('builtin contacts (card test 1)', () => {
  it('creates Emperor, Claude Code and Codex on first start', async () => {
    const { store, make, stateRoot } = setup()
    const listing = await store.list()

    expect(listing.readOnly).toBeNull()
    expect(listing.contacts.map((contact) => contact.id)).toEqual([
      ...BUILTIN_CONTACT_IDS,
    ])
    expect(listing.contacts.filter((contact) => contact.builtin)).toHaveLength(
      3,
    )
    const file = JSON.parse(readFileSync(contactsFile(stateRoot), 'utf8'))
    expect(file.schemaVersion).toBe(3)
    expect(file.contacts.map((contact: { id: string }) => contact.id)).toEqual([
      ...BUILTIN_CONTACT_IDS,
    ])

    const [emperor, claude, codex] = listing.contacts
    expect(emperor).toMatchObject({
      kind: 'local',
      name: 'Emperor',
      builtin: true,
      avatar: { kind: 'mascot', pose: 'crown-head' },
      version: 1,
    })
    // Emperor's role card is today's persona.
    expect(emperor!.role.mission).toBe(PERSONA)
    for (const [contact, backend] of [
      [claude, 'claude-code'],
      [codex, 'codex'],
    ] as const) {
      expect(contact).toMatchObject({
        kind: 'external',
        backend,
        builtin: true,
        avatar: { kind: 'logo', backend },
        // Model and permission follow 子智能体 settings: not stored here.
        capabilities: { model: 'inherit', permission: 'inherit' },
      })
    }

    // A second store over the same home reads the same three.
    expect((await make().list()).contacts).toEqual(listing.contacts)
  })
})

describe('creating from a template (card test 2)', () => {
  it('reads back every field of a template-made contact', async () => {
    const { store, make } = setup()
    const created = await store.fromTemplate({ templateId: 'security-auditor' })

    expect(created.id).toMatch(/^ct-[a-z2-7]{12}$/)
    expect(created).toMatchObject({
      kind: 'local',
      name: '安全审计',
      builtin: false,
      templateId: 'security-auditor',
      version: 1,
      avatar: { kind: 'library', id: 'AV-01-4' },
      domains: ['security', 'engineering'],
      capabilities: {
        model: 'inherit',
        tools: { preset: 'read_only' },
        permission: 'read_only',
      },
      groupHabit: { speak: 'relevant', length: 'brief' },
      memory: { enabled: true },
    })
    expect(created.backend).toBeUndefined()
    expect(created.intro.length).toBeGreaterThan(0)
    expect(created.role.mission).toContain('注入')
    expect(created.role.deliverable).toContain('严重')
    expect(created.role.playbook).toMatch(/^1\. /m)
    expect(created.role.boundaries.length).toBeGreaterThan(0)
    expect(created.role.trialTask?.length).toBeGreaterThan(0)
    expect(created.knowledge).toEqual([])
    expect(created.skills).toEqual([])
    expect(created.mcp).toEqual([])
    expect(created.createdAt).toBe(created.updatedAt)

    expect(await make().get(created.id)).toEqual(created)
  })

  it('puts a role on an external member (D16) and numbers a taken name', async () => {
    const { store } = setup()
    const external = await store.fromTemplate({
      templateId: 'security-auditor',
      backend: 'claude-code',
    })
    expect(external).toMatchObject({
      kind: 'external',
      backend: 'claude-code',
      name: 'Claude Code · 安全审计',
      avatar: { kind: 'logo', backend: 'claude-code' },
      capabilities: { model: 'inherit', permission: 'inherit' },
      templateId: 'security-auditor',
    })
    // GRP-09: an external member speaks only when @-mentioned by default
    // (its runs are slower and dearer), whatever the template says.
    expect(external.groupHabit.speak).toBe('mentioned')
    const plain = await store.create({
      name: 'Codex 小帮手',
      kind: 'external',
      backend: 'codex',
    })
    expect(plain.groupHabit.speak).toBe('mentioned')

    await store.fromTemplate({ templateId: 'code-reviewer' })
    const second = await store.fromTemplate({ templateId: 'code-reviewer' })
    expect(second.name).toBe('代码审稿人 2')
    await expect(
      store.fromTemplate({ templateId: 'code-reviewer', name: '代码审稿人' }),
    ).rejects.toMatchObject({ code: 'contact_invalid', field: 'name' })
    await expect(
      store.fromTemplate({ templateId: 'no-such-template' }),
    ).rejects.toMatchObject({ code: 'contact_template_not_found' })
  })
})

describe('validation (card test 3)', () => {
  it('rejects an empty, overlong or duplicate name', async () => {
    const { store } = setup()
    for (const name of ['', '   ', 'x'.repeat(25), '名'.repeat(25)])
      await expect(store.create({ name })).rejects.toMatchObject({
        code: 'contact_invalid',
        field: 'name',
      })
    // 24 characters is the limit (Chinese characters count one each).
    const long = await store.create({ name: `  ${'名'.repeat(24)}  ` })
    expect(long.name).toBe('名'.repeat(24))

    await store.create({ name: '审稿人' })
    for (const name of ['审稿人', ' 审稿人 ', 'emperor', 'CLAUDE CODE'])
      await expect(store.create({ name })).rejects.toMatchObject({
        code: 'contact_invalid',
        field: 'name',
      })
    // A name is how members are @-mentioned: no @ and no line breaks.
    for (const name of ['@审稿人', '审\n稿人'])
      await expect(store.create({ name })).rejects.toMatchObject({
        field: 'name',
      })
  })

  it('rejects an intro on two lines or past 60 characters, and overlong sections', async () => {
    const { store } = setup()
    await expect(
      store.create({ name: 'a', intro: '第一行\n第二行' }),
    ).rejects.toMatchObject({ field: 'intro' })
    await expect(
      store.create({ name: 'b', intro: '字'.repeat(61) }),
    ).rejects.toMatchObject({ field: 'intro' })
    await expect(
      store.create({ name: 'c', role: { playbook: 'x'.repeat(4001) } }),
    ).rejects.toMatchObject({ field: 'role.playbook' })
    await expect(
      store.create({ name: 'd', role: { mission: 'x'.repeat(2001) } }),
    ).rejects.toMatchObject({ field: 'role.mission' })
    await expect(
      store.create({
        name: 'e',
        domains: ['security', 'design', 'data', 'content'],
      }),
    ).rejects.toMatchObject({ field: 'domains' })
    await expect(
      store.create({ name: 'f', avatar: { kind: 'library', id: 'AV-16-1' } }),
    ).rejects.toMatchObject({ field: 'avatar' })
    await expect(
      store.create({ name: 'g', avatar: { kind: 'portrait', index: 36 } }),
    ).rejects.toMatchObject({ field: 'avatar' })
    const ok = await store.create({
      name: 'h',
      intro: '字'.repeat(60),
      avatar: { kind: 'library', id: 'AV-15-9' },
      role: { playbook: 'x'.repeat(4000) },
    })
    expect(ok.intro).toHaveLength(60)
  })

  it('takes only existing absolute paths, https addresses and Skill names as knowledge', async () => {
    const { store, stateRoot } = setup()
    const notes = join(stateRoot, 'notes.md')
    writeFileSync(notes, '# notes\n')
    const created = await store.create({
      name: '研究员',
      knowledge: [
        { id: 'kr-notes', kind: 'file', path: notes, use: 'pinned' },
        {
          id: 'kr-folder',
          kind: 'folder',
          path: stateRoot,
          use: 'on_demand',
        },
        {
          id: 'kr-guide',
          kind: 'url',
          url: 'https://example.com/guide',
          use: 'on_demand',
        },
      ],
      skills: [{ id: 'sk-review', sourceId: 'user', name: 'review-checklist' }],
    })
    expect(created.knowledge).toHaveLength(3)
    expect(created.skills).toEqual([
      { id: 'sk-review', sourceId: 'user', name: 'review-checklist' },
    ])
    expect(created.role.knowledge).toBeUndefined()

    for (const knowledge of [
      {
        id: 'kr-bad1',
        kind: 'file' as const,
        path: 'notes.md',
        use: 'on_demand' as const,
      },
      {
        id: 'kr-bad2',
        kind: 'file' as const,
        path: join(stateRoot, 'missing.md'),
        use: 'on_demand' as const,
      },
      {
        id: 'kr-bad3',
        kind: 'file' as const,
        path: stateRoot,
        use: 'on_demand' as const,
      },
      {
        id: 'kr-bad4',
        kind: 'folder' as const,
        path: notes,
        use: 'on_demand' as const,
      },
      {
        id: 'kr-bad5',
        kind: 'url' as const,
        url: 'http://example.com/guide',
        use: 'on_demand' as const,
      },
      {
        id: 'kr-bad6',
        kind: 'url' as const,
        url: 'not a url',
        use: 'on_demand' as const,
      },
    ])
      await expect(
        store.update(created.id, { knowledge: [knowledge] }),
      ).rejects.toMatchObject({
        code: 'contact_invalid',
        field: 'knowledge',
      })
    await expect(
      store.update(created.id, {
        skills: [{ id: 'sk-bad', sourceId: 'user', name: 'Bad Name' }],
      }),
    ).rejects.toMatchObject({ code: 'contact_invalid', field: 'skills' })
  })
})

describe('schema 3 (CP-01)', () => {
  it('upgrades a schema 2 file, keeps a backup and moves role knowledge', async () => {
    const { store, stateRoot } = setup()
    const notes = join(stateRoot, 'notes.md')
    writeFileSync(notes, '# notes\n')
    const created = await store.create({
      name: '研究员',
      role: {
        knowledge: [
          { kind: 'file', path: notes, pinned: true },
          { kind: 'skill', name: 'review-checklist' },
        ],
      },
    })
    const path = contactsFile(stateRoot)
    const file = JSON.parse(readFileSync(path, 'utf8'))
    const legacy = file.contacts.find(
      (contact: { id: string }) => contact.id === created.id,
    )
    delete legacy.knowledge
    delete legacy.skills
    delete legacy.mcp
    legacy.role = {
      ...legacy.role,
      knowledge: [
        { kind: 'file', path: notes, pinned: true },
        { kind: 'skill', name: 'review-checklist' },
      ],
    }
    writeFileSync(
      path,
      JSON.stringify({ schemaVersion: 2, contacts: file.contacts }),
    )

    const fresh = setup({ stateRoot })
    const contact = await fresh.store.get(created.id)
    expect(contact.role.knowledge).toBeUndefined()
    expect(contact.knowledge).toEqual([
      expect.objectContaining({
        kind: 'file',
        path: notes,
        use: 'pinned',
      }),
    ])
    expect(contact.skills).toEqual([
      expect.objectContaining({ name: 'review-checklist', sourceId: 'legacy' }),
    ])
    expect(contact.mcp).toEqual([])

    const upgraded = JSON.parse(readFileSync(path, 'utf8'))
    expect(upgraded.schemaVersion).toBe(3)
    const backups = readdirSync(join(stateRoot, 'contacts')).filter((name) =>
      name.startsWith('contacts.schema2-'),
    )
    expect(backups).toHaveLength(1)

    // Reading again does not back up twice.
    await setup({ stateRoot }).store.list()
    expect(
      readdirSync(join(stateRoot, 'contacts')).filter((name) =>
        name.startsWith('contacts.schema2-'),
      ),
    ).toHaveLength(1)
  })
})

describe('permission and tools (card tests 4, 5)', () => {
  it('refuses a permission above the global preset', async () => {
    const { store } = setup({ globalPermission: () => 'read-only' })
    await expect(
      store.create({
        name: '写手',
        capabilities: { permission: 'workspace_write' },
      }),
    ).rejects.toMatchObject({
      code: 'contact_invalid',
      field: 'capabilities.permission',
    })
    const reader = await store.create({
      name: '读者',
      capabilities: { permission: 'read_only' },
    })
    expect(reader.capabilities.permission).toBe('read_only')
    // A template asking for more than the preset allows starts at read-only.
    const writer = await store.fromTemplate({ templateId: 'writer' })
    expect(writer.capabilities.permission).toBe('read_only')
  })

  it('refuses tool names the registry does not have', async () => {
    const { store } = setup()
    await expect(
      store.create({
        name: 'x',
        capabilities: {
          tools: { preset: 'custom', allow: ['read', 'teleport'] },
        },
      }),
    ).rejects.toMatchObject({
      code: 'contact_invalid',
      field: 'capabilities.tools.allow',
      message: expect.stringContaining('teleport'),
    })
    await expect(
      store.create({
        name: 'y',
        capabilities: { tools: { preset: 'engineer', deny: ['rm_rf'] } },
      }),
    ).rejects.toMatchObject({ field: 'capabilities.tools.deny' })
    await expect(
      store.create({
        name: 'z',
        capabilities: {
          tools: { preset: 'custom', allow: ['read'], deny: ['read'] },
        },
      }),
    ).rejects.toMatchObject({ field: 'capabilities.tools' })
    const custom = await store.create({
      name: 'w',
      capabilities: {
        tools: { preset: 'custom', allow: ['read', 'grep'], deny: ['bash'] },
      },
    })
    expect(custom.capabilities.tools).toEqual({
      preset: 'custom',
      allow: ['read', 'grep'],
      deny: ['bash'],
    })
  })
})

describe('builtins are fixed (card test 6)', () => {
  it('cannot be deleted and change only their avatar and intro', async () => {
    const { store, make } = setup()
    for (const id of BUILTIN_CONTACT_IDS)
      await expect(store.delete(id)).rejects.toMatchObject({
        code: 'contact_builtin',
      })
    await expect(
      store.update('ct-emperor', { name: 'Boss' }),
    ).rejects.toMatchObject({ code: 'contact_builtin' })
    await expect(
      store.update('ct-codex', { role: { mission: '只写测试' } }),
    ).rejects.toMatchObject({ code: 'contact_builtin' })
    await expect(
      store.update('ct-claude-code', {
        capabilities: { permission: 'read_only' },
      }),
    ).rejects.toMatchObject({ code: 'contact_builtin' })

    const emperor = await store.update('ct-emperor', {
      name: 'Emperor', // unchanged fields may come along
      avatar: { kind: 'library', id: 'AV-06-1' },
      intro: '总管，统筹全局',
    })
    expect(emperor).toMatchObject({
      name: 'Emperor',
      intro: '总管，统筹全局',
      avatar: { kind: 'library', id: 'AV-06-1' },
      builtin: true,
    })
    const reread = await make().get('ct-emperor')
    expect(reread.intro).toBe('总管，统筹全局')
    // The persona stays the shipped one, never a stored copy.
    expect(reread.role.mission).toBe(PERSONA)
    expect((await make().list()).contacts.map((c) => c.id)).toEqual([
      ...BUILTIN_CONTACT_IDS,
    ])
  })
})

describe('versions (card tests 7, 8)', () => {
  it('bumps the version on every change, keeps the old one on disk, at most 20', async () => {
    const { store, stateRoot } = setup()
    const created = await store.create({
      name: '审稿人',
      role: { mission: 'v1' },
    })
    expect(created.version).toBe(1)
    const versionsDir = join(stateRoot, 'contacts', created.id, 'versions')

    const second = await store.update(created.id, { role: { mission: 'v2' } })
    expect(second.version).toBe(2)
    expect(second.role.deliverable).toBe('') // a partial role keeps the rest
    const saved = JSON.parse(readFileSync(join(versionsDir, '1.json'), 'utf8'))
    expect(saved).toMatchObject({
      version: 1,
      contact: { id: created.id, version: 1, role: { mission: 'v1' } },
    })

    // The avatar is not part of the role: no new version.
    const avatar = await store.update(created.id, {
      avatar: { kind: 'portrait', index: 3 },
    })
    expect(avatar.version).toBe(2)
    // Nothing changed: no new version either.
    expect(
      (await store.update(created.id, { role: { mission: 'v2' } })).version,
    ).toBe(2)

    for (let index = 3; index <= 27; index += 1)
      await store.update(created.id, { role: { mission: `v${index}` } })
    const files = readdirSync(versionsDir).sort(
      (left, right) => parseInt(left, 10) - parseInt(right, 10),
    )
    expect(files).toHaveLength(20)
    expect(files[0]).toBe('7.json')
    expect(files.at(-1)).toBe('26.json')

    const versions = await store.versions(created.id)
    expect(versions.map((entry) => entry.version)).toEqual(
      Array.from({ length: 20 }, (_, index) => 26 - index),
    )
    expect(versions[0]!.contact.role.mission).toBe('v26')
    expect((await store.get(created.id)).version).toBe(27)
  })

  it('restores an old version as a new version, leaving history alone', async () => {
    const { store, changes } = setup()
    const created = await store.create({
      name: '写作者',
      role: { mission: 'first' },
    })
    await store.update(created.id, { role: { mission: 'second' } })
    await store.update(created.id, { role: { mission: 'third' } })

    const restored = await store.restoreVersion(created.id, 1)
    expect(restored.version).toBe(4)
    expect(restored.role.mission).toBe('first')
    const history = await store.versions(created.id)
    expect(
      history.map((entry) => [entry.version, entry.contact.role.mission]),
    ).toEqual([
      [3, 'third'],
      [2, 'second'],
      [1, 'first'],
    ])
    expect(changes.at(-1)).toEqual({
      reason: 'restored',
      contactId: created.id,
      version: 4,
    })
    await expect(store.restoreVersion(created.id, 9)).rejects.toMatchObject({
      code: 'contact_version_not_found',
    })
  })
})

describe('a corrupt contacts file (card test 9)', () => {
  it('backs the file up and goes read-only with the three builtins', async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), 'emperor-contacts-bad-'))
    mkdirSync(join(stateRoot, 'contacts'), { recursive: true })
    writeFileSync(contactsFile(stateRoot), '{"schemaVersion": 2, "contacts": [')
    const { store, changes } = setup({ stateRoot })

    const listing = await store.list()
    expect(listing.contacts.map((contact) => contact.id)).toEqual([
      ...BUILTIN_CONTACT_IDS,
    ])
    expect(listing.readOnly).toMatchObject({ reason: 'corrupt' })
    const backup = listing.readOnly!.backupPath!
    expect(backup).toMatch(/contacts\.json\.corrupt-/)
    expect(readFileSync(backup, 'utf8')).toBe(
      '{"schemaVersion": 2, "contacts": [',
    )
    expect(listing.readOnly!.message).toBe(`联系人文件损坏，已备份到 ${backup}`)

    await expect(store.create({ name: '审稿人' })).rejects.toMatchObject({
      code: 'contacts_read_only',
    })
    await expect(
      store.update('ct-emperor', { intro: '新简介' }),
    ).rejects.toMatchObject({ code: 'contacts_read_only' })
    expect(existsSync(contactsFile(stateRoot))).toBe(false)
    expect(changes).toEqual([])
    expect((await store.get('ct-codex')).name).toBe('Codex')
  })

  it('leaves a file from a newer Emperor alone and read-only (REL-03)', async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), 'emperor-contacts-new-'))
    mkdirSync(join(stateRoot, 'contacts'), { recursive: true })
    const newer = JSON.stringify({ schemaVersion: 4, contacts: [], groups: [] })
    writeFileSync(contactsFile(stateRoot), newer)
    const { store } = setup({ stateRoot })

    const listing = await store.list()
    expect(listing.readOnly).toMatchObject({
      reason: 'newer',
      backupPath: null,
    })
    expect(listing.contacts).toHaveLength(3)
    await expect(store.create({ name: '审稿人' })).rejects.toMatchObject({
      code: 'contacts_read_only',
    })
    expect(readFileSync(contactsFile(stateRoot), 'utf8')).toBe(newer)
  })

  it('treats a well-formed file with an invalid contact as corrupt', async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), 'emperor-contacts-bad-'))
    const { store, make } = setup({ stateRoot })
    const created = await store.create({ name: '审稿人' })
    const file = JSON.parse(readFileSync(contactsFile(stateRoot), 'utf8'))
    file.contacts.find((c: { id: string }) => c.id === created.id).name =
      'x'.repeat(40)
    writeFileSync(contactsFile(stateRoot), JSON.stringify(file))

    const listing = await make().list()
    expect(listing.readOnly?.reason).toBe('corrupt')
    expect(listing.contacts).toHaveLength(3)
  })
})

describe('duplicate, delete and change notifications (card test 12)', () => {
  it('copies a contact under a new name and id', async () => {
    const { store } = setup()
    const original = await store.fromTemplate({ templateId: 'editor' })
    const copy = await store.duplicate(original.id)
    expect(copy).toMatchObject({
      name: '编辑 副本',
      builtin: false,
      version: 1,
      templateId: 'editor',
      role: original.role,
    })
    expect(copy.id).not.toBe(original.id)
    expect((await store.duplicate(original.id)).name).toBe('编辑 副本 2')
    expect((await store.duplicate(original.id, { name: '责编' })).name).toBe(
      '责编',
    )
    const codex = await store.duplicate('ct-codex')
    expect(codex).toMatchObject({
      name: 'Codex 副本',
      kind: 'external',
      backend: 'codex',
      builtin: false,
    })
  })

  it('deletes a contact with its versions and reports every change', async () => {
    const { store, stateRoot, changes } = setup()
    await store.list()
    expect(changes).toEqual([]) // builtins appear without a notification

    const created = await store.create({ name: '审稿人' })
    const updated = await store.update(created.id, {
      role: { mission: '审代码' },
    })
    await store.update(created.id, { avatar: { kind: 'portrait', index: 1 } })
    const result = await store.delete(created.id)
    expect(result).toEqual({ id: created.id, deleted: true })
    expect(existsSync(join(stateRoot, 'contacts', created.id))).toBe(false)
    await expect(store.get(created.id)).rejects.toMatchObject({
      code: 'contact_not_found',
    })
    expect(changes).toEqual([
      { reason: 'created', contactId: created.id, version: 1 },
      { reason: 'updated', contactId: created.id, version: updated.version },
      { reason: 'updated', contactId: created.id, version: 2 },
      { reason: 'deleted', contactId: created.id, version: null },
    ])
  })

  it('writes one change at a time (single writer)', async () => {
    const { store, make } = setup()
    const names = Array.from({ length: 8 }, (_, index) => `成员${index}`)
    const created = await Promise.all(
      names.map((name) => store.create({ name })),
    )
    expect(new Set(created.map((contact) => contact.id)).size).toBe(8)
    const results = await Promise.allSettled([
      store.create({ name: '同名' }),
      store.create({ name: '同名' }),
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const listed = (await make().list()).contacts
    expect(listed).toHaveLength(3 + 8 + 1)
    const lowered = listed.map((contact) => contact.name.toLowerCase())
    expect(new Set(lowered).size).toBe(lowered.length)
  })
})
