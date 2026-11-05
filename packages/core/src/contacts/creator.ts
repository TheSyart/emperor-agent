/**
 * The fixed role creator (CG-CT-01). Its model can inspect the installed
 * capability catalog and submit an unsaved draft; only the renderer's
 * explicit confirmation calls ContactStore.create/update. This module has
 * no write path to contacts.json.
 */
import { z } from 'zod'
import type { Agent } from '../harness/agent/agent'
import {
  defineTool,
  ToolError,
  type ToolDefinition,
} from '../harness/tools/definition'
import type { Session } from '../session-log/session'
import { ContactValidationError } from './errors'
import type { ContactStore } from './store'
import {
  DOMAINS,
  REASONING_LEVELS,
  ROLE_CREATOR_CONTACT_ID,
  SPEAK_MODES,
  TOOL_PRESETS,
  type Contact,
  type ContactDraftInput,
  type ContactPatch,
} from './types'

export { ROLE_CREATOR_CONTACT_ID } from './types'
export const ROLE_CREATOR_DRAFT_TOOL = 'contact_role_draft'
export const ROLE_CREATOR_CATALOG_TOOL = 'contact_role_catalog'
export const ROLE_CREATOR_META_KIND = 'contact-role-draft' as const

export type RoleCreatorIntent =
  { action: 'create' } | { action: 'edit'; targetId: string }

declare module '../session-log/types' {
  interface SessionEventMap {
    /** Last routine New/Edit entry that opened this creator session. */
    'contact/creator-intent': RoleCreatorIntent
  }
}

export function roleCreatorIntent(
  session: Session | undefined,
): RoleCreatorIntent | null {
  if (!session) return null
  for (let index = session.events.length - 1; index >= 0; index -= 1) {
    const event = session.events[index]!
    if (event.type === 'contact/creator-intent') return event.data
  }
  return null
}

export function recordRoleCreatorIntent(
  session: Session,
  intent: RoleCreatorIntent,
): void {
  const current = roleCreatorIntent(session)
  if (
    (current?.action === 'create' && intent.action === 'create') ||
    (current?.action === 'edit' &&
      intent.action === 'edit' &&
      current.targetId === intent.targetId)
  )
    return
  session.append('contact/creator-intent', intent)
}

export interface RoleCreatorSkill {
  name: string
  sourceId: string
  description?: string
}

export interface RoleCreatorMcpServer {
  serverId: string
  state: string
  tools: string[]
}

export interface RoleCreatorCatalog {
  contacts: { id: string; name: string; intro: string }[]
  skills: RoleCreatorSkill[]
  mcp: RoleCreatorMcpServer[]
}

const avatarSchema = z
  .object({
    kind: z.literal('library'),
    id: z.string().regex(/^AV-(0[1-9]|1[0-5])-[1-9]$/),
  })
  .strict()
const roleSchema = z
  .object({
    mission: z.string().max(4000).optional(),
    deliverable: z.string().max(4000).optional(),
    playbook: z.string().max(8000).optional(),
    boundaries: z.string().max(4000).optional(),
    trialTask: z.string().max(2000).optional(),
    examples: z
      .array(
        z
          .object({ input: z.string().max(4000), output: z.string().max(4000) })
          .strict(),
      )
      .max(3)
      .optional(),
  })
  .strict()
const knowledgeSchema = z.discriminatedUnion('kind', [
  z
    .object({
      id: z.string().max(40).optional(),
      kind: z.enum(['file', 'folder']),
      path: z.string().max(4096),
      use: z.enum(['on_demand', 'pinned']).optional(),
    })
    .strict(),
  z
    .object({
      id: z.string().max(40).optional(),
      kind: z.literal('url'),
      url: z.string().max(2048),
      use: z.literal('on_demand').optional(),
    })
    .strict(),
  z
    .object({
      id: z.string().max(40).optional(),
      kind: z.literal('note'),
      title: z.string().max(100),
      text: z.string().max(4000),
      use: z.enum(['on_demand', 'pinned']).optional(),
    })
    .strict(),
])
const capabilitiesSchema = z
  .object({
    model: z
      .union([
        z.literal('inherit'),
        z
          .object({
            profileId: z.string().max(128),
            model: z.string().max(256).optional(),
            reasoning: z.enum(REASONING_LEVELS).optional(),
          })
          .strict(),
      ])
      .optional(),
    tools: z
      .object({
        preset: z.enum(TOOL_PRESETS),
        allow: z.array(z.string().max(256)).max(64).optional(),
        deny: z.array(z.string().max(256)).max(64).optional(),
      })
      .strict()
      .optional(),
    permission: z.enum(['inherit', 'read_only', 'workspace_write']).optional(),
  })
  .strict()
