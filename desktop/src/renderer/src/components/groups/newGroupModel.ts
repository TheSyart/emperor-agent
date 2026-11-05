/**
 * 新建群聊's templates (GRP-08): 评审, 正反方, 调研写作. A template names
 * the group, writes its announcement (群公告, read by every member before
 * speaking) and asks for the contacts made from its roles' templates
 * (`Contact.templateId`); fixed Emperor is added by Core, not picked here.
 * A role nobody was
 * made from is listed as missing, for the user to create. The
 * collaboration is not the template's: it starts at 设置 › 群聊's default
 * (D14). Pure; NewGroupDialog does the calls.
 */
import type { Contact } from '@emperor/core/api'

export const EMPEROR_ID = 'ct-emperor'

export interface GroupTemplate {
  id: 'review' | 'debate' | 'research'
  name: string
  /** One line on the card. */
  description: string
  charter: string
  /** Contact templates (templates/contacts/<id>.md) and their names. */
  roles: readonly { templateId: string; name: string }[]
}

export const GROUP_TEMPLATES: readonly GroupTemplate[] = [
  {
    id: 'review',
    name: '评审',
    description: '架构师、代码审稿人、测试工程师一起看方案或改动',
    charter: [
      '目标：评审一个方案或一次改动，结论写成一页说明。',
      '约束：先说会出错的，再说风格；有分歧时列出两边的理由，由我决定；不改项目代码。',
    ].join('\n'),
    roles: [
      { templateId: 'architect', name: '架构师' },
      { templateId: 'code-reviewer', name: '代码审稿人' },
      { templateId: 'test-engineer', name: '测试工程师' },
    ],
  },
  {
    id: 'debate',
    name: '正反方',
    description: '产品经理讲为什么做，红队专挑毛病，群聊收尾',
    charter: [
      '目标：把一个决定的正反两面讲透，最后由群聊写结论。',
      '约束：每次发言只说新的理由，不重复对方说过的；拿不准的标出来。',
    ].join('\n'),
    roles: [
      { templateId: 'product-manager', name: '产品经理' },
      { templateId: 'red-team', name: '反方（红队）' },
    ],
  },
  {
    id: 'research',
    name: '调研写作',
    description: '研究员查资料，写作者成稿，编辑把关',
    charter: [
      '目标：调研一个题目并写成一篇文章。',
      '分工：研究员查资料并注明出处；写作者成稿；编辑检查事实和表达。',
    ].join('\n'),
    roles: [
      { templateId: 'researcher', name: '研究员' },
      { templateId: 'writer', name: '写作者' },
      { templateId: 'editor', name: '编辑' },
    ],
  },
]

/**
 * The optional members a template asks for: the first contact made from each
 * role's template; fixed Emperor is not a selectable template member.
 */
export function templateMembers(
  template: GroupTemplate,
  contacts: readonly Pick<Contact, 'id' | 'templateId'>[],
): { members: string[]; missing: string[] } {
  const members: string[] = []
  const missing: string[] = []
  for (const role of template.roles) {
    const found = contacts.find(
      (contact) =>
        contact.templateId === role.templateId && !members.includes(contact.id),
    )
    if (found) members.push(found.id)
    else missing.push(role.name)
  }
  return { members, missing }
}

/** Members a group may hold (GroupService's limit). */
export const GROUP_MEMBER_LIMIT = 12
/** The longest group name (GroupService's limit). */
export const GROUP_TITLE_LIMIT = 40
