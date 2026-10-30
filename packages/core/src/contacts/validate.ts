import { createHash } from 'node:crypto'
import { statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { isSkillName } from '../skills/name'
import { ContactValidationError } from './errors'
import {
  CONTACT_LIMITS,
  CONTACT_PERMISSIONS,
  DOMAINS,
  EXTERNAL_BACKENDS,
  EXTERNAL_CAPABILITIES,
  LIBRARY_AVATAR_ID,
  MASCOT_POSE,
  PORTRAIT_COUNT,
  REASONING_LEVELS,
  REPLY_LENGTHS,
  SPEAK_MODES,
  TOOL_PRESETS,
  type Capabilities,
  type Contact,
  type ContactAvatar,
  type ContactKnowledge,
  type ContactMcpSelection,
  type ContactModel,
  type ContactPermission,
  type ContactSkillSelection,
  type ContactTools,
  type Domain,
  type GroupHabit,
  type KnowledgeRef,
  type KnowledgeUse,
  type RoleCard,
  type RoleExample,
} from './types'

/** `ct-` + lowercase letters, digits and dashes (builtins: `ct-claude-code`). */
export const CONTACT_ID = /^ct-[a-z0-9-]{1,48}$/
export const TEMPLATE_ID = /^[a-z][a-z0-9-]{0,63}$/
/** Tool names as the registry spells them (builtins, MCP `mcp__server__tool`). */
const TOOL_NAME = /^[A-Za-z0-9_.:-]{1,128}$/
const RESOURCE_ID = /^kr-[a-z0-9]{6,40}$/
const SKILL_ID = /^sk-[a-z0-9]{6,40}$/
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/

/** Characters as the user counts them: a Chinese character is one. */
export function charCount(text: string): number {
  return Array.from(text).length
}

function fail(field: string, message: string): never {
  throw new ContactValidationError(field, message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
  label: string,
): T {
  if (
    typeof value === 'string' &&
    (allowed as readonly string[]).includes(value)
  )
    return value as T
  return fail(field, `${label}不对：${String(value)}`)
}

function text(
  value: unknown,
  field: string,
  label: string,
  limit: number,
): string {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') fail(field, `${label}必须是文字`)
  const trimmed = value.trim()
  if (charCount(trimmed) > limit)
    fail(field, `${label}最多 ${limit} 字（现在 ${charCount(trimmed)} 字）`)
  return trimmed
}

function finite(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
    fail(field, `${field} 必须是非负数`)
  return value
}

export function normalizeName(value: unknown): string {
  if (typeof value !== 'string') return fail('name', '名字必须是文字')
  const name = value.trim()
  if (!name) fail('name', '名字不能为空')
  if (charCount(name) > CONTACT_LIMITS.name)
    fail(
      'name',
      `名字最多 ${CONTACT_LIMITS.name} 字（现在 ${charCount(name)} 字）`,
    )
  if (CONTROL.test(name)) fail('name', '名字不能换行')
  // Members are @-mentioned by name in group chat.
  if (name.includes('@')) fail('name', '名字里不能有 @')
  return name
}

export function normalizeIntro(value: unknown): string {
  const intro = text(value, 'intro', '简介', CONTACT_LIMITS.intro)
  if (/[\r\n]/.test(intro)) fail('intro', '简介只写一行')
  return intro
}

export function normalizeAvatar(value: unknown): ContactAvatar {
  if (!isRecord(value)) return fail('avatar', '头像不对')
  switch (value.kind) {
    case 'portrait': {
      const index = value.index
      if (
        typeof index !== 'number' ||
        !Number.isInteger(index) ||
        index < 0 ||
        index >= PORTRAIT_COUNT
      )
        fail('avatar', `头像编号要在 0–${PORTRAIT_COUNT - 1} 之间`)
      return { kind: 'portrait', index }
    }
    case 'logo':
      return {
        kind: 'logo',
        backend: oneOf(value.backend, EXTERNAL_BACKENDS, 'avatar', '标志'),
      }
    case 'library':
      if (typeof value.id !== 'string' || !LIBRARY_AVATAR_ID.test(value.id))
        fail('avatar', `头像库里没有 ${String(value.id)}`)
      return { kind: 'library', id: value.id }
    case 'mascot':
      if (typeof value.pose !== 'string' || !MASCOT_POSE.test(value.pose))
        fail('avatar', `吉祥物姿势不对：${String(value.pose)}`)
      return { kind: 'mascot', pose: value.pose }
    default:
      return fail('avatar', `头像类型不对：${String(value.kind)}`)
  }
}

export function normalizeDomains(value: unknown): Domain[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) return fail('domains', '领域必须是列表')
  if (value.length > CONTACT_LIMITS.domains)
    fail('domains', `领域最多 ${CONTACT_LIMITS.domains} 个`)
  const domains = value.map((item) => oneOf(item, DOMAINS, 'domains', '领域'))
  if (new Set(domains).size !== domains.length) fail('domains', '领域重复了')
  return domains
}

function normalizeKnowledge(value: unknown): KnowledgeRef {
  const field = 'role.knowledge'
  if (!isRecord(value)) return fail(field, '参考资料不对')
  switch (value.kind) {
    case 'file':
    case 'folder': {
      const path = value.path
      if (typeof path !== 'string' || !path.trim())
        fail(field, '参考资料要写路径')
      if (path.length > CONTACT_LIMITS.path) fail(field, '参考资料的路径太长')
      if (!isAbsolute(path)) fail(field, `参考资料要写绝对路径：${path}`)
      if (value.pinned !== undefined && typeof value.pinned !== 'boolean')
        fail(field, '「置顶」只能是开或关')
      return {
        kind: value.kind,
        path,
        ...(value.pinned === true ? { pinned: true } : {}),
      }
    }
    case 'url': {
      const url = value.url
      if (typeof url !== 'string' || url.length > CONTACT_LIMITS.url)
        fail(field, '网址不对')
      let parsed: URL | null = null
      try {
        parsed = new URL(url)
      } catch {
        parsed = null
      }
      if (parsed === null || parsed.protocol !== 'https:')
        fail(field, `只收 https 网址：${url}`)
      return { kind: 'url', url }
    }
    case 'skill':
      if (!isSkillName(value.name))
        fail(field, `Skill 名字不对：${String(value.name)}`)
      return { kind: 'skill', name: value.name }
    default:
      return fail(field, `参考资料类型不对：${String(value.kind)}`)
  }
}

/** A stable id for a resource that the old file did not give one. */
export function stableResourceId(prefix: 'kr' | 'sk', key: string): string {
  const digest = createHash('sha256').update(key).digest('hex').slice(0, 12)
  return `${prefix}-${digest}`
}

function knowledgeUse(value: unknown, field: string): KnowledgeUse {
  if (value === undefined) return 'on_demand'
  if (value === true) return 'pinned'
  return oneOf(value, ['on_demand', 'pinned'] as const, field, '使用方式')
}

function normalizeContactKnowledge(value: unknown): ContactKnowledge[] {
  const field = 'knowledge'
  if (value === undefined) return []
  if (!Array.isArray(value)) fail(field, '知识必须是列表')
  if (value.length > CONTACT_LIMITS.knowledge)
    fail(field, `知识最多 ${CONTACT_LIMITS.knowledge} 条`)
  const seen = new Set<string>()
  return value.map((item) => {
    if (!isRecord(item)) fail(field, '知识条目不对')
    const kind = oneOf(
      item.kind,
      ['file', 'folder', 'url', 'note'] as const,
      `${field}.kind`,
      '知识类型',
    )
    if (kind === 'file' || kind === 'folder') {
      const path = item.path
      if (typeof path !== 'string' || !path.trim()) fail(field, '知识要写路径')
      if (path.length > CONTACT_LIMITS.path) fail(field, '知识的路径太长')
      if (!isAbsolute(path)) fail(field, `知识要写绝对路径：${path}`)
      const key = `${kind}:${path}`
      if (seen.has(key)) fail(field, `知识重复了：${path}`)
      seen.add(key)
      return {
        id:
          typeof item.id === 'string' && RESOURCE_ID.test(item.id)
            ? item.id
            : stableResourceId('kr', key),
        kind,
        path,
        use: knowledgeUse(item.use ?? item.pinned, field),
      }
    }
    if (kind === 'url') {
      const url = item.url
      if (typeof url !== 'string' || url.length > CONTACT_LIMITS.url)
        fail(field, '网址不对')
      let parsed: URL | null = null
      try {
        parsed = new URL(url)
      } catch {
        parsed = null
      }
      if (parsed === null || parsed.protocol !== 'https:')
        fail(field, `只收 https 网址：${url}`)
      const key = `url:${url}`
      if (seen.has(key)) fail(field, `知识重复了：${url}`)
      seen.add(key)
      return {
        id:
          typeof item.id === 'string' && RESOURCE_ID.test(item.id)
            ? item.id
            : stableResourceId('kr', key),
        kind: 'url',
        url,
        use: 'on_demand',
      }
    }
    const title = text(
      item.title,
      `${field}.title`,
      '知识的标题',
      CONTACT_LIMITS.knowledgeTitle,
    )
    if (!title) fail(field, '知识笔记要有标题')
    const note = text(
      item.text,
      `${field}.text`,
      '知识笔记',
      CONTACT_LIMITS.knowledgeNote,
    )
    if (!note) fail(field, '知识笔记不能为空')
    const key = `note:${title}`
    if (seen.has(key)) fail(field, `知识重复了：${title}`)
    seen.add(key)
    return {
      id:
        typeof item.id === 'string' && RESOURCE_ID.test(item.id)
          ? item.id
          : stableResourceId('kr', key),
      kind: 'note',
      title,
      text: note,
      use: knowledgeUse(item.use, field),
    }
  })
}

function normalizeSkills(value: unknown): ContactSkillSelection[] {
  const field = 'skills'
  if (value === undefined) return []
  if (!Array.isArray(value)) fail(field, '工作技能必须是列表')
  if (value.length > CONTACT_LIMITS.skills)
    fail(field, `工作技能最多 ${CONTACT_LIMITS.skills} 个`)
  const ids = new Set<string>()
  const names = new Set<string>()
  return value.map((item) => {
    if (!isRecord(item)) fail(field, '工作技能不对')
    if (!isSkillName(item.name))
      fail(field, `Skill 名字不对：${String(item.name)}`)
    const sourceId = text(item.sourceId, `${field}.sourceId`, '来源', 128)
    if (!sourceId) fail(field, '工作技能要有来源')
    const key = `${sourceId}:${item.name}`
    if (names.has(key)) fail(field, `工作技能重复了：${item.name}`)
    names.add(key)
    const id =
      typeof item.id === 'string' && SKILL_ID.test(item.id)
        ? item.id
        : stableResourceId('sk', key)
    if (ids.has(id)) fail(field, `工作技能编号重复了：${id}`)
    ids.add(id)
    return { id, sourceId, name: item.name }
  })
}

function normalizeMcp(value: unknown): ContactMcpSelection[] {
  const field = 'mcp'
  if (value === undefined) return []
  if (!Array.isArray(value)) fail(field, '外部连接必须是列表')
  if (value.length > CONTACT_LIMITS.mcpServers)
    fail(field, `外部连接最多 ${CONTACT_LIMITS.mcpServers} 个`)
  const servers = new Set<string>()
  return value.map((item) => {
    if (!isRecord(item)) fail(field, '外部连接不对')
    if (
      typeof item.serverId !== 'string' ||
      !item.serverId.trim() ||
      charCount(item.serverId) > 128 ||
      CONTROL.test(item.serverId)
    )
      fail(field, '外部连接的名字不对')
    if (servers.has(item.serverId))
      fail(field, `外部连接重复了：${item.serverId}`)
    servers.add(item.serverId)
    const tools = item.toolNames ?? []
    if (!Array.isArray(tools)) fail(field, '工具必须是列表')
    if (tools.length > CONTACT_LIMITS.mcpTools)
      fail(field, `每个外部连接最多 ${CONTACT_LIMITS.mcpTools} 个工具`)
    const seen = new Set<string>()
    const toolNames = tools.map((name) => {
      if (
        typeof name !== 'string' ||
        !name.trim() ||
        charCount(name) > 128 ||
        CONTROL.test(name)
      )
        fail(field, '工具名字不对')
      if (seen.has(name)) fail(field, `工具重复了：${name}`)
      seen.add(name)
      return name
    })
    return { serverId: item.serverId, toolNames }
  })
}

/** Schema 2's role-card knowledge, split into the schema 3 lists. */
function migrateLegacyKnowledge(refs: readonly KnowledgeRef[]): {
  knowledge: ContactKnowledge[]
  skills: ContactSkillSelection[]
} {
  const knowledge: ContactKnowledge[] = []
  const skills: ContactSkillSelection[] = []
  for (const ref of refs) {
    if (ref.kind === 'skill') {
      skills.push({
        id: stableResourceId('sk', `legacy:${ref.name}`),
        sourceId: 'legacy',
        name: ref.name,
      })
      continue
    }
    knowledge.push(
      normalizeContactKnowledge([
        ref.kind === 'url'
          ? { kind: 'url', url: ref.url }
          : {
              kind: ref.kind,
              path: ref.path,
              use: ref.pinned === true ? 'pinned' : 'on_demand',
            },
      ])[0]!,
    )
  }
  return { knowledge, skills }
}

function normalizeExample(value: unknown): RoleExample {
  const field = 'role.examples'
  if (!isRecord(value)) return fail(field, '示例不对')
  const input = text(value.input, field, '示例的输入', CONTACT_LIMITS.example)
  const output = text(value.output, field, '示例的输出', CONTACT_LIMITS.example)
  if (!input || !output) fail(field, '示例要有输入和输出')
  return { input, output }
}

export function normalizeRole(value: unknown): RoleCard {
  if (!isRecord(value)) return fail('role', '岗位说明书不对')
  const knowledge = value.knowledge ?? []
  if (!Array.isArray(knowledge)) fail('role.knowledge', '参考资料必须是列表')
  if (knowledge.length > CONTACT_LIMITS.knowledge)
    fail('role.knowledge', `参考资料最多 ${CONTACT_LIMITS.knowledge} 条`)
  const examples = value.examples ?? []
  if (!Array.isArray(examples)) fail('role.examples', '示例必须是列表')
  if (examples.length > CONTACT_LIMITS.examples)
    fail('role.examples', `示例最多 ${CONTACT_LIMITS.examples} 个`)
  const trialTask = text(
    value.trialTask,
    'role.trialTask',
    '样例任务',
    CONTACT_LIMITS.trialTask,
  )
  const role: RoleCard = {
    mission: text(
      value.mission,
      'role.mission',
      '职责',
      CONTACT_LIMITS.mission,
    ),
    deliverable: text(
      value.deliverable,
      'role.deliverable',
      '交付',
      CONTACT_LIMITS.deliverable,
    ),
    playbook: text(
      value.playbook,
      'role.playbook',
      '工作方法',
      CONTACT_LIMITS.playbook,
    ),
    boundaries: text(
      value.boundaries,
      'role.boundaries',
      '边界',
      CONTACT_LIMITS.boundaries,
    ),
    knowledge: knowledge.map(normalizeKnowledge),
  }
  if (examples.length) role.examples = examples.map(normalizeExample)
  if (trialTask) role.trialTask = trialTask
  return role
}

function normalizeModel(value: unknown): ContactModel {
  const field = 'capabilities.model'
  if (value === undefined || value === 'inherit') return 'inherit'
  if (!isRecord(value)) return fail(field, '模型不对')
  const profileId = text(
    value.profileId,
    field,
    '模型档案',
    CONTACT_LIMITS.profileId,
  )
  if (!profileId) fail(field, '要选一个模型档案')
  const model = text(value.model, field, '模型', CONTACT_LIMITS.model)
  return {
    profileId,
    ...(model ? { model } : {}),
    ...(value.reasoning !== undefined
      ? {
          reasoning: oneOf(
            value.reasoning,
            REASONING_LEVELS,
            field,
            '推理强度',
          ),
        }
      : {}),
  }
}

function toolList(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) return fail(field, '工具必须是列表')
  if (value.length > CONTACT_LIMITS.tools)
    fail(field, `工具最多 ${CONTACT_LIMITS.tools} 个`)
  for (const name of value)
    if (typeof name !== 'string' || !TOOL_NAME.test(name))
      fail(field, `工具名不对：${String(name)}`)
  const names = value as string[]
  if (new Set(names).size !== names.length) fail(field, '工具重复了')
  return names.length ? names : undefined
}