const fieldsSchema = {
  name: z.string().max(200).optional(),
  avatar: avatarSchema.optional(),
  intro: z.string().max(1000).optional(),
  domains: z.array(z.enum(DOMAINS)).max(3).optional(),
  role: roleSchema.optional(),
  knowledge: z.array(knowledgeSchema).max(20).optional(),
  skills: z.array(z.string().max(128)).max(20).optional(),
  mcp: z.array(z.string().max(128)).max(8).optional(),
  capabilities: capabilitiesSchema.optional(),
  groupHabit: z
    .object({
      speak: z.enum(SPEAK_MODES).optional(),
      length: z.enum(['brief', 'detailed']).optional(),
    })
    .strict()
    .optional(),
  memory: z.object({ enabled: z.boolean() }).strict().optional(),
}
export const roleCreatorDraftRequestSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('create'),
      draft: z.object(fieldsSchema).strict(),
    })
    .strict(),
  z
    .object({
      action: z.literal('edit'),
      targetId: z.string().max(128),
      patch: z.object(fieldsSchema).strict(),
    })
    .strict(),
])

export type RoleCreatorDraftRequest = z.input<
  typeof roleCreatorDraftRequestSchema
>
export type RoleCreatorFields = z.input<z.ZodObject<typeof fieldsSchema>>

export interface ContactRoleDraftMeta {
  kind: typeof ROLE_CREATOR_META_KIND
  action: 'create' | 'edit'
  targetId?: string
  /** Complete, Core-validated input for preview/trial and create. */
  draft: ContactDraftInput
  /** Only the requested edit fields; update must not replace the whole contact. */
  patch?: ContactPatch
}

export interface RoleCreatorServiceDeps {
  contacts: Pick<ContactStore, 'list' | 'get' | 'draft'>
  skills(): RoleCreatorSkill[]
  mcp(): RoleCreatorMcpServer[]
}

function inputOf(contact: Contact, includeId: boolean): ContactDraftInput {
  return {
    ...(includeId ? { id: contact.id } : {}),
    name: contact.name,
    avatar: contact.avatar,
    intro: contact.intro,
    domains: contact.domains,
    role: contact.role,
    knowledge: contact.knowledge ?? [],
    skills: contact.skills ?? [],
    mcp: contact.mcp ?? [],
    capabilities: contact.capabilities,
    groupHabit: contact.groupHabit,
    memory: contact.memory,
  }
}

export class RoleCreatorService {
  constructor(private readonly deps: RoleCreatorServiceDeps) {}

  async catalog(): Promise<RoleCreatorCatalog> {
    const listing = await this.deps.contacts.list()
    return {
      contacts: listing.contacts
        .filter((contact) => !contact.builtin)
        .map(({ id, name, intro }) => ({ id, name, intro })),
      skills: this.deps.skills(),
      mcp: this.deps.mcp(),
    }
  }

  async validateIntent(intent: RoleCreatorIntent): Promise<void> {
    if (intent.action === 'edit') await this.editable(intent.targetId)
  }

  async draft(input: RoleCreatorDraftRequest): Promise<ContactRoleDraftMeta> {
    const request = roleCreatorDraftRequestSchema.parse(input)
    if (request.action === 'create') {
      const expanded = this.expand(request.draft)
      if (!expanded.name?.trim())
        throw new ContactValidationError('name', '联系人要有名字')
      const validated = await this.deps.contacts.draft(expanded)
      await this.uniqueName(validated)
      return {
        kind: ROLE_CREATOR_META_KIND,
        action: 'create',
        draft: inputOf(validated, false),
      }
    }

    const target = await this.editable(request.targetId)
    const entries = Object.entries(request.patch).filter(
      ([, value]) => value !== undefined,
    )
    if (!entries.length)
      throw new ContactValidationError('patch', '修改内容不能为空')
    const patch = this.expand(request.patch)
    const complete: ContactDraftInput = {
      ...inputOf(target, true),
      ...patch,
      role: { ...target.role, ...patch.role },
      capabilities: { ...target.capabilities, ...patch.capabilities },
      groupHabit: { ...target.groupHabit, ...patch.groupHabit },
    }
    const validated = await this.deps.contacts.draft(complete)
    await this.uniqueName(validated)
    return {
      kind: ROLE_CREATOR_META_KIND,
      action: 'edit',
      targetId: target.id,
      draft: inputOf(validated, true),
      patch,
    }
  }

