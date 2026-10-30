/**
 * A contact's working experiences (CP-04): what it learned doing its own
 * work, kept apart from the user's feedback lines and from the main memory.
 *
 * One file per contact: `contacts/<id>/memory/experiences.json`
 * (schemaVersion 1, revision). Every write is serial per instance and
 * atomically replaces the file; an idempotency key stops the same turn
 * from being distilled twice. A deleted entry leaves a tombstone so the
 * same source cannot come back by itself.
 */
import { randomBytes } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { durableReplace, type PersistenceAdapter } from '../store/persistence'

export const EXPERIENCES_SCHEMA_VERSION = 1
export const EXPERIENCE_RECALL_BYTES = 4 * 1024
export const EXPERIENCE_MAX_PER_TURN = 5
export const EXPERIENCE_TEXT_CHARS = 500
export const EXPERIENCE_CONDITION_CHARS = 300

export type ExperienceStatus =
  'candidate' | 'active' | 'superseded' | 'disabled' | 'deleted'
export type ExperienceScopeKind = 'contact' | 'project' | 'group' | 'session'

export interface ExperienceScope {
  kind: ExperienceScopeKind
  id?: string
}

export interface ExperienceEvidence {
  kind: 'tool_result' | 'user_confirmation' | 'user_correction'
  /** A tool call id, a message id or a source hint the host checked. */
  ref: string
}

export interface ExperienceSource {
  sessionId: string
  turnId: string
  messageIds: string[]
  roleVersion: number
}

export interface ContactExperience {
  id: string
  contactId: string
  text: string
  conditions: string
  scope: ExperienceScope
  source: ExperienceSource
  evidence: ExperienceEvidence[]
  status: ExperienceStatus
  createdAt: number
  updatedAt: number
  supersedes?: string
}

/** Old feedback lines that cannot be traced to an exact source (CP-04). */
export interface LegacyFeedback {
  id: string
  rawText: string
  rating: 'up' | 'down' | null
  date?: string
  sourceHint?: string
  /** Never recalled until the user confirms a conclusion and its scope. */
  status: 'needs_confirmation'
}

export interface ContactExperienceListing {
  contactId: string
  revision: number
  experiences: ContactExperience[]
  legacy: LegacyFeedback[]
  lastError: { at: number; message: string } | null
}

interface ExperiencesFile {
  schemaVersion: typeof EXPERIENCES_SCHEMA_VERSION
  revision: number
  experiences: ContactExperience[]
  legacy: LegacyFeedback[]
  tombstones: { id: string; at: number }[]
  lastError?: { at: number; message: string }
}

export interface ExperienceDraft {
  text: string
  conditions?: string
  scope?: ExperienceScope
  evidence?: ExperienceEvidence[]
  status?: 'candidate' | 'active'
}

export interface ExperienceStoreOptions {
  /** The Emperor Home. */
  stateRoot: string
  now?: () => number
  adapter?: PersistenceAdapter
}

