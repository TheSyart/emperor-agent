import { randomBytes } from 'node:crypto'
import { readdir, readFile, rm, unlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  AtomicSnapshot,
  NEWER_FILE_MESSAGE,
  durableReplace,
  type PersistenceAdapter,
  type SnapshotCodec,
} from '../store/persistence'
import { readPersonaText } from '../harness/prompt/persona'
import { logger } from '../util/log'
import {
  BACKEND_LABELS,
  BUILTIN_EDITABLE_FIELDS,
  builtinContacts,
  isBuiltinContactId,
} from './builtins'
import {
  ContactBuiltinError,
  ContactNotFoundError,
  ContactTemplateNotFoundError,
  ContactValidationError,
  ContactVersionNotFoundError,
  ContactsReadOnlyError,
} from './errors'
import { loadContactTemplates } from './templates'
import {
  CONTACTS_SCHEMA_VERSION,
  CONTACT_LIMITS,
  EXTERNAL_CAPABILITIES,
  type Capabilities,
  type Contact,
  type ContactAvatar,
  type ContactInput,
  type ContactPatch,
  type ContactTemplate,
  type ContactVersionEntry,
  type ContactsChange,
  type ContactsListing,
  type ContactsReadOnly,
  type FromTemplateInput,
  type GroupHabit,
  type RoleCard,
} from './types'
import {
  charCount,
  checkContactContext,
  normalizeAvatar,
  normalizeContact,
  normalizeIntro,
  permissionAllowed,
  sameValue,
} from './validate'

export interface ContactStoreOptions {
  /** The Emperor Home: contacts live in `<stateRoot>/contacts/`. */
  stateRoot: string
  /** The shipped templates: `agent/persona.md` and `contacts/*.md`. */
  templatesDir: string
  /** Every tool name the registry has (allow / deny may name only these). */
  toolNames?: () => Iterable<string>
  /** 新会话的权限 (`read-only` / `workspace-write` / `danger-full-access`). */
  globalPermission?: () => string
  now?: () => number
  newId?: () => string
  /** After every saved change (CoreApi turns it into `contacts_changed`). */
  onChange?: (change: ContactsChange) => void
  adapter?: PersistenceAdapter
}

interface ContactsState {
  contacts: Contact[]
  readOnly: ContactsReadOnly | null
}

const DEFAULT_GROUP_HABIT: GroupHabit = { speak: 'relevant', length: 'brief' }
const DEFAULT_CAPABILITIES: Capabilities = {
  model: 'inherit',
  tools: { preset: 'read_only' },
  permission: 'inherit',
}
/** A local contact made without an avatar (GRP-04 recommends one instead). */
const DEFAULT_AVATAR: ContactAvatar = { kind: 'library', id: 'AV-13-1' }
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567'
const VERSION_FILE = /^(\d+)\.json$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function emptyRole(): RoleCard {
  return {
    mission: '',
    deliverable: '',
    playbook: '',
    boundaries: '',
    knowledge: [],
  }
}

/** `ct-` + 12 random base32 characters. */
function randomContactId(): string {
  const bytes = randomBytes(12)
  let id = 'ct-'
  for (const byte of bytes) id += BASE32[byte % 32]
  return id
}

/** `stem` cut so that `stem + suffix` fits a name. */
function fitName(stem: string, suffix: string): string {
  const room = CONTACT_LIMITS.name - charCount(suffix)
  return `${Array.from(stem).slice(0, room).join('').trimEnd()}${suffix}`
}

/** `base`, else `base 2`, `base 3`, … — the first no other contact has. */
function freeName(base: string, contacts: readonly Contact[]): string {
  const taken = new Set(contacts.map((contact) => contact.name.toLowerCase()))
  const first = fitName(base, '')
  if (!taken.has(first.toLowerCase())) return first
  for (let n = 2; ; n += 1) {
    const candidate = fitName(base, ` ${n}`)
    if (!taken.has(candidate.toLowerCase())) return candidate
  }
}

