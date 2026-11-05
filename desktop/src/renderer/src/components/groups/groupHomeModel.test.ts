/**
 * GRP-05 (D12): what the Group home's composer does with a message — @ one
 * contact is a single chat, @ two or more make a temporary group with
 * Emperor as its moderator — and the group's name from the first sentence
 * (card tests: @ 一位进单聊、@ 多位建群；群名取第一句话；临时群里 Emperor
 * 作为主持人加入).
 */
import { describe, expect, it } from 'vitest'
import {
  completionQuery,
  mentionedContacts,
  planHomeSend,
  temporaryGroupTitle,
  unknownMentions,
} from './groupHomeModel'

const CONTACTS = [
  { id: 'ct-emperor', name: 'Emperor', kind: 'local' as const },
  { id: 'ct-rev', name: '审稿人', kind: 'local' as const },
  { id: 'ct-arch', name: '架构师', kind: 'local' as const },
  { id: 'ct-claude-code', name: 'Claude Code', kind: 'external' as const },
  { id: 'ct-claude', name: 'Claude', kind: 'local' as const },
]

describe('mentions', () => {
  it('finds the contacts @-mentioned, in order, longest name first', () => {
    expect(
      mentionedContacts('@架构师 @审稿人 帮我看看，@架构师 先说', CONTACTS),
    ).toEqual(['ct-arch', 'ct-rev'])
    expect(mentionedContacts('@Claude Code 看一下', CONTACTS)).toEqual([
      'ct-claude-code',
    ])
    expect(mentionedContacts('@Claude 看一下', CONTACTS)).toEqual(['ct-claude'])
  })

  it('reads an @ only at the start of a word, and skips @所有人', () => {
    expect(mentionedContacts('发到 a@审稿人.com 吧', CONTACTS)).toEqual([])
    expect(mentionedContacts('（@审稿人）看看', CONTACTS)).toEqual(['ct-rev'])
    expect(mentionedContacts('@所有人 看看', CONTACTS)).toEqual([])
  })

  it('names the @-mentions that are no contact (边界：@ 了不存在的名字)', () => {
    expect(unknownMentions('@审稿人 @小王 和 @老李，看看', CONTACTS)).toEqual([
      '小王',
      '老李',
    ])
    expect(unknownMentions('@审稿人看看 a@b.com @所有人', CONTACTS)).toEqual([])
  })

  it('knows the name being typed after the last @', () => {
    expect(completionQuery('帮我 @审', 5)).toEqual({ start: 3, query: '审' })
    expect(completionQuery('@', 1)).toEqual({ start: 0, query: '' })
    expect(completionQuery('@审稿人 看看', 7)).toBeNull()
    expect(completionQuery('a@b', 3)).toBeNull()
  })
})

describe('the temporary group’s name (card test: 群名取第一句话)', () => {
  it('takes the first sentence without the @-mentions', () => {
    expect(
      temporaryGroupTitle(
        '@架构师 @审稿人 帮我评估一下群聊方案。顺便看看代码',
        ['架构师', '审稿人'],
      ),
    ).toBe('帮我评估一下群聊方案')
    expect(
      temporaryGroupTitle('@架构师 @审稿人 方案行吗？\n第二行', [
        '架构师',
        '审稿人',
      ]),
    ).toBe('方案行吗')
    expect(
      temporaryGroupTitle('Review the plan. Then the code', ['审稿人']),
    ).toBe('Review the plan')
  })

  it('keeps a dot inside a number', () => {
    expect(
      temporaryGroupTitle('@架构师 @审稿人 帮我评估一下 0.3 的方案', [
        '架构师',
        '审稿人',
      ]),
    ).toBe('帮我评估一下 0.3 的方案')
  })

  it('cuts it at 20 characters with …', () => {
    const title = temporaryGroupTitle(
      '@架构师 @审稿人 一二三四五六七八九十一二三四五六七八九十多出来的字',
      ['架构师', '审稿人'],
    )
    expect(title).toBe('一二三四五六七八九十一二三四五六七八九十…')
    expect(Array.from(title)).toHaveLength(21)
  })

  it('names the members when the first sentence is empty', () => {
    expect(
      temporaryGroupTitle('@架构师 @审稿人 。后面的话', ['架构师', '审稿人']),
    ).toBe('临时群 · 架构师、审稿人')
    expect(temporaryGroupTitle('@架构师 @审稿人', ['架构师', '审稿人'])).toBe(
      '临时群 · 架构师、审稿人',
    )
  })
})

describe('what sending does', () => {
  it('opens a single chat for one contact (card test: @ 一位进单聊)', () => {
    expect(planHomeSend('@审稿人 看看这个改动', CONTACTS)).toEqual({
      kind: 'chat',
      contactId: 'ct-rev',
    })
  })

  it('CG-00: makes a group from exactly the asked members, with no visible moderator', () => {
    expect(planHomeSend('@架构师 @审稿人 帮我评估一下方案', CONTACTS)).toEqual({
      kind: 'group',
      title: '帮我评估一下方案',
      members: ['ct-arch', 'ct-rev'],
      ask: ['ct-arch', 'ct-rev'],
    })
    // Emperor is included only when explicitly @-mentioned.
    expect(planHomeSend('@Emperor @审稿人 一起看看', CONTACTS)).toEqual({
      kind: 'group',
      title: '一起看看',
      members: ['ct-emperor', 'ct-rev'],
      ask: ['ct-emperor', 'ct-rev'],
    })
  })

  it('asks for an @ first, and stops at an unknown name', () => {
    expect(planHomeSend('   ', CONTACTS)).toEqual({ kind: 'empty' })
    expect(planHomeSend('帮我看看', CONTACTS)).toEqual({ kind: 'none' })
    expect(planHomeSend('@审稿人 @小王 看看', CONTACTS)).toEqual({
      kind: 'unknown',
      names: ['小王'],
    })
  })
})