function emptyFile(): ExperiencesFile {
  return {
    schemaVersion: EXPERIENCES_SCHEMA_VERSION,
    revision: 0,
    experiences: [],
    legacy: [],
    tombstones: [],
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function experienceId(): string {
  const bytes = randomBytes(9)
  const base32 = 'abcdefghijklmnopqrstuvwxyz234567'
  let id = 'xp-'
  for (const byte of bytes) id += base32[byte % 32]
  return id
}

function clip(text: string, chars: number): string {
  const value = text.trim()
  return Array.from(value).slice(0, chars).join('')
}

function decode(input: unknown): ExperiencesFile {
  if (!isRecord(input)) return emptyFile()
  const experiences = Array.isArray(input.experiences)
    ? input.experiences.filter(
        (item): item is ContactExperience =>
          isRecord(item) &&
          typeof item.id === 'string' &&
          typeof item.contactId === 'string' &&
          typeof item.text === 'string' &&
          typeof item.status === 'string',
      )
    : []
  const legacy = Array.isArray(input.legacy)
    ? input.legacy.filter(
        (item): item is LegacyFeedback =>
          isRecord(item) &&
          typeof item.id === 'string' &&
          typeof item.rawText === 'string',
      )
    : []
  return {
    schemaVersion: EXPERIENCES_SCHEMA_VERSION,
    revision:
      typeof input.revision === 'number' && Number.isInteger(input.revision)
        ? input.revision
        : 0,
    experiences,
    legacy,
    tombstones: Array.isArray(input.tombstones)
      ? input.tombstones.filter(
          (item): item is { id: string; at: number } =>
            isRecord(item) && typeof item.id === 'string',
        )
      : [],
    ...(isRecord(input.lastError) &&
    typeof input.lastError.at === 'number' &&
    typeof input.lastError.message === 'string'
      ? {
          lastError: {
            at: input.lastError.at,
            message: input.lastError.message,
          },
        }
      : {}),
  }
}

/** Experiences that may be recalled for the given scope. */
export function recallable(
  experiences: readonly ContactExperience[],
  scope: ExperienceScope,
): ContactExperience[] {
  return experiences
    .filter((experience) => experience.status === 'active')
    .filter(
      (experience) =>
        experience.scope.kind === 'contact' ||
        (experience.scope.kind === scope.kind &&
          (experience.scope.id === undefined ||
            experience.scope.id === scope.id)),
    )
    .sort((left, right) => right.updatedAt - left.updatedAt)
}

/** The recalled text, newest first, within `budget` UTF-8 bytes ('' when none). */
export function recallText(
  experiences: readonly ContactExperience[],
  scope: ExperienceScope,
  budget = EXPERIENCE_RECALL_BYTES,
): string {
  const lines: string[] = []
  let used = 0
  for (const experience of recallable(experiences, scope)) {
    const line = `- ${experience.text}${
      experience.conditions ? `（适用：${experience.conditions}）` : ''
    }`
    const size = Buffer.byteLength(`${line}\n`)
    if (used + size > budget) break
    lines.push(line)
    used += size
  }
  return lines.join('\n')
}

export class ContactExperienceStore {
  private readonly dir: string
  private readonly now: () => number
  private readonly adapter: PersistenceAdapter | undefined
  private queue: Promise<unknown> = Promise.resolve()

  constructor(options: ExperienceStoreOptions) {
    this.dir = resolve(options.stateRoot)
    this.now = options.now ?? Date.now
    this.adapter = options.adapter
  }

  private pathFor(contactId: string): string {
    return join(this.dir, 'contacts', contactId, 'memory', 'experiences.json')
  }

  private serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task)
    this.queue = run.catch(() => undefined)
    return run
  }

  private async read(contactId: string): Promise<ExperiencesFile> {
    try {
      return decode(JSON.parse(await readFile(this.pathFor(contactId), 'utf8')))
    } catch {
      return emptyFile()
    }
  }

  private async write(contactId: string, file: ExperiencesFile): Promise<void> {
    const path = this.pathFor(contactId)
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await durableReplace(
      path,
      `${JSON.stringify({ ...file, schemaVersion: EXPERIENCES_SCHEMA_VERSION }, null, 2)}\n`,
      { adapter: this.adapter, fileMode: 0o600, directoryMode: 0o700 },
    )
  }

  async list(contactId: string): Promise<ContactExperienceListing> {
    return this.serial(async () => {
      const file = await this.read(contactId)
      return {
        contactId,
        revision: file.revision,
        experiences: structuredClone(file.experiences),
        legacy: structuredClone(file.legacy),
        lastError: file.lastError ?? null,
      }
    })
  }

  /** Adds candidates/active entries once per source turn; returns what it added. */
  async add(
    contactId: string,
    drafts: readonly ExperienceDraft[],
    source: ExperienceSource,
  ): Promise<ContactExperience[]> {
    return this.serial(async () => {
      const file = await this.read(contactId)
      const key = `${source.sessionId}:${source.turnId}`
      const already = file.experiences.some(
        (experience) =>
          `${experience.source.sessionId}:${experience.source.turnId}` === key,
      )
      if (already) return []
      const now = this.now()
      const added: ContactExperience[] = []
      for (const draft of drafts.slice(0, EXPERIENCE_MAX_PER_TURN)) {
        const text = clip(draft.text, EXPERIENCE_TEXT_CHARS)
        if (!text) continue
        const evidence = draft.evidence ?? []
        const status =
          draft.status === 'active' && evidence.length ? 'active' : 'candidate'
        added.push({
          id: experienceId(),
          contactId,
          text,
          conditions: clip(draft.conditions ?? '', EXPERIENCE_CONDITION_CHARS),
          scope: draft.scope ?? { kind: 'contact' },
          source: {
            sessionId: source.sessionId,
            turnId: source.turnId,
            messageIds: [...source.messageIds],
            roleVersion: source.roleVersion,
          },
          evidence: evidence.map((item) => ({ ...item })),
          status,
          createdAt: now,
          updatedAt: now,
        })
      }
      if (!added.length) return []
      file.experiences.push(...added)
      file.revision += 1
      delete file.lastError
      await this.write(contactId, file)
      return structuredClone(added)
    })
  }

  async update(
    contactId: string,
    id: string,
    patch: {
      text?: string
      conditions?: string
      scope?: ExperienceScope
      status?: Exclude<ExperienceStatus, 'deleted'>
    },
  ): Promise<ContactExperience> {
    return this.serial(async () => {
      const file = await this.read(contactId)
      const entry = file.experiences.find((experience) => experience.id === id)
      if (!entry) throw new Error('没有这条经验')
      if (patch.text !== undefined)
        entry.text = clip(patch.text, EXPERIENCE_TEXT_CHARS)
      if (patch.conditions !== undefined)
        entry.conditions = clip(patch.conditions, EXPERIENCE_CONDITION_CHARS)
      if (patch.scope !== undefined) entry.scope = { ...patch.scope }
      if (patch.status !== undefined) entry.status = patch.status
      entry.updatedAt = this.now()
      file.revision += 1
      await this.write(contactId, file)
      return structuredClone(entry)
    })
  }

  /** Deletes with a tombstone; a deleted entry is never recalled again. */
  async remove(contactId: string, id: string): Promise<void> {
    return this.serial(async () => {
      const file = await this.read(contactId)
      const entry = file.experiences.find((experience) => experience.id === id)
      if (!entry) return
      entry.status = 'deleted'
      entry.updatedAt = this.now()
      file.tombstones.push({ id, at: entry.updatedAt })
      file.revision += 1
      await this.write(contactId, file)
    })
  }

  async restore(contactId: string, id: string): Promise<ContactExperience> {
    return this.serial(async () => {
      const file = await this.read(contactId)
      const entry = file.experiences.find((experience) => experience.id === id)
      if (!entry) throw new Error('没有这条经验')
      if (entry.status !== 'deleted' && entry.status !== 'disabled')
        return structuredClone(entry)
      entry.status = 'candidate'
      entry.updatedAt = this.now()
      file.revision += 1
      await this.write(contactId, file)
      return structuredClone(entry)
    })
  }

  /** Imports old feedback lines once; they wait for the user's confirmation. */
  async importLegacy(
    contactId: string,
    entries: readonly {
      rawText: string
      rating: 'up' | 'down' | null
      date?: string
    }[],
  ): Promise<void> {
    return this.serial(async () => {
      const file = await this.read(contactId)
      if (file.legacy.length || !entries.length) return
      file.legacy = entries.map((entry, index) => ({
        id: `lg-${index + 1}`,
        rawText: entry.rawText,
        rating: entry.rating,
        ...(entry.date ? { date: entry.date } : {}),
        status: 'needs_confirmation' as const,
      }))
      file.revision += 1
      await this.write(contactId, file)
    })
  }

  /** Records a distillation failure for the memory page (does not throw). */
  async noteError(contactId: string, message: string): Promise<void> {
    return this.serial(async () => {
      const file = await this.read(contactId)
      file.lastError = { at: this.now(), message }
      await this.write(contactId, file)
    })
  }
}
