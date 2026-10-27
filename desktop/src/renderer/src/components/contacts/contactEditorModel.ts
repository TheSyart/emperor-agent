/**
 * The contact editor's state (GRP-04, docs/design/agent-contacts.md): the
 * unsaved contact the seven sections edit, the four ways it starts (a role
 * template, a description Emperor drafts from, an imported agent file, a
 * copy), the 「AI 起草」 marks, the five completeness rules (they never
 * block saving), the character limits Core applies, the tool chips, and
 * what goes to Core — `contacts.create` / `contacts.update` when saving,
 * the draft itself for the trial bench and the prompt preview. Pure: the
 * components own the Core calls.
 */
import type {
  AgentFileImport,
  BriefDraft,
  Contact,
  ContactAvatar,
  ContactCapabilities,
  ContactDomain,
  ContactDraftInput,
  ContactGroupHabit,
  ContactRoleCard,
  ContactTemplate,
  ContactToolPreset,
  DraftSection,
} from '@emperor/core/api'

/** The four ways to start a new contact (D5). */
export type ContactMethod = 'template' | 'brief' | 'import' | 'copy'

/** The seven sections, in order (预览 B 第 1 步). */
export const SECTION_KEYS = [
  'identity',
  'mission',
  'playbook',
  'knowledge',
  'boundaries',
  'capabilities',
  'groupHabit',
] as const
export type SectionKey = (typeof SECTION_KEYS)[number]

/** The limits Core applies (packages/core/src/contacts/types.ts). */
export const LIMITS = Object.freeze({
  name: 24,
  intro: 60,
  domains: 3,
  mission: 2000,
  deliverable: 2000,
  playbook: 4000,
  boundaries: 2000,
  knowledge: 20,
  trialTask: 1000,
})

export type ContactTools = ContactCapabilities['tools']
export type ToolPresetTable = Record<ContactToolPreset, string[]>

/** The contact the editor holds; nothing in it is saved until 保存. */
export interface EditorDraft {
  /** The saved contact being edited (none for a new one). */
  id?: string
  builtin: boolean
  kind: 'local' | 'external'
  backend?: 'claude-code' | 'codex'
  templateId?: string
  name: string
  avatar: ContactAvatar
  intro: string
  domains: ContactDomain[]
  role: ContactRoleCard
  capabilities: ContactCapabilities
  groupHabit: ContactGroupHabit
  memory: { enabled: boolean }
  /** The saved version (for the prompt preview's caption). */
  version?: number
}

/** A deep copy of plain data (Vue's reactive proxies included). */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/** What a failed Core call says (invokeCore has put it in Chinese already). */
export function failureText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  return typeof error === 'string' && error ? error : '没有成功，再试一次。'
}

export function charCount(text: string): number {
  return Array.from(text).length
}

/** 「12 / 24」, and how far over the limit it is. */
export function charHint(
  text: string,
  limit: number,
): { text: string; over: boolean } {
  const count = charCount(text.trim())
  const over = count > limit
  return {
    text: over
      ? `${count} / ${limit} · 超过 ${count - limit} 字`
      : `${count} / ${limit}`,
    over,
  }
}

function emptyRole(): ContactRoleCard {
  return {
    mission: '',
    deliverable: '',
    playbook: '',
    boundaries: '',
    knowledge: [],
  }
}

/** A blank contact (its avatar is replaced by a recommendation). */
export function emptyDraft(): EditorDraft {
  return {
    builtin: false,
    kind: 'local',
    name: '',
    avatar: { kind: 'library', id: 'AV-13-1' },
    intro: '',
    domains: [],
    role: emptyRole(),
    capabilities: {
      model: 'inherit',
      tools: { preset: 'read_only' },
      permission: 'inherit',
    },
    groupHabit: { speak: 'relevant', length: 'brief' },
    memory: { enabled: true },
  }
}

const PRESET_RANK: Readonly<Record<string, number>> = {
  'read-only': 0,
  'workspace-write': 1,
  'danger-full-access': 2,
}

/** Whether the global preset (新会话的权限) lets a contact write its workspace. */
export function workspaceWriteAllowed(globalPermission: string): boolean {
  return (PRESET_RANK[globalPermission] ?? 0) >= 1
}

/** `stem` cut so that `stem + suffix` fits a name. */
function fitName(stem: string, suffix: string): string {
  const room = LIMITS.name - charCount(suffix)
  return `${Array.from(stem).slice(0, room).join('').trimEnd()}${suffix}`
}

/** `base`, else `base 2`, `base 3`, … — the first no contact has (as Core names copies). */
export function freeName(
  base: string,
  contacts: readonly Pick<Contact, 'name'>[],
): string {
  const taken = new Set(contacts.map((contact) => contact.name.toLowerCase()))
  const first = fitName(base, '')
  if (!taken.has(first.toLowerCase())) return first
  for (let n = 2; ; n += 1) {
    const candidate = fitName(base, ` ${n}`)
    if (!taken.has(candidate.toLowerCase())) return candidate
  }
}