  private async editable(targetId: string): Promise<Contact> {
    if (!/^ct-[a-z0-9-]+$/.test(targetId))
      throw new ContactValidationError(
        'targetId',
        '编辑要有唯一联系人编号，不能用名字或模糊匹配',
      )
    const target = await this.deps.contacts.get(targetId)
    if (target.builtin)
      throw new ContactValidationError('targetId', '内置联系人不能由创建师修改')
    return target
  }

  private async uniqueName(contact: Contact): Promise<void> {
    const listing = await this.deps.contacts.list()
    if (
      listing.contacts.some(
        (other) =>
          other.id !== contact.id &&
          other.name.toLowerCase() === contact.name.toLowerCase(),
      )
    )
      throw new ContactValidationError(
        'name',
        `已经有叫「${contact.name}」的联系人了`,
      )
  }

  private expand(fields: RoleCreatorFields): ContactPatch {
    const next: ContactPatch = {}
    for (const key of [
      'name',
      'avatar',
      'intro',
      'domains',
      'role',
      'knowledge',
      'capabilities',
      'groupHabit',
      'memory',
    ] as const) {
      const value = fields[key]
      if (value !== undefined) Object.assign(next, { [key]: value })
    }
    if (fields.skills !== undefined) {
      const available = this.deps.skills()
      const unknown = fields.skills.filter(
        (name) => !available.some((skill) => skill.name === name),
      )
      if (unknown.length)
        throw new ContactValidationError(
          'skills',
          `没有这些 Skill：${unknown.join('、')}`,
        )
      next.skills = fields.skills.map((name) => {
        const matches = available.filter((skill) => skill.name === name)
        if (matches.length !== 1)
          throw new ContactValidationError(
            'skills',
            `Skill「${name}」来源不唯一`,
          )
        return { id: `sk-${name}`, sourceId: matches[0]!.sourceId, name }
      })
    }
    if (fields.mcp !== undefined) {
      const available = this.deps.mcp()
      const unknown = fields.mcp.filter(
        (id) => !available.some((server) => server.serverId === id),
      )
      if (unknown.length)
        throw new ContactValidationError(
          'mcp',
          `没有这些 MCP 服务：${unknown.join('、')}`,
        )
      next.mcp = fields.mcp.map((id) => {
        const server = available.find((candidate) => candidate.serverId === id)!
        if (server.state !== 'ready')
          throw new ContactValidationError('mcp', `MCP 服务「${id}」当前不可用`)
        return { serverId: id, toolNames: [...server.tools] }
      })
    }
    return next
  }
}

export interface RoleCreatorToolRegistration {
  definition: ToolDefinition
  visible(agent: Agent | undefined): boolean
}

export function createRoleCreatorTools(host: {
  service: RoleCreatorService
  session(id: string): { surface?: string; contact_id?: string } | null
}): RoleCreatorToolRegistration[] {
  const creatorOf = (agent: Agent | undefined): boolean => {
    if (!agent || agent.owner !== undefined) return false
    const entry = host.session(agent.session.id)
    return (
      entry?.surface === 'contact' &&
      entry.contact_id === ROLE_CREATOR_CONTACT_ID
    )
  }
  const requireCreator = (agent: Agent | undefined): void => {
    if (!creatorOf(agent))
      throw new ToolError(
        '角色创建工具只能在角色创建师的单聊里使用',
        'ROLE_CREATOR_ONLY',
      )
  }
  const catalog = defineTool({
    name: ROLE_CREATOR_CATALOG_TOOL,
    description:
      'List editable contacts and the currently installed Skills and MCP services. Read only; call before editing or selecting capabilities.',
    input: z.object({}).strict(),
    execute: async (_args, context) => {
      requireCreator(context.agent)
      return JSON.stringify(await host.service.catalog())
    },
  })
  const draft = defineTool({
    name: ROLE_CREATOR_DRAFT_TOOL,
    description:
      'Submit a Core-validated but UNSAVED local contact draft. create takes a full draft; edit takes one exact non-builtin targetId and only the changed patch. Never saves a contact.',
    input: roleCreatorDraftRequestSchema,
    execute: async (args, context) => {
      requireCreator(context.agent)
      try {
        const result = await host.service.draft(args)
        context.concludeTurn()
        return {
          content:
            '草稿已生成，尚未保存。用户可以先试用、继续调整，或点击确认卡保存。',
          meta: result,
        }
      } catch (error) {
        if (error instanceof ToolError) throw error
        throw new ToolError(
          error instanceof Error ? error.message : String(error),
          'ROLE_DRAFT_REFUSED',
        )
      }
    },
  })
  return [
    { definition: catalog, visible: creatorOf },
    { definition: draft, visible: creatorOf },
  ]
}
