import { describe, expect, it } from 'vitest'
import {
  contactDraftMatches,
  contactRoleDraftMeta,
  type ContactDraftLike,
} from './contactRoleDraft'

const draft: ContactDraftLike = {
  name: '证据研究员',
  intro: '查找并核验资料',
  domains: ['data'],
  role: {
    mission: '查找可靠资料。',
    deliverable: '带引用的结论。',
    playbook: '先检索，再交叉核验。',
    boundaries: '不编造来源。',
  },
  knowledge: [],
  skills: [],
  mcp: [{ serverId: 'docs', toolNames: ['search', 'read'] }],
  capabilities: {
    model: 'inherit',
    tools: { preset: 'read_only', allow: [] },
    permission: 'read_only',
  },
  groupHabit: { speak: 'mentioned', length: 'brief' },
  memory: { enabled: true },
}

describe('contact role draft metadata', () => {
  it('accepts a complete create draft and an exact edit patch', () => {
    expect(
      contactRoleDraftMeta({
        kind: 'contact-role-draft',
        action: 'create',
        draft,
      }),
    ).toMatchObject({ action: 'create', draft: { name: '证据研究员' } })
    expect(
      contactRoleDraftMeta({
        kind: 'contact-role-draft',
        action: 'edit',
        targetId: 'ct-researcher',
        draft,
        patch: { intro: '核验公开资料' },
      }),
    ).toMatchObject({ action: 'edit', targetId: 'ct-researcher' })
  })

  it('rejects malformed, ambiguous or built-in edit metadata', () => {
    expect(contactRoleDraftMeta(null)).toBeNull()
    expect(
      contactRoleDraftMeta({ kind: 'contact-role-draft', action: 'create' }),
    ).toBeNull()
    expect(
      contactRoleDraftMeta({
        kind: 'contact-role-draft',
        action: 'edit',
        targetId: '研究员',
        draft,
        patch: {},
      }),
    ).toBeNull()
    expect(
      contactRoleDraftMeta({
        kind: 'contact-role-draft',
        action: 'edit',
        targetId: 'ct-role-creator',
        draft,
        patch: { intro: 'x' },
      }),
    ).toBeNull()
  })

  it('recognizes an already saved create without matching a same-name different role', () => {
    expect(contactDraftMatches(draft, { ...draft, id: 'ct-new' })).toBe(true)
    expect(
      contactDraftMatches(draft, {
        ...draft,
        id: 'ct-other',
        intro: '别的岗位',
      }),
    ).toBe(false)
  })
})
