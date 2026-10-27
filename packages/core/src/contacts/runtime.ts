/**
 * Contacts at run time (GRP-03). A session that belongs to a contact
 * (`contact_id`) runs as that contact:
 *
 * - its compiled role card replaces the persona (with its pinned knowledge,
 *   at most 8 KB, quoted as material, and its personal memory, the newest
 *   4 KB);
 * - it sees only its tools: the preset's (generated from the registry, so
 *   no preset names a tool the kernel does not have) ∪ allow − deny, and
 *   so do the subagents it starts;
 * - its requests go to its model profile; when that profile is gone the
 *   session asks before it falls back to the default model;
 * - its permission is the lower of its own and the global preset;
 * - its knowledge outside the workspace is read-only.
 *
 * Only what the role card says decides the tools and the permission:
 * nothing in the material or a web page can change them. Emperor's own
 * contact keeps the persona and all of Emperor's tools (its role card is
 * the persona; only its memory is added), and the external contacts
 * (Claude Code, Codex) are not narrowed here: their executors' settings
 * rule (GRP-09).
 */

import { closeSync, openSync, readSync, statSync, type Stats } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, sep } from 'node:path'
import type { AgentOptions } from '../harness/agent/agent'
import { canonicalPath } from '../harness/sandbox/policy'
import type { ToolFilter } from '../harness/tools/registry'
import type { LlmCallConfig } from '../llm/call-config'
import type { RouteSpec } from '../llm/route'
import type { Session } from '../session-log/session'
import {
  compileRolePrompt,
  type KnowledgeContext,
  type PinnedKnowledge,
} from './compile'
import { ContactModelUnavailableError } from './errors'
import type { ContactMemoryStore } from './memory'
import type {
  Contact,
  ContactPermission,
  ContactTools,
  KnowledgeRef,
  ToolPreset,
} from './types'

declare module '../session-log/types' {
  interface SessionEventMap {
    /**
     * The user let this contact session use the default model while the
     * contact's model profile `profileId` is gone (GRP-03; log-only).
     */
    'contact/model-fallback': { contactId: string; profileId: string }
  }
}

// ── tools ─────────────────────────────────────────────────────────────

const READ_ONLY_TOOLS = ['read', 'glob', 'grep', 'todo_write', 'skill']
const RESEARCH_TOOLS = [...READ_ONLY_TOOLS, 'web_search', 'web_fetch']
const WRITER_TOOLS = [...RESEARCH_TOOLS, 'write', 'edit']
/** bash, with the job tools its background runs are read and stopped with. */
const ENGINEER_TOOLS = [
  ...WRITER_TOOLS,
  'bash',
  'job_output',
  'job_list',
  'job_kill',
]

/**
 * The tools each preset may hold (OBS-13). A preset gets the ones the
 * registry has ({@link toolPresetTable}); `custom` is the allow list alone.
 */
export const PRESET_TOOLS: Readonly<
  Record<Exclude<ToolPreset, 'custom'>, readonly string[]>
> = Object.freeze({
  read_only: Object.freeze(READ_ONLY_TOOLS),
  research: Object.freeze(RESEARCH_TOOLS),
  writer: Object.freeze(WRITER_TOOLS),
  engineer: Object.freeze(ENGINEER_TOOLS),
})

/** In no preset: only a custom allow list names them, and they still ask. */
export const NEVER_PRESET_TOOLS = Object.freeze([
  'skill_manage',
  'mcp_config',
  'scheduler',
] as const)

/** Each preset's tools as the registry has them, sorted. */
export function toolPresetTable(
  registered: Iterable<string>,
): Record<ToolPreset, string[]> {
  const known = new Set(registered)
  const pick = (names: readonly string[]): string[] =>
    names.filter((name) => known.has(name)).sort()
  return {
    read_only: pick(PRESET_TOOLS.read_only),
    research: pick(PRESET_TOOLS.research),
    writer: pick(PRESET_TOOLS.writer),
    engineer: pick(PRESET_TOOLS.engineer),
    custom: [],
  }
}