function normalizeTools(value: unknown): ContactTools {
  const field = 'capabilities.tools'
  if (!isRecord(value)) return fail(field, '工具设置不对')
  const allow = toolList(value.allow, `${field}.allow`)
  const deny = toolList(value.deny, `${field}.deny`)
  const both = allow?.filter((name) => deny?.includes(name)) ?? []
  if (both.length) fail(field, `同一个工具不能既允许又禁止：${both.join('、')}`)
  return {
    preset: oneOf(value.preset, TOOL_PRESETS, `${field}.preset`, '工具预设'),
    ...(allow ? { allow } : {}),
    ...(deny ? { deny } : {}),
  }
}

export function normalizeCapabilities(value: unknown): Capabilities {
  if (!isRecord(value)) return fail('capabilities', '能力设置不对')
  return {
    model: normalizeModel(value.model),
    tools: normalizeTools(value.tools),
    permission: oneOf(
      value.permission,
      CONTACT_PERMISSIONS,
      'capabilities.permission',
      '权限',
    ),
  }
}

export function normalizeGroupHabit(value: unknown): GroupHabit {
  if (!isRecord(value)) return fail('groupHabit', '群聊习惯不对')
  return {
    speak: oneOf(value.speak, SPEAK_MODES, 'groupHabit.speak', '发言时机'),
    length: oneOf(value.length, REPLY_LENGTHS, 'groupHabit.length', '篇幅'),
  }
}

