/**
 * Contacts (GRP-02, D5): long-lived agents with a name, an avatar and a
 * seven-part role card (身份、职责与交付、工作方法、知识、边界、能力、群聊习惯)
 * that compiles into a fixed-structure system prompt. Stored in
 * `<stateRoot>/contacts/contacts.json` (schemaVersion 2; the V021 draft v1
 * never shipped, so there is nothing to migrate).
 */

/** `ct-` + 12 base32 characters, or one of {@link BUILTIN_CONTACT_IDS}. */
export type ContactId = string

/** The contact id of an editor draft that was never saved (GRP-04). */
export const DRAFT_CONTACT_ID = 'ct-draft'

export const BUILTIN_CONTACT_IDS = [
  'ct-emperor',
  'ct-claude-code',
  'ct-codex',
] as const
export type BuiltinContactId = (typeof BUILTIN_CONTACT_IDS)[number]

export const CONTACTS_SCHEMA_VERSION = 2

export interface ContactsFile {
  schemaVersion: typeof CONTACTS_SCHEMA_VERSION
  contacts: Contact[]
}

export const EXTERNAL_BACKENDS = ['claude-code', 'codex'] as const
export type ExternalBackend = (typeof EXTERNAL_BACKENDS)[number]

/**
 * A contact's avatar. `library` is one of the 135 Q-style heads (BRD-07,
 * `AV-01-1` … `AV-15-9`); `portrait` is one of the 36 plush heads the
 * subagents use (0–35); `logo` is a vendor mark; `mascot` is a pose of the
 * mascot (Emperor wears `crown-head`).
 */
export type ContactAvatar =
  | { kind: 'portrait'; index: number }
  | { kind: 'logo'; backend: ExternalBackend }
  | { kind: 'library'; id: string }
  | { kind: 'mascot'; pose: string }

export const PORTRAIT_COUNT = 36
export const LIBRARY_AVATAR_ID = /^AV-(0[1-9]|1[0-5])-[1-9]$/
export const MASCOT_POSE = /^[a-z0-9][a-z0-9-]{0,31}$/

/** The avatar library's themes (BRD-07 manifest `theme`). */
export const AVATAR_THEMES = [
  'engineering',
  'design',
  'content',
  'product',
  'court-civil',
  'court-military',
  'court-life',
  'court-modern',
  'animals',
  'robots',
  'people',
  'whimsy',
] as const
export type AvatarTheme = (typeof AVATAR_THEMES)[number]

/** The theme of each nine-head sheet of the library (avatar-prompts §2). */
export const AVATAR_SHEET_THEMES: Readonly<Record<string, AvatarTheme>> =
  Object.freeze({
    'AV-01': 'engineering',
    'AV-02': 'engineering',
    'AV-03': 'design',
    'AV-04': 'content',
    'AV-05': 'product',
    'AV-06': 'court-civil',
    'AV-07': 'court-military',
    'AV-08': 'court-life',
    'AV-09': 'court-modern',
    'AV-10': 'animals',
    'AV-11': 'animals',
    'AV-12': 'robots',
    'AV-13': 'people',
    'AV-14': 'people',
    'AV-15': 'whimsy',
  })

export const DOMAINS = [
  'engineering',
  'security',
  'design',
  'content',
  'product',
  'data',
  'decision',
  'other',
] as const
export type Domain = (typeof DOMAINS)[number]

export const TOOL_PRESETS = [
  'read_only',
  'research',
  'writer',
  'engineer',
  'custom',
] as const
export type ToolPreset = (typeof TOOL_PRESETS)[number]

/** A contact's permission; never above 设置 › 常规's preset for new sessions. */
export const CONTACT_PERMISSIONS = [
  'inherit',
  'read_only',
  'workspace_write',
] as const
export type ContactPermission = (typeof CONTACT_PERMISSIONS)[number]

export const REASONING_LEVELS = ['low', 'medium', 'high'] as const
export type ReasoningLevel = (typeof REASONING_LEVELS)[number]

export const SPEAK_MODES = ['mentioned', 'relevant', 'always'] as const
export type SpeakMode = (typeof SPEAK_MODES)[number]

export const REPLY_LENGTHS = ['brief', 'detailed'] as const
export type ReplyLength = (typeof REPLY_LENGTHS)[number]

export interface GroupHabit {
  speak: SpeakMode
  length: ReplyLength
}

export type KnowledgeRef =
  /** An absolute path; must exist when saved (and is checked again at run time). */
  | { kind: 'file' | 'folder'; path: string; pinned?: boolean }
  /** https only. */
  | { kind: 'url'; url: string }
  | { kind: 'skill'; name: string }

export interface RoleExample {
  input: string
  output: string
}

export interface RoleCard {
  /** 职责：负责什么。 */
  mission: string
  /** 交付：交出什么、什么格式。 */
  deliverable: string
  /** 工作方法：步骤与检查清单。 */
  playbook: string
  /** 边界：不做什么、何时交还。 */
  boundaries: string
  knowledge: KnowledgeRef[]
  examples?: RoleExample[]
  /** 试用台的样例任务。 */
  trialTask?: string
}

export type ContactModel =
  'inherit' | { profileId: string; model?: string; reasoning?: ReasoningLevel }

export interface ContactTools {
  preset: ToolPreset
  allow?: string[]
  deny?: string[]
}

export interface Capabilities {
  model: ContactModel
  tools: ContactTools
  permission: ContactPermission
}