/** A contact's tools: preset ∪ allow − deny, of those the registry has, sorted. */
export function contactToolNames(
  tools: ContactTools,
  registered: Iterable<string>,
): string[] {
  const known = new Set(registered)
  const names = new Set(
    tools.preset === 'custom' ? [] : PRESET_TOOLS[tools.preset],
  )
  for (const name of tools.allow ?? []) names.add(name)
  for (const name of tools.deny ?? []) names.delete(name)
  return [...names].filter((name) => known.has(name)).sort()
}

// ── permission ────────────────────────────────────────────────────────

const RANKED_PRESETS = [
  'read-only',
  'workspace-write',
  'danger-full-access',
] as const

/** A preset's place from read-only (0) up; an unknown one counts as read-only. */
export function presetRank(preset: string): number {
  const rank = (RANKED_PRESETS as readonly string[]).indexOf(preset)
  return rank < 0 ? 0 : rank
}

/** The lower of a contact's permission and the global preset (新会话的权限). */
export function contactPermissionPreset(
  permission: ContactPermission,
  globalPreset: string,
): string {
  const global = presetRank(globalPreset)
  const own =
    permission === 'inherit' ? global : permission === 'read_only' ? 0 : 1
  return RANKED_PRESETS[Math.min(own, global)]!
}

// ── knowledge ─────────────────────────────────────────────────────────

/** Pinned files together in the prompt. */
export const PINNED_KNOWLEDGE_BYTES = 8 * 1024
/** Less room than this left: the next pinned file is not inlined at all. */
const MIN_CUT_BYTES = 256

function statOf(path: string): Stats | null {
  try {
    return statSync(path)
  } catch {
    return null
  }
}

/** Whether a file or folder reference is still there, as what it says it is. */
function present(ref: KnowledgeRef): boolean {
  if (ref.kind !== 'file' && ref.kind !== 'folder') return true
  const stat = statOf(ref.path)
  return ref.kind === 'file'
    ? stat?.isFile() === true
    : stat?.isDirectory() === true
}

/** The first `max` bytes of `path` (and whether that was all of it). */
function readHead(path: string, max: number): { bytes: Buffer; all: boolean } {
  const size = statSync(path).size
  const fd = openSync(path, 'r')
  try {
    const bytes = Buffer.alloc(Math.min(size, max))
    const read = readSync(fd, bytes, 0, bytes.length, 0)
    return { bytes: bytes.subarray(0, read), all: read >= size }
  } finally {
    closeSync(fd)
  }
}

/** The longest start of `text` within `max` UTF-8 bytes, never half a character. */
function cutUtf8(text: string, max: number): string {
  let bytes = 0
  let end = 0
  for (const char of text) {
    const size = Buffer.byteLength(char)
    if (bytes + size > max) break
    bytes += size
    end += char.length
  }
  return text.slice(0, end)
}

function readPinned(path: string, room: number): PinnedKnowledge {
  if (room < MIN_CUT_BYTES) return { path, text: '', status: 'budget' }
  let head: { bytes: Buffer; all: boolean }
  try {
    // Line endings shrink when unified: read twice the room.
    head = readHead(path, room * 2 + 4)
  } catch {
    return { path, text: '', status: 'unreadable' }
  }
  if (head.bytes.includes(0)) return { path, text: '', status: 'binary' }
  let text = head.bytes.toString('utf8').replace(/\r\n?/g, '\n')
  // A read that stopped inside a character leaves a replacement mark.
  if (!head.all) text = text.replace(/�+$/, '')
  if (head.all) {
    text = text.trimEnd()
    if (Buffer.byteLength(text) <= room) return { path, text, status: 'full' }
  }
  const cut = cutUtf8(text, room).trimEnd()
  return cut
    ? { path, text: cut, status: 'cut' }
    : { path, text: '', status: 'budget' }
}

/**
 * The role card's knowledge as it is on disk now: references that are gone,
 * and the pinned files to inline, in order, within `budget` bytes together
 * (once a file is cut, the rest are not inlined).
 */
export function readKnowledge(
  refs: readonly KnowledgeRef[],
  budget = PINNED_KNOWLEDGE_BYTES,
): { missing: string[]; pinned: PinnedKnowledge[] } {
  const missing: string[] = []
  const pinned: PinnedKnowledge[] = []
  let room = budget
  for (const ref of refs) {
    if (ref.kind !== 'file' && ref.kind !== 'folder') continue
    if (!present(ref)) {
      missing.push(ref.path)
      continue
    }
    if (ref.kind !== 'file' || ref.pinned !== true) continue
    const item = readPinned(ref.path, room)
    pinned.push(item)
    room = item.status === 'cut' ? 0 : room - Buffer.byteLength(item.text)
  }
  return { missing, pinned }
}

