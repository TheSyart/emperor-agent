/**
 * GRP-05: what a single chat with a contact shows — the contact's avatar and
 * name beside its replies, 👍 / 👎 while its personal memory is on (Core
 * refuses feedback otherwise), read-only once the contact is deleted — and
 * where a group's session goes (card tests: 头像与名字；联系人删除后只读；
 * 单聊只在 Group 模式出现).
 */
import { describe, expect, it } from 'vitest'
import type { Contact } from '@emperor/core/api'
import type { SessionInfo } from '../../types'
import { sessionAppMode, isListedSession } from '../../runtime/appMode'
import {
  contactChatOf,
  groupPageOf,
  speakerRowIds,
  CONTACT_DELETED_REASON,
} from './contactChat'

function contact(overrides: Partial<Contact> = {}): Contact {
  return {
    id: 'ct-reviewer00001',
    kind: 'local',
    name: '审稿人',
    avatar: { kind: 'library', id: 'AV-01-2' },
    intro: '代码与方案评审',
    domains: ['engineering'],
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
    ...overrides,
  }
}

function session(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: 'chat-reviewer',
    title: '审稿人 · 单聊',
    mode: 'chat',
    surface: 'contact',
    contact_id: 'ct-reviewer00001',
    created_at: '2026-10-27T00:00:00Z',
    updated_at: '2026-10-27T00:00:00Z',
    ...overrides,
  } as SessionInfo
}

describe('contactChatOf', () => {
  it('is the contact, its speaker line and 👍 / 👎 in its single chat (card test: 头像与名字)', () => {
    const chat = contactChatOf(session(), {
      contacts: [contact()],
      loaded: true,
    })
    expect(chat).toEqual({
      contactId: 'ct-reviewer00001',
      contact: contact(),
      deleted: false,
      feedback: true,
      speaker: {
        name: '审稿人',
        avatar: { kind: 'library', id: 'AV-01-2', label: '审稿人' },
      },
    })
  })

  it('has no 👍 / 👎 while the contact’s personal memory is off', () => {
    const chat = contactChatOf(session(), {
      contacts: [contact({ memory: { enabled: false } })],
      loaded: true,
    })
    expect(chat?.feedback).toBe(false)
    expect(chat?.speaker?.name).toBe('审稿人')
  })

  it('is read-only once the contact is deleted (card test: 联系人删除后只读)', () => {
    const chat = contactChatOf(session(), { contacts: [], loaded: true })
    expect(chat).toMatchObject({
      contactId: 'ct-reviewer00001',
      contact: null,
      deleted: true,
      feedback: false,
      speaker: null,
    })
    expect(CONTACT_DELETED_REASON).toBe('这个联系人已删除，这个会话只能查看')
    // Not before the contacts are read.
    expect(
      contactChatOf(session(), { contacts: [], loaded: false })?.deleted,
    ).toBe(false)
  })

  it('is nothing for any other session', () => {
    const directory = { contacts: [contact()], loaded: true }
    expect(
      contactChatOf(
        session({ surface: undefined, contact_id: undefined }),
        directory,
      ),
    ).toBeNull()
    expect(contactChatOf(session({ surface: 'trial' }), directory)).toBeNull()
    expect(contactChatOf(undefined, directory)).toBeNull()
  })

  it('lists a single chat in Group only (card test: 单聊只在 Group 模式出现)', () => {
    expect(sessionAppMode(session())).toBe('group')
    expect(isListedSession(session())).toBe(true)
  })
})

describe('speakerRowIds', () => {
  it('marks the first row of each reply after the user’s message', () => {
    const kinds: Record<string, string> = {
      u1: 'user',
      a1: 'assistant',
      t1: 'turnTail',
      u2: 'user',
      u3: 'user',
      a3: 'assistant',
    }
    const rows = [
      { kind: 'node' as const, id: 'u1' },
      { kind: 'process' as const, id: 'process:1:0', turn: 1 },
      { kind: 'node' as const, id: 'a1' },
      { kind: 'node' as const, id: 't1' },
      { kind: 'node' as const, id: 'u2' },
      { kind: 'node' as const, id: 'u3' },
      { kind: 'node' as const, id: 'a3' },
    ]
    expect([...speakerRowIds(rows, (id) => kinds[id])]).toEqual([
      'process:1:0',
      'a3',
    ])
  })
})

describe('groupPageOf', () => {
  it('sends a group’s session to its page, and nothing else', () => {
    expect(
      groupPageOf(
        session({ id: 'grp-1', surface: 'group', group_id: 'grp-1' }),
      ),
    ).toEqual({ name: 'group', params: { groupId: 'grp-1' } })
    expect(groupPageOf(session())).toBeNull()
    expect(groupPageOf(undefined)).toBeNull()
  })
})