export interface Contact {
  id: ContactId
  kind: 'local' | 'external'
  /** External contacts only. */
  backend?: ExternalBackend
  /** Trimmed, 1–24 characters, unique ignoring case. */
  name: string
  avatar: ContactAvatar
  /** One line, at most 60 characters. */
  intro: string
  /** At most 3. */
  domains: Domain[]
  role: RoleCard
  /** External contacts keep {@link EXTERNAL_CAPABILITIES}: their executor's settings rule. */
  capabilities: Capabilities
  groupHabit: GroupHabit
  memory: { enabled: boolean }
  /**
   * +1 on every change to what the contact does: anything its compiled
   * prompt shows or its capabilities (the avatar alone is not one).
   */
  version: number
  templateId?: string
  builtin: boolean
  createdAt: number
  updatedAt: number
}

export const CONTACT_LIMITS = Object.freeze({
  name: 24,
  intro: 60,
  domains: 3,
  mission: 2000,
  deliverable: 2000,
  playbook: 4000,
  boundaries: 2000,
  knowledge: 20,
  examples: 3,
  example: 2000,
  trialTask: 1000,
  path: 4096,
  url: 2048,
  tools: 64,
  profileId: 128,
  model: 256,
  /** Old versions kept per contact. */
  versions: 20,
})

/** Model and permission of Claude Code / Codex follow 设置 › 子智能体. */
export const EXTERNAL_CAPABILITIES: Readonly<Capabilities> = Object.freeze({
  model: 'inherit',
  tools: Object.freeze({ preset: 'engineer' }) as ContactTools,
  permission: 'inherit',
})

/** What the template picker offers a model (no product names). */
export const MODEL_HINTS = [
  'reasoning',
  'balanced',
  'fast',
  'vision',
  'long_context',
] as const
export type ModelHint = (typeof MODEL_HINTS)[number]

/** A role template (`templates/contacts/<id>.md`). */
export interface ContactTemplate {
  id: string
  name: string
  intro: string
  domains: Domain[]
  tools: ToolPreset
  permission: Exclude<ContactPermission, 'inherit'>
  speak: SpeakMode
  modelHint: ModelHint
  /** The avatar library theme GRP-04 recommends from; also the picker group. */
  avatarTheme: AvatarTheme
  /** The default library avatar (BRD-07). */
  avatar: string
  role: RoleCard
}

/** The group a member speaks in (GRP-06 owns the full charter). */
export interface GroupCharter {
  /** 群名. */
  title?: string
  /** 群公告：目标、约束. */
  charter?: string
}

// ── inputs ────────────────────────────────────────────────────────────

export interface ContactInput {
  name: string
  kind?: 'local' | 'external'
  backend?: ExternalBackend
  avatar?: ContactAvatar
  intro?: string
  domains?: Domain[]
  role?: Partial<RoleCard>
  capabilities?: Partial<Capabilities>
  groupHabit?: Partial<GroupHabit>
  memory?: { enabled: boolean }
  templateId?: string
}

/** A partial change; `role`, `capabilities` and `groupHabit` merge one level deep. */
export interface ContactPatch {
  name?: string
  avatar?: ContactAvatar
  intro?: string
  domains?: Domain[]
  role?: Partial<RoleCard>
  capabilities?: Partial<Capabilities>
  groupHabit?: Partial<GroupHabit>
  memory?: { enabled: boolean }
}

export interface FromTemplateInput {
  templateId: string
  name?: string
  avatar?: ContactAvatar
  /** Put the role on Claude Code or Codex (D16). */
  backend?: ExternalBackend
}

// ── results ───────────────────────────────────────────────────────────

export interface ContactsReadOnly {
  /** `corrupt`: the file was backed up; `newer`: a newer Emperor wrote it. */
  reason: 'corrupt' | 'newer'
  message: string
  backupPath: string | null
}

export interface ContactsListing {
  contacts: Contact[]
  /** Set when changes are refused; the three builtins stay available. */
  readOnly: ContactsReadOnly | null
}

export interface ContactVersionEntry {
  version: number
  savedAt: number
  contact: Contact
}

export interface ContactsChange {
  reason: 'created' | 'updated' | 'deleted' | 'restored'
  contactId: ContactId
  /** The version after the change; null once deleted. */
  version: number | null
}

// ── the editor (GRP-04) ───────────────────────────────────────────────

/**
 * An unsaved contact as an import fills it: what the editor shows before
 * anything is saved (`contacts.create` takes it as it is).
 */
export interface ContactDraft {
  name: string
  intro: string
  domains: Domain[]
  role: RoleCard
  capabilities: Capabilities
  groupHabit: GroupHabit
}

/**
 * The editor's contact as the trial bench and the prompt preview take it:
 * create's fields, all optional, plus the id of the saved contact being
 * edited (its memory comes along; it is never changed).
 */
export interface ContactDraftInput extends Partial<Omit<ContactInput, 'name'>> {
  id?: ContactId
  name?: string
}

/** The compiled prompt of a draft, exactly as a session would get it. */
export interface ContactPreview {
  /** The persona section the draft's sessions run with. */
  prompt: string
  /** Characters of {@link prompt}, as the user counts them. */
  chars: number
  /** The tools the draft sees; null: not narrowed (Emperor, external contacts). */
  tools: string[] | null
  /** Each preset's tools as this install has them. */
  presets: Record<ToolPreset, string[]>
}

/** One trial bench run (`contacts.trial`). */
export interface ContactTrialResult {
  trialId: string
  /** `stopped`: the user stopped it or closed the editor. */
  status: 'completed' | 'stopped' | 'failed'
  /** The contact's answer; what went wrong when it failed. */
  text: string
  /** In USD; null when a call's price is unknown. */
  costUsd: number | null
  usage: { inputTokens: number; outputTokens: number }
  durationMs: number
  /** When it finished (epoch ms). */
  at: number
}
