/**
 * The contact profile's words (GRP-05, 预览 B 第 2 步): the user's rating out
 * of their 👍 / 👎, the versions newest first, what changed between two of
 * them, and the labels of a role card's settings. Pure.
 */
import type {
  Contact,
  ContactDomain,
  ContactKnowledge,
  ContactVersionEntry,
} from '@emperor/core/api'

export interface RatingSummary {
  value: string
  label: string
  detail: string
}

/** The share of 👍 over every rating still in the contact's memory. */
export function ratingSummary(ratings: {
  up: number
  down: number
}): RatingSummary {
  const total = ratings.up + ratings.down
  if (total === 0)
    return {
      value: '—',
      label: '你的评分（还没有）',
      detail: '在单聊里给回答点 👍 或 👎 就会记在这里',
    }
  return {
    value: `${Math.round((ratings.up / total) * 100)}%`,
    label: `你的评分（${total} 次）`,
    detail: `${total} 次反馈里 ${ratings.up} 次 👍、${ratings.down} 次 👎`,
  }
}

export interface ProfileVersion {
  version: number
  savedAt: number
  current: boolean
  contact: Contact
}

/** The current version first, then the saved ones, newest first. */
export function profileVersions(
  current: Contact,
  saved: readonly ContactVersionEntry[],
): ProfileVersion[] {
  return [
    {
      version: current.version,
      savedAt: current.updatedAt,
      current: true,
      contact: current,
    },
    ...saved
      .filter((entry) => entry.version < current.version)
      .sort((a, b) => b.version - a.version)
      .map((entry) => ({
        version: entry.version,
        savedAt: entry.savedAt,
        current: false,
        contact: entry.contact,
      })),
  ]
}

export const DOMAIN_LABELS: Readonly<Record<ContactDomain, string>> = {
  engineering: '工程',
  security: '安全',
  design: '设计',
  content: '内容',
  product: '产品',
  data: '数据',
  decision: '决策',
  other: '其他',
}

export const PRESET_LABELS: Readonly<Record<string, string>> = {
  read_only: '只读',
  research: '调研',
  writer: '写作',
  engineer: '工程',
  custom: '自定义',
}

export const PERMISSION_LABELS: Readonly<Record<string, string>> = {
  inherit: '跟随新会话的权限',
  read_only: '只读',
  workspace_write: '可以改工作区',
}

export const SPEAK_LABELS: Readonly<Record<string, string>> = {
  mentioned: '只在被点名时',
  relevant: '和职责相关时举手',
  always: '总是发言',
}

export const LENGTH_LABELS: Readonly<Record<string, string>> = {
  brief: '简明',
  detailed: '详细',
}

/** A resource as one line: what it is and where. */
export function knowledgeLine(ref: ContactKnowledge): string {
  switch (ref.kind) {
    case 'file':
      return `文件 · ${ref.path}${ref.use === 'pinned' ? '（常驻）' : ''}`
    case 'folder':
      return `文件夹 · ${ref.path}${ref.use === 'pinned' ? '（常驻）' : ''}`
    case 'url':
      return `网址 · ${ref.url.replace(/^https:\/\//, '')}`
    case 'note':
      return `笔记 · ${ref.title}${ref.use === 'pinned' ? '（常驻）' : ''}`
  }
}

/** The model a contact runs on, in words. */
export function modelLine(contact: Contact): string {
  const model = contact.capabilities.model
  if (model === 'inherit') return '默认模型'
  const reasoning = model.reasoning
    ? { low: '低', medium: '中', high: '高' }[model.reasoning]
    : ''
  return `${model.model || model.profileId}${reasoning ? ` · 推理强度${reasoning}` : ''}`
}

function toolsLine(contact: Contact): string {
  const tools = contact.capabilities.tools
  const parts = [PRESET_LABELS[tools.preset] ?? tools.preset]
  if (tools.allow?.length) parts.push(`另加 ${tools.allow.join('、')}`)
  if (tools.deny?.length) parts.push(`去掉 ${tools.deny.join('、')}`)
  return parts.join('；')
}

export interface VersionChange {
  key: string
  label: string
  before: string
  after: string
}

/** Each field shown in words, in the order of the role card. */
const FIELDS: ReadonlyArray<{
  key: string
  label: string
  read: (contact: Contact) => string
}> = [
  { key: 'name', label: '名字', read: (c) => c.name },
  { key: 'intro', label: '简介', read: (c) => c.intro },
  {
    key: 'domains',
    label: '领域',
    read: (c) => c.domains.map((domain) => DOMAIN_LABELS[domain]).join('、'),
  },
  { key: 'mission', label: '职责', read: (c) => c.role.mission },
  { key: 'deliverable', label: '交付', read: (c) => c.role.deliverable },
  { key: 'playbook', label: '工作方法', read: (c) => c.role.playbook },
  {
    key: 'knowledge',
    label: '知识',
    read: (c) => (c.knowledge ?? []).map(knowledgeLine).join('\n'),
  },
  { key: 'boundaries', label: '边界', read: (c) => c.role.boundaries },
  {
    key: 'skills',
    label: '工作技能',
    read: (c) => (c.skills ?? []).map((skill) => skill.name).join('、'),
  },
  {
    key: 'mcp',
    label: '外部连接',
    read: (c) =>
      (c.mcp ?? [])
        .map((server) => `${server.serverId}：${server.toolNames.join('、')}`)
        .join('\n'),
  },
  { key: 'model', label: '模型', read: modelLine },
  { key: 'tools', label: '工具', read: toolsLine },
  {
    key: 'permission',
    label: '权限',
    read: (c) =>
      PERMISSION_LABELS[c.capabilities.permission] ?? c.capabilities.permission,
  },
  {
    key: 'speak',
    label: '群聊里发言',
    read: (c) => SPEAK_LABELS[c.groupHabit.speak] ?? c.groupHabit.speak,
  },
  {
    key: 'length',
    label: '发言篇幅',
    read: (c) => LENGTH_LABELS[c.groupHabit.length] ?? c.groupHabit.length,
  },
  {
    key: 'memory',
    label: '个人记忆',
    read: (c) => (c.memory.enabled ? '开' : '关'),
  },
]

/** What differs between two versions of a contact, field by field. */
export function versionChanges(
  older: Contact,
  newer: Contact,
): VersionChange[] {
  return FIELDS.flatMap((field) => {
    const before = field.read(older)
    const after = field.read(newer)
    return before === after
      ? []
      : [{ key: field.key, label: field.label, before, after }]
  })
}