function isUnder(path: string, root: string): boolean {
  return (
    path === root || path.startsWith(root.endsWith(sep) ? root : root + sep)
  )
}

/**
 * The knowledge outside the workspace, as real paths: read-only for the
 * session (file tools and Shell may read them, never write). A folder that
 * holds the workspace or the temporary folders is left out, so the contact
 * can still write where its permission lets it.
 */
export function knowledgeReadOnlyRoots(
  refs: readonly KnowledgeRef[],
  workspaceRoot: string,
): string[] {
  const workspace = canonicalPath(resolve(workspaceRoot))
  const writable = [workspace, canonicalPath('/tmp'), canonicalPath(tmpdir())]
  const roots = new Set<string>()
  for (const ref of refs) {
    if (ref.kind !== 'file' && ref.kind !== 'folder') continue
    if (!present(ref)) continue
    const path = canonicalPath(resolve(ref.path))
    if (isUnder(path, workspace)) continue
    if (writable.some((root) => isUnder(root, path))) continue
    roots.add(path)
  }
  return [...roots].sort()
}

// ── the runtime ───────────────────────────────────────────────────────

export interface ContactRuntimeDeps {
  /** A contact as the store has it now; null when there is none (deleted). */
  contact(id: string): Contact | null
  memory: ContactMemoryStore
  /** Every tool name the registry has. */
  toolNames(): Iterable<string>
  /** 设置 › 常规 › 会话 › 新会话的权限. */
  globalPreset(): string
  /** A configured model entry, by id. */
  route(id: string): RouteSpec | undefined
  /** The active route's request config, or `routeId`'s. */
  defaultCallConfig(routeId?: string): LlmCallConfig
  /** Emperor's persona (the builtin Emperor contact's role card). */
  persona(): string
}

export type ContactModelState =
  | { kind: 'default' }
  | { kind: 'profile'; config: LlmCallConfig }
  | { kind: 'unavailable'; profileId: string }

/** What a contact is right now, for one session. */
export interface ContactSnapshot {
  /** Null: the contact was deleted (the session can be read, not continued). */
  contact: Contact | null
  /** The tools it sees; null: not narrowed (Emperor, external contacts). */
  tools: readonly string[] | null
  /** The persona section; null: Emperor's persona as it is. */
  prompt: string | null
  /** The highest permission preset; null: no ceiling. */
  ceiling: string | null
  readOnlyRoots: readonly string[]
  model: ContactModelState
}

const MEMORY_LEAD = '用户给你的明确反馈，越靠后越新；照着改进：'

export class ContactRuntime {
  constructor(private readonly deps: ContactRuntimeDeps) {}

  /** The binding of one contact session (made with its agent). */
  bind(
    contactId: string,
    session: Session,
    workspaceRoot: () => string,
  ): ContactBinding {
    return new ContactBinding(contactId, session, this, workspaceRoot)
  }

  defaultCallConfig(): LlmCallConfig {
    return this.deps.defaultCallConfig()
  }

  /** The active route's display name, for the fallback question. */
  defaultModelName(): string {
    try {
      const config = this.deps.defaultCallConfig()
      return this.deps.route(config.provider)?.displayName ?? config.model
    } catch {
      return '默认模型'
    }
  }

  snapshot(contactId: string, workspaceRoot: string): ContactSnapshot {
    const contact = this.deps.contact(contactId)
    if (contact === null)
      return {
        contact: null,
        tools: [],
        prompt: null,
        ceiling: 'read-only',
        readOnlyRoots: [],
        model: { kind: 'default' },
      }
    const unchanged = {
      contact,
      tools: null,
      prompt: null,
      ceiling: null,
      readOnlyRoots: [],
      model: { kind: 'default' },
    } satisfies ContactSnapshot
    if (contact.kind === 'external') return unchanged
    const memory = contact.memory.enabled ? this.memoryText(contact.id) : ''
    if (contact.builtin)
      return memory
        ? {
            ...unchanged,
            prompt: `${this.deps.persona()}\n\n# 记忆\n\n${memory}`,
          }
        : unchanged
    const knowledge: KnowledgeContext = readKnowledge(contact.role.knowledge)
    return {
      contact,
      tools: contactToolNames(
        contact.capabilities.tools,
        this.deps.toolNames(),
      ),
      prompt: compileRolePrompt(contact, {
        ...(memory ? { memory } : {}),
        knowledge,
      }).trimEnd(),
      ceiling: contactPermissionPreset(
        contact.capabilities.permission,
        this.deps.globalPreset(),
      ),
      readOnlyRoots: knowledgeReadOnlyRoots(
        contact.role.knowledge,
        workspaceRoot,
      ),
      model: this.model(contact),
    }
  }