/** What {@link ContactStore.update} may change. */
const PATCH_KEYS = [
  'name',
  'avatar',
  'intro',
  'domains',
  'role',
  'capabilities',
  'groupHabit',
  'memory',
] as const

/** Everything the compiled prompt shows or the runtime uses: a change here is a new version. */
function behavior(contact: Contact): unknown {
  const rest: Partial<Contact> = { ...contact }
  delete rest.avatar
  delete rest.version
  delete rest.createdAt
  delete rest.updatedAt
  return rest
}

/** A patch's value for one field, merged one level deep like {@link applyPatch}. */
function mergedField(current: Contact, key: string, value: unknown): unknown {
  const existing = (current as unknown as Record<string, unknown>)[key]
  return ['role', 'capabilities', 'groupHabit'].includes(key) &&
    isRecord(existing) &&
    isRecord(value)
    ? { ...existing, ...value }
    : value
}

function applyPatch(current: Contact, patch: ContactPatch): unknown {
  const next: Record<string, unknown> = { ...current }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    if (!(PATCH_KEYS as readonly string[]).includes(key))
      throw new ContactValidationError(key, `不能修改联系人的 ${key}`)
    next[key] = mergedField(current, key, value)
  }
  return next
}

/**
 * The contacts of one Emperor Home (GRP-02): `contacts/contacts.json`
 * (atomic snapshot, schemaVersion 2) and the 20 newest old versions of each
 * contact in `contacts/<id>/versions/<version>.json`. One writer: changes
 * run one after another. A corrupt file is backed up and the store turns
 * read-only, with the three builtins still there.
 */
export class ContactStore {
  readonly dir: string
  readonly path: string
  private readonly snapshot: AtomicSnapshot<Contact[]>
  private readonly adapter: PersistenceAdapter | undefined
  private readonly now: () => number
  private state: Promise<ContactsState> | null = null
  /** The state once read (changes update it in place): {@link peek}. */
  private loaded: ContactsState | null = null
  private queue: Promise<unknown> = Promise.resolve()
  private templateCache: ContactTemplate[] | null = null
  private shipped: Contact[] | null = null

  constructor(private readonly options: ContactStoreOptions) {
    this.dir = join(resolve(options.stateRoot), 'contacts')
    this.path = join(this.dir, 'contacts.json')
    this.adapter = options.adapter
    this.now = options.now ?? Date.now
    this.snapshot = new AtomicSnapshot({
      path: this.path,
      codec: this.codec(),
      adapter: options.adapter,
      fileMode: 0o600,
    })
  }

  // ── reads ───────────────────────────────────────────────────────────

  async list(): Promise<ContactsListing> {
    const state = await this.load()
    return {
      contacts: structuredClone(state.contacts),
      readOnly: state.readOnly ? { ...state.readOnly } : null,
    }
  }

  async get(id: string): Promise<Contact> {
    return structuredClone(this.find(await this.load(), id))
  }

  /** Resolves once the contacts are read; {@link peek} answers from then on. */
  async ready(): Promise<void> {
    await this.load()
  }

  /**
   * A contact as last read, without waiting (null: unknown, deleted, or
   * not read yet — {@link list} reads). Contact sessions look their
   * contact up this way while they assemble a prompt (GRP-03).
   */
  peek(id: string): Contact | null {
    const contact = this.loaded?.contacts.find(
      (candidate) => candidate.id === id,
    )
    return contact === undefined ? null : structuredClone(contact)
  }

  /** Old versions, newest first (the current one is {@link get}). */
  versions(id: string): Promise<ContactVersionEntry[]> {
    return this.serial(async () => {
      const current = this.find(await this.load(), id)
      const entries: ContactVersionEntry[] = []
      for (const version of await this.versionNumbers(id)) {
        if (version >= current.version) continue
        const entry = await this.readVersion(id, version)
        if (entry) entries.push(entry)
      }
      return entries
    })
  }

  async templates(): Promise<ContactTemplate[]> {
    return structuredClone(this.templateList())
  }

  // ── changes ─────────────────────────────────────────────────────────