/** Whether two plain JSON values are equal, whatever their key order. */
export function sameValue(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right)
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (isRecord(value))
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`
  return JSON.stringify(value) ?? 'null'
}

/**
 * A complete contact with every limit of the role card checked and every
 * text trimmed; unknown keys are dropped. Throws {@link ContactValidationError}.
 */
export function normalizeContact(value: unknown): Contact {
  if (!isRecord(value)) return fail('contact', '联系人不对')
  if (typeof value.id !== 'string' || !CONTACT_ID.test(value.id))
    fail('id', `联系人编号不对：${String(value.id)}`)
  const kind = oneOf(value.kind, ['local', 'external'] as const, 'kind', '类型')
  let backend: Contact['backend']
  if (kind === 'external')
    backend = oneOf(value.backend, EXTERNAL_BACKENDS, 'backend', '外部子智能体')
  else if (value.backend !== undefined)
    fail('backend', '只有外部联系人才对应 Claude Code 或 Codex')
  const role = normalizeRole(value.role)
  const legacy = role.knowledge ?? []
  const migrated = migrateLegacyKnowledge(legacy)
  const givenKnowledge = normalizeContactKnowledge(value.knowledge)
  const givenSkills = normalizeSkills(value.skills)
  // An old editor sends role.knowledge; a new one sends its own lists. Empty
  // new lists (the store's build fills them) do not hide the old entries.
  const knowledge = givenKnowledge.length
    ? givenKnowledge
    : migrated.knowledge.length
      ? migrated.knowledge
      : givenKnowledge
  const skills = givenSkills.length
    ? givenSkills
    : migrated.skills.length
      ? migrated.skills
      : givenSkills
  const mcp = normalizeMcp(value.mcp)
  const { knowledge: _legacy, ...roleCard } = role
  const capabilities = normalizeCapabilities(value.capabilities)
  if (kind === 'external' && !sameValue(capabilities, EXTERNAL_CAPABILITIES))
    fail(
      'capabilities',
      '外部联系人的模型和权限跟随子智能体设置，不在联系人上改',
    )
  if (!isRecord(value.memory) || typeof value.memory.enabled !== 'boolean')
    fail('memory', '个人记忆只能是开或关')
  const version = value.version
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1)
    fail('version', '版本号不对')
  if (
    value.templateId !== undefined &&
    (typeof value.templateId !== 'string' ||
      !TEMPLATE_ID.test(value.templateId))
  )
    fail('templateId', `模板编号不对：${String(value.templateId)}`)
  if (typeof value.builtin !== 'boolean') fail('builtin', '内置标记不对')
  return {
    id: value.id,
    kind,
    ...(backend ? { backend } : {}),
    name: normalizeName(value.name),
    avatar: normalizeAvatar(value.avatar),
    intro: normalizeIntro(value.intro),
    domains: normalizeDomains(value.domains),
    role: roleCard,
    knowledge,
    skills,
    mcp,
    capabilities,
    groupHabit: normalizeGroupHabit(value.groupHabit),
    memory: { enabled: value.memory.enabled },
    version,
    ...(value.templateId !== undefined
      ? { templateId: value.templateId as string }
      : {}),
    builtin: value.builtin,
    createdAt: finite(value.createdAt, 'createdAt'),
    updatedAt: finite(value.updatedAt, 'updatedAt'),
  }
}

export interface ContactContext {
  /** The other contacts (names must differ from theirs, ignoring case). */
  others: readonly Contact[]
  /** Every tool name the registry has. */
  toolNames: ReadonlySet<string>
  /** 设置 › 常规 › 会话 › 新会话的权限 (`read-only` / `workspace-write` / …). */
  globalPermission: string
}

const PRESET_RANK: Readonly<Record<string, number>> = {
  'read-only': 0,
  'workspace-write': 1,
  'danger-full-access': 2,
}
const PERMISSION_RANK: Readonly<Record<ContactPermission, number>> = {
  inherit: 0,
  read_only: 0,
  workspace_write: 1,
}

/** A permission no higher than the global preset (an unknown preset is read-only). */
export function permissionAllowed(
  permission: ContactPermission,
  globalPermission: string,
): boolean {
  return PERMISSION_RANK[permission] <= (PRESET_RANK[globalPermission] ?? 0)
}

/**
 * The rules that depend on the world around the contact: a unique name,
 * knowledge that exists on disk, registered tool names, and a permission
 * no higher than the global preset.
 */
export function checkContactContext(
  contact: Contact,
  context: ContactContext,
): void {
  const lower = contact.name.toLowerCase()
  if (
    context.others.some(
      (other) => other.id !== contact.id && other.name.toLowerCase() === lower,
    )
  )
    fail('name', `已经有叫「${contact.name}」的联系人了`)

  for (const ref of contact.knowledge ?? []) {
    if (ref.kind !== 'file' && ref.kind !== 'folder') continue
    let stat: ReturnType<typeof statSync> | null = null
    try {
      stat = statSync(ref.path)
    } catch {
      stat = null
    }
    if (stat === null) fail('knowledge', `知识不存在：${ref.path}`)
    if (ref.kind === 'file' && !stat.isFile())
      fail('knowledge', `不是文件：${ref.path}`)
    if (ref.kind === 'folder' && !stat.isDirectory())
      fail('knowledge', `不是文件夹：${ref.path}`)
  }

  checkCapabilityContext(contact, context)
}

/**
 * The rules of a contact's capabilities that depend on the install: tool
 * names the registry has, and a permission no higher than the global
 * preset. The trial bench and the prompt preview check only these (GRP-04).
 */
export function checkCapabilityContext(
  contact: Contact,
  context: Pick<ContactContext, 'toolNames' | 'globalPermission'>,
): void {
  if (contact.kind === 'local') {
    for (const key of ['allow', 'deny'] as const) {
      const unknown = (contact.capabilities.tools[key] ?? []).filter(
        (name) => !context.toolNames.has(name),
      )
      if (unknown.length)
        fail(`capabilities.tools.${key}`, `没有这些工具：${unknown.join('、')}`)
    }
    if (
      !permissionAllowed(
        contact.capabilities.permission,
        context.globalPermission,
      )
    )
      fail(
        'capabilities.permission',
        '联系人的权限不能高于新会话的权限（设置 › 常规 › 会话）',
      )
  }
}
