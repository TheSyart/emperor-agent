// UI-S02: the command palette finds sessions by what was said in them.
// `searchSessionLogs` reads the user's own messages and the model's
// replies (not tool output or injected context) from each session's log.
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  contextMessage,
  createAssistantMessage,
  createToolResultMessage,
  userText,
} from '../llm/message'
import { SessionLogStore } from '../session-log/store'
import { searchSessionLogs } from './search'

function root(): string {
  return mkdtempSync(join(tmpdir(), 'emperor-session-search-'))
}

function reply(text: string) {
  return createAssistantMessage({
    content: [{ type: 'text', text }],
    source: { provider: 'test', model: 'test' },
  })
}

/** Write sessions with the given (role, text) messages. */
function write(
  dir: string,
  sessions: Record<
    string,
    Array<['user' | 'assistant' | 'tool' | 'context', string]>
  >,
): void {
  const store = new SessionLogStore({ root: dir })
  for (const [id, messages] of Object.entries(sessions)) {
    const session = store.create({ id, cwd: dir })
    const append = { surfaceOp: 'append' } as const
    messages.forEach(([role, text], index) => {
      if (role === 'user')
        session.append('user/message', userText(text), append)
      else if (role === 'context')
        session.append('user/message', contextMessage('test', text), append)
      else if (role === 'tool')
        session.append(
          'user/message',
          createToolResultMessage({
            callId: `c${index}`,
            content: [{ type: 'text', text }],
            isError: false,
          }),
          append,
        )
      else
        session.append(
          'assistant/message',
          { turn: 1, step: index + 1, message: reply(text) },
          append,
        )
    })
    store.flush(id, { sync: true })
    store.close(id)
  }
}

const index = (ids: string[]) =>
  ids.map((id, n) => ({
    id,
    title: `会话 ${id}`,
    updated_at: `2026-10-${String(20 - n).padStart(2, '0')}T08:00:00Z`,
  }))

describe('searchSessionLogs', () => {
  it('finds a phrase in the user’s messages and the replies, with a snippet', async () => {
    const dir = root()
    write(dir, {
      a: [
        ['user', '帮我修复登录页在移动端的布局错位'],
        ['assistant', '问题出在 LoginForm.vue 写死了宽度'],
      ],
      b: [['user', '整理一下 0.2 的发布说明']],
    })
    const hits = await searchSessionLogs({
      root: dir,
      sessions: index(['a', 'b']),
      query: 'loginform',
    })
    expect(hits).toEqual([
      expect.objectContaining({
        sessionId: 'a',
        title: '会话 a',
        role: 'assistant',
      }),
    ])
    expect(hits[0]!.snippet).toContain('LoginForm.vue')
    const user = await searchSessionLogs({
      root: dir,
      sessions: index(['a', 'b']),
      query: '发布说明',
    })
    expect(user.map((hit) => [hit.sessionId, hit.role])).toEqual([
      ['b', 'user'],
    ])
  })

  it('ignores tool output and injected context', async () => {
    const dir = root()
    write(dir, {
      a: [
        ['tool', 'secret-token-in-a-file'],
        ['context', 'secret-token-in-context'],
      ],
    })
    expect(
      await searchSessionLogs({
        root: dir,
        sessions: index(['a']),
        query: 'secret-token',
      }),
    ).toEqual([])
  })

  it('gives one hit per session, newest session first, up to the limit', async () => {
    const dir = root()
    write(dir, {
      a: [
        ['user', '复核 一'],
        ['assistant', '复核 二'],
      ],
      b: [['user', '复核 三']],
      c: [['user', '复核 四']],
    })
    const hits = await searchSessionLogs({
      root: dir,
      sessions: index(['a', 'b', 'c']),
      query: '复核',
      limit: 2,
    })
    expect(hits.map((hit) => hit.sessionId)).toEqual(['a', 'b'])
  })

  it('cuts a long message around the match', async () => {
    const dir = root()
    const long = `${'前文'.repeat(200)}关键句在这里${'后文'.repeat(200)}`
    write(dir, { a: [['user', long]] })
    const [hit] = await searchSessionLogs({
      root: dir,
      sessions: index(['a']),
      query: '关键句',
    })
    expect(hit!.snippet).toContain('关键句在这里')
    expect(hit!.snippet.length).toBeLessThanOrEqual(90)
    expect(hit!.snippet.startsWith('…')).toBe(true)
  })

  it('returns nothing for a blank query and skips a session without a log', async () => {
    const dir = root()
    write(dir, { a: [['user', 'hello']] })
    expect(
      await searchSessionLogs({
        root: dir,
        sessions: index(['a']),
        query: '  ',
      }),
    ).toEqual([])
    expect(
      await searchSessionLogs({
        root: dir,
        sessions: index(['missing', 'a']),
        query: 'hello',
      }),
    ).toEqual([expect.objectContaining({ sessionId: 'a' })])
  })

  it('finds text with quotes and backslashes, which the log escapes', async () => {
    const dir = root()
    write(dir, { a: [['user', '把 "C:\\temp" 换成相对路径']] })
    const hits = await searchSessionLogs({
      root: dir,
      sessions: index(['a']),
      query: '"c:\\temp"',
    })
    expect(hits.map((hit) => hit.snippet)).toEqual([
      '把 "C:\\temp" 换成相对路径',
    ])
  })

  it('skips a log line it cannot parse and keeps searching', async () => {
    const dir = root()
    write(dir, { a: [['user', '第一条']] })
    writeFileSync(join(dir, 'a', 'log.jsonl'), '{"not json\n', { flag: 'a' })
    expect(
      (
        await searchSessionLogs({
          root: dir,
          sessions: index(['a']),
          query: '第一条',
        })
      ).length,
    ).toBe(1)
  })
})