  create(input: ContactInput): Promise<Contact> {
    return this.mutate(async (state) => {
      if (!isRecord(input))
        throw new ContactValidationError('contact', '联系人不对')
      const contact = this.build(input, state)
      this.check(contact, state)
      await this.commit(state, [...state.contacts, contact])
      this.emit({ reason: 'created', contactId: contact.id, version: 1 })
      return structuredClone(contact)
    })
  }

  update(id: string, patch: ContactPatch): Promise<Contact> {
    return this.mutate(async (state) => {
      const current = this.find(state, id)
      if (!isRecord(patch))
        throw new ContactValidationError('contact', '修改内容不对')
      const candidate = current.builtin
        ? this.patchBuiltin(current, patch)
        : normalizeContact(applyPatch(current, patch))
      this.check(candidate, state)
      const changed = !sameValue(behavior(candidate), behavior(current))
      if (!changed && sameValue(candidate.avatar, current.avatar))
        return structuredClone(current)
      const now = this.now()
      const next: Contact = {
        ...candidate,
        id: current.id,
        builtin: current.builtin,
        createdAt: current.createdAt,
        version: changed ? current.version + 1 : current.version,
        updatedAt: now,
      }
      if (changed) await this.saveVersion(current, now)
      await this.commit(state, this.replace(state, next))
      this.emit({ reason: 'updated', contactId: id, version: next.version })
      return structuredClone(next)
    })
  }

  delete(id: string): Promise<{ id: string; deleted: true }> {
    return this.mutate(async (state) => {
      const current = this.find(state, id)
      if (current.builtin) throw new ContactBuiltinError('内置联系人不能删除')
      await this.commit(
        state,
        state.contacts.filter((contact) => contact.id !== id),
      )
      // Its old versions and its personal memory go with it.
      await rm(join(this.dir, id), { recursive: true, force: true }).catch(
        (error: unknown) =>
          logger.warn('contacts: could not remove a deleted contact folder', {
            id,
            error: String(error),
          }),
      )
      this.emit({ reason: 'deleted', contactId: id, version: null })
      return { id, deleted: true as const }
    })
  }

  duplicate(id: string, options: { name?: string } = {}): Promise<Contact> {
    return this.mutate(async (state) => {
      const source = this.find(state, id)
      const now = this.now()
      const contact = normalizeContact({
        ...structuredClone(source),
        id: this.newId(state),
        name: options.name ?? freeName(`${source.name} 副本`, state.contacts),
        builtin: false,
        version: 1,
        createdAt: now,
        updatedAt: now,
      })
      this.check(contact, state)
      await this.commit(state, [...state.contacts, contact])
      this.emit({ reason: 'created', contactId: contact.id, version: 1 })
      return structuredClone(contact)
    })
  }

  /** Brings back an old version as a new one; history is never rewritten. */
  restoreVersion(id: string, version: number): Promise<Contact> {
    return this.mutate(async (state) => {
      const current = this.find(state, id)
      const entry =
        Number.isInteger(version) && version >= 1 && version < current.version
          ? await this.readVersion(id, version)
          : null
      if (!entry) throw new ContactVersionNotFoundError(id, version)
      const old = entry.contact
      // A builtin's versions differ only in their intro.
      const candidate = current.builtin
        ? { ...current, intro: old.intro }
        : normalizeContact({
            ...current,
            name: old.name,
            intro: old.intro,
            domains: old.domains,
            role: old.role,
            capabilities: old.capabilities,
            groupHabit: old.groupHabit,
            memory: old.memory,
          })
      this.check(candidate, state)
      const now = this.now()
      const next: Contact = {
        ...candidate,
        version: current.version + 1,
        updatedAt: now,
      }
      await this.saveVersion(current, now)
      await this.commit(state, this.replace(state, next))
      this.emit({ reason: 'restored', contactId: id, version: next.version })
      return structuredClone(next)
    })
  }