/** 从岗位模板: the template's card, default avatar and sample task. */
export function draftFromTemplate(
  template: ContactTemplate,
  context: { contacts: readonly Contact[]; globalPermission: string },
): EditorDraft {
  // A template never asks for more than the global preset allows.
  const permission =
    template.permission === 'workspace_write' &&
    !workspaceWriteAllowed(context.globalPermission)
      ? 'read_only'
      : template.permission
  return {
    ...emptyDraft(),
    name: freeName(template.name, context.contacts),
    avatar: { kind: 'library', id: template.avatar },
    intro: template.intro,
    domains: [...template.domains],
    role: clone(template.role),
    capabilities: {
      model: 'inherit',
      tools: { preset: template.tools },
      permission,
    },
    groupHabit: { speak: template.speak, length: 'brief' },
    templateId: template.id,
  }
}

/** A saved contact, as the editor edits it. */
export function draftFromContact(contact: Contact): EditorDraft {
  return {
    id: contact.id,
    builtin: contact.builtin,
    kind: contact.kind,
    ...(contact.backend ? { backend: contact.backend } : {}),
    ...(contact.templateId ? { templateId: contact.templateId } : {}),
    name: contact.name,
    avatar: clone(contact.avatar),
    intro: contact.intro,
    domains: [...contact.domains],
    role: clone(contact.role),
    capabilities: clone(contact.capabilities),
    groupHabit: { ...contact.groupHabit },
    memory: { ...contact.memory },
    version: contact.version,
  }
}

/** 复制已有联系人: a new contact like `source`, under a free name. */
export function draftCopy(
  source: Contact,
  contacts: readonly Contact[],
): EditorDraft {
  const copy = draftFromContact(source)
  delete copy.id
  delete copy.version
  return {
    ...copy,
    builtin: false,
    name: freeName(`${source.name} 副本`, contacts),
  }
}

/** 导入: the imported card over the draft (its avatar stays). */
export function draftFromImport(
  imported: AgentFileImport,
  draft: EditorDraft,
): EditorDraft {
  const next: EditorDraft = {
    ...draft,
    ...clone(imported.draft),
    builtin: false,
    kind: 'local',
  }
  delete next.templateId
  delete next.backend
  return next
}

/** 说说你要什么人: Emperor's draft over the draft, each filled section marked. */
export function applyBrief(
  draft: EditorDraft,
  brief: BriefDraft,
  sections: readonly DraftSection[],
): { draft: EditorDraft; drafted: Set<SectionKey> } {
  const role: ContactRoleCard = {
    ...draft.role,
    mission: brief.role.mission,
    deliverable: brief.role.deliverable,
    playbook: brief.role.playbook,
    boundaries: brief.role.boundaries,
  }
  if (brief.role.trialTask) role.trialTask = brief.role.trialTask
  const next: EditorDraft = {
    ...draft,
    name: brief.name || draft.name,
    intro: brief.intro,
    domains: [...brief.domains],
    role,
    capabilities: {
      ...draft.capabilities,
      tools: { preset: brief.tools },
      permission: brief.permission,
    },
    groupHabit: { ...draft.groupHabit, speak: brief.speak },
  }
  delete next.templateId
  return { draft: next, drafted: new Set(sections) }
}

/** The 「AI 起草」 marks once the user changes `section`. */
export function editSection(
  drafted: ReadonlySet<SectionKey>,
  section: SectionKey,
): Set<SectionKey> {
  const next = new Set(drafted)
  next.delete(section)
  return next
}

// ── completeness ──────────────────────────────────────────────────────

/** Numbered (`1.` `1、` `1）`) or bulleted (`-` `*` `•`) lines. */
export function playbookSteps(text: string): number {
  return text
    .split('\n')
    .filter((line) => /^\s*(?:\d+\s*[.、)）．]|[-*•·])\s*\S/.test(line)).length
}

const WRITING_TOOLS = ['write', 'edit', 'bash']

export interface CompletenessFacts {
  /** The tools the draft sees (Core's preview); null: not narrowed. */
  tools: readonly string[] | null
  /** 新会话的权限. */
  globalPermission: string
  /** A trial ran since the editor opened. */
  trialRan: boolean
}

export interface CompletenessItem {
  key: 'deliverable' | 'playbook' | 'boundaries' | 'tools' | 'trial'
  done: boolean
  label: string
}

/** The five rules (binary; a hint, never a block on saving). */
export function completeness(
  draft: EditorDraft,
  facts: CompletenessFacts,
): CompletenessItem[] {
  const steps = playbookSteps(draft.role.playbook)
  const writes = (facts.tools ?? []).some((tool) =>
    WRITING_TOOLS.includes(tool),
  )
  const permission = draft.capabilities.permission
  const readOnly =
    permission === 'read_only' ||
    (permission === 'inherit' && !workspaceWriteAllowed(facts.globalPermission))
  const rule = (
    key: CompletenessItem['key'],
    done: boolean,
    yes: string,
    no: string,
  ): CompletenessItem => ({ key, done, label: done ? yes : no })
  return [
    rule(
      'deliverable',
      draft.role.deliverable.trim() !== '',
      '写明了交付物和格式',
      '还没写交付：交出什么、什么格式',
    ),
    rule(
      'playbook',
      steps >= 2,
      '有可执行的工作步骤',
      '工作方法至少写 2 步（编号或列表）',
    ),
    rule(
      'boundaries',
      draft.role.boundaries.trim() !== '',
      '写了边界和交还条件',
      '还没写边界：不做什么、什么时候交还',
    ),
    rule(
      'tools',
      !(writes && readOnly),
      '工具与权限一致',
      '有改文件或运行命令的工具，权限却是只读',
    ),
    rule('trial', facts.trialRan, '在试用台跑过', '还没在试用台跑过'),
  ]
}