  /** The newest 4 KB of the contact's memory, with a lead line ('' when none). */
  private memoryText(contactId: string): string {
    const { text } = this.deps.memory.promptText(contactId)
    return text ? `${MEMORY_LEAD}\n\n${text}` : ''
  }

  private model(contact: Contact): ContactModelState {
    const model = contact.capabilities.model
    if (model === 'inherit') return { kind: 'default' }
    const route = this.deps.route(model.profileId)
    if (route === undefined)
      return { kind: 'unavailable', profileId: model.profileId }
    const effort =
      model.reasoning !== undefined &&
      route.reasoningEfforts.includes(model.reasoning)
        ? model.reasoning
        : undefined
    return {
      kind: 'profile',
      config: {
        ...this.deps.defaultCallConfig(route.id),
        ...(model.model ? { model: model.model } : {}),
        ...(effort ? { reasoningEffort: effort } : {}),
      },
    }
  }
}

/**
 * One contact session's view of its contact: read again before every step
 * ({@link refresh}), so an edit, new memory or a changed file counts from
 * the next step. It is the agent's tool filter, and gives its request config.
 */
export class ContactBinding implements ToolFilter {
  private current: ContactSnapshot | null = null

  constructor(
    readonly contactId: string,
    private readonly session: Session,
    private readonly runtime: ContactRuntime,
    private readonly workspaceRoot: () => string,
  ) {}

  refresh(): ContactSnapshot {
    this.current = this.runtime.snapshot(this.contactId, this.workspaceRoot())
    return this.current
  }

  get snapshot(): ContactSnapshot {
    return this.current ?? this.refresh()
  }

  /** ToolFilter: only the contact's tools (none once it is deleted). */
  get allow(): readonly string[] | undefined {
    return this.snapshot.tools ?? undefined
  }

  /** What an agent of this session is made with. */
  agentOptions(): Pick<AgentOptions, 'toolFilter' | 'callConfig'> {
    return { toolFilter: this, callConfig: () => this.callConfig() }
  }

  /**
   * The request config: the contact's profile; the default model when it
   * inherits, or when its profile is gone and the user allowed the default.
   */
  callConfig(): LlmCallConfig {
    const model = this.snapshot.model
    if (model.kind === 'profile') return model.config
    if (model.kind === 'unavailable' && !this.defaultAllowed(model.profileId))
      throw new ContactModelUnavailableError(model.profileId)
    return this.runtime.defaultCallConfig()
  }

  /** The gone profile, while the user has not allowed the default model. */
  missingModel(): string | null {
    const model = this.snapshot.model
    return model.kind === 'unavailable' && !this.defaultAllowed(model.profileId)
      ? model.profileId
      : null
  }

  /** The user said yes: this session uses the default model for `profileId`. */
  allowDefaultModel(profileId: string): void {
    this.session.append('contact/model-fallback', {
      contactId: this.contactId,
      profileId,
    })
  }

  /** A subagent's tool filter, kept within this contact's tools. */
  narrow(filter: ToolFilter | undefined): ToolFilter | undefined {
    if (this.snapshot.tools === null) return filter
    const own = (): readonly string[] => this.allow ?? []
    return {
      get allow(): readonly string[] {
        const allowed = filter?.allow
        return allowed === undefined
          ? own()
          : own().filter((name) => allowed.includes(name))
      },
      ...(filter?.deny === undefined ? {} : { deny: filter.deny }),
    }
  }

  private defaultAllowed(profileId: string): boolean {
    return this.session.events.some(
      (event) =>
        event.type === 'contact/model-fallback' &&
        event.data.profileId === profileId,
    )
  }
}
