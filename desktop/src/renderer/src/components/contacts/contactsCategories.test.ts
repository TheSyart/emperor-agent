/**
 * GRP-21: the contacts page's categories — by domain, external agents only
 * under 外部, no domain (or `other`) under 其他, empty categories left out.
 */
import { describe, expect, it } from 'vitest'
import type { Contact } from '@emperor/core/api'
import { contactCategories } from './contactsCategories'

function contact(
  id: string,
  domains: Contact['domains'],
  kind: Contact['kind'] = 'local',
): Contact {
  return {
    id,
    kind,
    name: id,
    avatar: { kind: 'portrait', index: 0 },
    intro: '',
    domains,
    role: {
      mission: '',
      deliverable: '',
      playbook: '',
      boundaries: '',
      knowledge: [],
    },
    capabilities: {
      model: 'inherit',
      tools: { preset: 'read_only' },
      permission: 'read_only',
    },
    groupHabit: { speak: 'relevant', length: 'brief' },
    memory: { enabled: true },
    version: 1,
    builtin: false,
    createdAt: 1,
    updatedAt: 1,
  }
}

describe('contactCategories (GRP-21)', () => {
  const list = [
    contact('pm', ['product', 'decision']),
    contact('res', ['content', 'data']),
    contact('claude', ['engineering'], 'external'),
    contact('codex', ['engineering'], 'external'),
    contact('nobody', []),
    contact('other', ['other']),
  ]

  it('orders the categories and counts them', () => {
    expect(
      contactCategories(list).map((category) => [
        category.label,
        category.contacts.map((contact) => contact.id),
      ]),
    ).toEqual([
      ['全部', ['pm', 'res', 'claude', 'codex', 'nobody', 'other']],
      ['产品', ['pm']],
      ['内容', ['res']],
      ['数据', ['res']],
      ['决策', ['pm']],
      ['外部', ['claude', 'codex']],
      ['其他', ['nobody', 'other']],
    ])
  })

  it('keeps external agents out of the domain categories', () => {
    const engineering = contactCategories(list).find(
      (category) => category.id === 'engineering',
    )
    expect(engineering).toBeUndefined()
  })

  it('leaves a category with nothing in it out', () => {
    expect(
      contactCategories([contact('pm', ['product'])]).map(
        (category) => category.id,
      ),
    ).toEqual(['all', 'product'])
  })
})