// ── tools ─────────────────────────────────────────────────────────────

/** What each tool does, in the words of the chips. */
export const TOOL_LABELS: Readonly<Record<string, string>> = {
  read: '读文件',
  glob: '找文件',
  grep: '搜索内容',
  web_search: '联网搜索',
  web_fetch: '读网页',
  write: '写文件',
  edit: '改文件',
  bash: '运行命令',
  job_output: '看后台任务',
  job_list: '列出后台任务',
  job_kill: '停止后台任务',
  todo_write: '待办清单',
  skill: '用 Skill',
}

const TOOL_ORDER = Object.keys(TOOL_LABELS)

function presetTools(tools: ContactTools, presets: ToolPresetTable): string[] {
  return tools.preset === 'custom' ? [] : (presets[tools.preset] ?? [])
}

/** preset ∪ allow − deny (as Core computes it, before the registry). */
export function effectiveTools(
  tools: ContactTools,
  presets: ToolPresetTable,
): string[] {
  const names = new Set(presetTools(tools, presets))
  for (const name of tools.allow ?? []) names.add(name)
  for (const name of tools.deny ?? []) names.delete(name)
  return [...names].sort()
}

/** One chip per tool any preset can hold, on when the contact has it. */
export function toolChips(
  tools: ContactTools,
  presets: ToolPresetTable,
): Array<{ name: string; label: string; on: boolean }> {
  const universe = new Set<string>([
    ...Object.values(presets).flat(),
    ...(tools.allow ?? []),
  ])
  const on = new Set(effectiveTools(tools, presets))
  const rank = (name: string) => {
    const index = TOOL_ORDER.indexOf(name)
    return index < 0 ? TOOL_ORDER.length : index
  }
  return [...universe]
    .sort(
      (left, right) => rank(left) - rank(right) || left.localeCompare(right),
    )
    .map((name) => ({
      name,
      label: TOOL_LABELS[name] ?? name,
      on: on.has(name),
    }))
}

/** One chip clicked: a preset tool goes to deny (and back), another to allow. */
export function toggleTool(
  tools: ContactTools,
  name: string,
  presets: ToolPresetTable,
): ContactTools {
  const base = presetTools(tools, presets)
  const allow = new Set(tools.allow ?? [])
  const deny = new Set(tools.deny ?? [])
  if (effectiveTools(tools, presets).includes(name)) {
    allow.delete(name)
    if (base.includes(name)) deny.add(name)
  } else {
    deny.delete(name)
    if (!base.includes(name)) allow.add(name)
  }
  return {
    preset: tools.preset,
    ...(allow.size ? { allow: [...allow].sort() } : {}),
    ...(deny.size ? { deny: [...deny].sort() } : {}),
  }
}

/** A new preset; 自定义 starts from the tools the contact has now. */
export function setPreset(
  tools: ContactTools,
  preset: ContactToolPreset,
  presets: ToolPresetTable,
): ContactTools {
  if (preset === tools.preset) return tools
  if (preset !== 'custom') return { preset }
  const allow = effectiveTools(tools, presets)
  return allow.length ? { preset, allow } : { preset }
}

// ── to Core ───────────────────────────────────────────────────────────

/** The fields a save, the preview and the trial send. */
function fields(draft: EditorDraft) {
  return {
    name: draft.name,
    avatar: draft.avatar,
    intro: draft.intro,
    domains: draft.domains,
    role: draft.role,
    ...(draft.kind === 'external' ? {} : { capabilities: draft.capabilities }),
    groupHabit: draft.groupHabit,
    memory: draft.memory,
  }
}

/** `contacts.create`'s input for a new contact. */
export function createInput(draft: EditorDraft) {
  return {
    ...fields(draft),
    kind: draft.kind,
    ...(draft.backend ? { backend: draft.backend } : {}),
    ...(draft.templateId ? { templateId: draft.templateId } : {}),
  }
}

/** `contacts.update`'s patch; a builtin changes its avatar and intro only. */
export function updatePatch(draft: EditorDraft) {
  if (draft.builtin) return { avatar: draft.avatar, intro: draft.intro }
  return fields(draft)
}

/** The draft for `contacts.preview` and `contacts.trial`. */
export function draftInput(draft: EditorDraft): ContactDraftInput {
  return {
    ...(draft.id ? { id: draft.id } : {}),
    ...createInput(draft),
  }
}