  fromTemplate(input: FromTemplateInput): Promise<Contact> {
    return this.mutate(async (state) => {
      const template = this.templateList().find(
        (candidate) => candidate.id === input?.templateId,
      )
      if (!template)
        throw new ContactTemplateNotFoundError(String(input?.templateId))
      const backend = input.backend
      const name =
        input.name ??
        freeName(
          backend
            ? `${BACKEND_LABELS[backend]} · ${template.name}`
            : template.name,
          state.contacts,
        )
      // A template never asks for more than the global preset allows.
      const permission = permissionAllowed(
        template.permission,
        this.globalPermission(),
      )
        ? template.permission
        : 'read_only'
      const contact = this.build(
        {
          name,
          ...(backend
            ? { kind: 'external' as const, backend }
            : {
                kind: 'local' as const,
                capabilities: {
                  model: 'inherit',
                  tools: { preset: template.tools },
                  permission,
                },
              }),
          avatar:
            input.avatar ??
            (backend
              ? { kind: 'logo', backend }
              : { kind: 'library', id: template.avatar }),
          intro: template.intro,
          domains: template.domains,
          role: structuredClone(template.role),
          // An external member speaks when @-mentioned (GRP-09): slower, dearer runs.
          groupHabit: {
            speak: backend ? 'mentioned' : template.speak,
            length: 'brief',
          },
          templateId: template.id,
        },
        state,
      )
      this.check(contact, state)
      await this.commit(state, [...state.contacts, contact])
      this.emit({ reason: 'created', contactId: contact.id, version: 1 })
      return structuredClone(contact)
    })
  }

  // ── internals ───────────────────────────────────────────────────────

  private build(input: ContactInput, state: ContactsState): Contact {
    const kind = input.kind ?? (input.backend ? 'external' : 'local')
    const now = this.now()
    return normalizeContact({
      id: this.newId(state),
      kind,
      ...(input.backend !== undefined ? { backend: input.backend } : {}),
      name: input.name,
      avatar:
        input.avatar ??
        (kind === 'external' && input.backend
          ? { kind: 'logo', backend: input.backend }
          : DEFAULT_AVATAR),
      intro: input.intro ?? '',
      domains: input.domains ?? [],
      role: { ...emptyRole(), ...(isRecord(input.role) ? input.role : {}) },
      capabilities:
        kind === 'external'
          ? { ...structuredClone(EXTERNAL_CAPABILITIES), ...input.capabilities }
          : { ...DEFAULT_CAPABILITIES, ...input.capabilities },
      groupHabit: {
        ...DEFAULT_GROUP_HABIT,
        ...(input.kind === 'external' ? { speak: 'mentioned' as const } : {}),
        ...input.groupHabit,
      },
      memory: input.memory ?? { enabled: true },
      version: 1,
      ...(input.templateId !== undefined
        ? { templateId: input.templateId }
        : {}),
      builtin: false,
      createdAt: now,
      updatedAt: now,
    })
  }

  /** Builtins take only a new avatar and intro; other fields may come along unchanged. */
  private patchBuiltin(current: Contact, patch: ContactPatch): Contact {
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue
      if ((BUILTIN_EDITABLE_FIELDS as readonly string[]).includes(key)) continue
      const existing = (current as unknown as Record<string, unknown>)[key]
      if (!sameValue(mergedField(current, key, value), existing))
        throw new ContactBuiltinError('内置联系人只能改头像和简介')
    }
    return {
      ...current,
      avatar:
        patch.avatar !== undefined
          ? normalizeAvatar(patch.avatar)
          : current.avatar,
      intro:
        patch.intro !== undefined ? normalizeIntro(patch.intro) : current.intro,
    }
  }

  private check(contact: Contact, state: ContactsState): void {
    checkContactContext(contact, {
      others: state.contacts.filter((other) => other.id !== contact.id),
      toolNames: new Set(this.options.toolNames?.() ?? []),
      globalPermission: this.globalPermission(),
    })
  }

  private globalPermission(): string {
    return this.options.globalPermission?.() ?? 'workspace-write'
  }

  private newId(state: ContactsState): string {
    const make = this.options.newId ?? randomContactId
    const taken = new Set(state.contacts.map((contact) => contact.id))
    for (;;) {
      const id = make()
      if (!taken.has(id)) return id
    }
  }

  private find(state: ContactsState, id: string): Contact {
    const contact = state.contacts.find((candidate) => candidate.id === id)
    if (!contact) throw new ContactNotFoundError(id)
    return contact
  }

  private replace(state: ContactsState, next: Contact): Contact[] {
    return state.contacts.map((contact) =>
      contact.id === next.id ? next : contact,
    )
  }

  private emit(change: ContactsChange): void {
    try {
      this.options.onChange?.(change)
    } catch (error) {
      logger.warn('contacts: change listener failed', { error: String(error) })
    }
  }

  private templateList(): ContactTemplate[] {
    if (this.templateCache === null) {
      const { templates, errors } = loadContactTemplates(
        this.options.templatesDir,
      )
      for (const error of errors) logger.warn(`contacts: ${error}`)
      this.templateCache = templates
    }
    return this.templateCache
  }

  /** The builtins as shipped (the persona read once per store). */
  private builtins(): Contact[] {
    this.shipped ??= builtinContacts(
      readPersonaText(this.options.templatesDir),
      this.now(),
    )
    return structuredClone(this.shipped)
  }

  /** The stored contacts with the shipped builtins first (only their avatar and intro come from disk). */
  private withBuiltins(stored: readonly Contact[]): Contact[] {
    const byId = new Map(stored.map((contact) => [contact.id, contact]))
    const builtins = this.builtins().map((builtin) => {
      const saved = byId.get(builtin.id)
      return saved
        ? {
            ...builtin,
            avatar: saved.avatar,
            intro: saved.intro,
            version: saved.version,
            createdAt: saved.createdAt,
            updatedAt: saved.updatedAt,
          }
        : builtin
    })
    return [
      ...builtins,
      ...stored.filter((contact) => !isBuiltinContactId(contact.id)),
    ]
  }

  private codec(): SnapshotCodec<Contact[]> {
    return {
      schemaVersion: CONTACTS_SCHEMA_VERSION,
      versionKey: 'schemaVersion',
      encode: (contacts) => ({
        schemaVersion: CONTACTS_SCHEMA_VERSION,
        contacts,
      }),
      decode: (input) => {
        if (
          !isRecord(input) ||
          input.schemaVersion !== CONTACTS_SCHEMA_VERSION ||
          !Array.isArray(input.contacts)
        )
          throw new Error(
            'contacts.json is not a schemaVersion 2 contacts file',
          )
        const contacts = input.contacts.map((raw: unknown) =>
          isRecord(raw) &&
          typeof raw.id === 'string' &&
          isBuiltinContactId(raw.id)
            ? this.decodeBuiltin(raw)
            : normalizeContact(raw),
        )
        const ids = new Set(contacts.map((contact) => contact.id))
        const names = new Set(
          contacts.map((contact) => contact.name.toLowerCase()),
        )
        if (ids.size !== contacts.length || names.size !== contacts.length)
          throw new Error('contacts.json repeats a contact id or name')
        return { value: contacts, schemaVersion: CONTACTS_SCHEMA_VERSION }
      },
    }
  }

  /** A stored builtin: its editable fields checked, the rest as shipped. */
  private decodeBuiltin(raw: Record<string, unknown>): Contact {
    const shipped = this.builtins().find((builtin) => builtin.id === raw.id)!
    const version = raw.version
    if (
      typeof version !== 'number' ||
      !Number.isInteger(version) ||
      version < 1
    )
      throw new ContactValidationError('version', '版本号不对')
    const time = (value: unknown, fallback: number): number =>
      typeof value === 'number' && Number.isFinite(value) && value >= 0
        ? value
        : fallback
    return {
      ...shipped,
      avatar: normalizeAvatar(raw.avatar),
      intro: normalizeIntro(raw.intro),
      version,
      createdAt: time(raw.createdAt, shipped.createdAt),
      updatedAt: time(raw.updatedAt, shipped.updatedAt),
    }
  }

  private load(): Promise<ContactsState> {
    this.state ??= this.read().then(
      (state) => {
        this.loaded = state
        return state
      },
      (error: unknown) => {
        this.state = null
        throw error
      },
    )
    return this.state
  }

  private async read(): Promise<ContactsState> {
    const result = await this.snapshot.read({ fallback: [] })
    const { recoveryAction, corruptionBackup } = result.receipt
    if (recoveryAction === 'quarantined_corrupt_snapshot') {
      const backupPath = corruptionBackup ?? this.path
      logger.warn('contacts: contacts.json is corrupt; read-only', {
        backupPath,
      })
      return {
        contacts: this.builtins(),
        readOnly: {
          reason: 'corrupt',
          message: `联系人文件损坏，已备份到 ${backupPath}`,
          backupPath,
        },
      }
    }
    if (recoveryAction === 'newer_version_read_only')
      return {
        contacts: this.withBuiltins(result.value),
        readOnly: {
          reason: 'newer',
          message: `${NEWER_FILE_MESSAGE}：contacts.json`,
          backupPath: null,
        },
      }
    const contacts = this.withBuiltins(result.value)
    // First start (or a builtin missing from the file): write the three.
    if (
      !result.found ||
      !sameValue(
        contacts.map((contact) => contact.id),
        result.value.map((contact) => contact.id),
      )
    )
      await this.snapshot.write(contacts)
    return { contacts, readOnly: null }
  }

  private serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task)
    this.queue = run.catch(() => undefined)
    return run
  }

  private mutate<T>(task: (state: ContactsState) => Promise<T>): Promise<T> {
    return this.serial(async () => {
      const state = await this.load()
      if (state.readOnly)
        throw new ContactsReadOnlyError(state.readOnly.message)
      return task(state)
    })
  }

  private async commit(state: ContactsState, next: Contact[]): Promise<void> {
    await this.snapshot.write(next)
    state.contacts = next
  }

  private versionsDir(id: string): string {
    return join(this.dir, id, 'versions')
  }

  /** Version numbers on disk, newest first. */
  private async versionNumbers(id: string): Promise<number[]> {
    let names: string[]
    try {
      names = await readdir(this.versionsDir(id))
    } catch {
      return []
    }
    return names
      .map((name) => VERSION_FILE.exec(name)?.[1])
      .filter((value): value is string => value !== undefined)
      .map(Number)
      .sort((left, right) => right - left)
  }

  private async readVersion(
    id: string,
    version: number,
  ): Promise<ContactVersionEntry | null> {
    try {
      const raw = JSON.parse(
        await readFile(join(this.versionsDir(id), `${version}.json`), 'utf8'),
      ) as unknown
      if (!isRecord(raw) || typeof raw.savedAt !== 'number') return null
      const contact = isRecord(raw.contact) ? raw.contact : null
      if (contact === null || contact.id !== id || contact.version !== version)
        return null
      return {
        version,
        savedAt: raw.savedAt,
        // Builtins keep their shipped role; only what they let change is read.
        contact: isBuiltinContactId(id)
          ? this.decodeBuiltin(contact)
          : normalizeContact(contact),
      }
    } catch {
      // A missing or damaged old version is skipped, never fatal.
      return null
    }
  }

  /** Keeps `contact` as it was, then the {@link CONTACT_LIMITS.versions} newest only. */
  private async saveVersion(contact: Contact, savedAt: number): Promise<void> {
    const dir = this.versionsDir(contact.id)
    await durableReplace(
      join(dir, `${contact.version}.json`),
      `${JSON.stringify(
        {
          schemaVersion: CONTACTS_SCHEMA_VERSION,
          version: contact.version,
          savedAt,
          contact,
        },
        null,
        2,
      )}\n`,
      { adapter: this.adapter, fileMode: 0o600, directoryMode: 0o700 },
    )
    const versions = await this.versionNumbers(contact.id)
    for (const old of versions.slice(CONTACT_LIMITS.versions))
      await unlink(join(dir, `${old}.json`)).catch(() => undefined)
  }
}
