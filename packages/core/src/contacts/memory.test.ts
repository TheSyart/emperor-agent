// GRP-03 card tests 8–9 as units: a contact's personal memory is
// `<stateRoot>/contacts/<id>/memory/MEMORY.local.md` (MemoryStore), one line
// per explicit piece of feedback; every entry can be changed or deleted, and
// only the newest 4 KB goes into the prompt.
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ContactMemoryStore, feedbackLine } from './memory'

function setup() {
  const stateRoot = mkdtempSync(join(tmpdir(), 'emperor-contact-memory-'))
  return { stateRoot, memory: new ContactMemoryStore(stateRoot) }
}

const ID = 'ct-abcdefghijkl'

describe('feedbackLine', () => {
  it('writes date, rating, the user’s words and the source on one line', () => {
    expect(
      feedbackLine({
        date: '2026-10-27',
        rating: 'down',
        note: '太长了，\n先给结论',
        source: '单聊「审稿」',
        excerpt: '好的，我先从背景讲起',
      }),
    ).toBe(
      '2026-10-27 · 👎 · 「太长了， 先给结论」 · 来源：单聊「审稿」里的回答「好的，我先从背景讲起」',
    )
    expect(
      feedbackLine({
        date: '2026-10-27',
        rating: 'up',
        source: '单聊「审稿」',
      }),
    ).toBe('2026-10-27 · 👍 · （没写原因） · 来源：单聊「审稿」')
  })
})

describe('ContactMemoryStore', () => {
  it('has nothing, and creates nothing, until the first feedback', () => {
    const { stateRoot, memory } = setup()
    expect(memory.entries(ID)).toEqual([])
    expect(memory.promptText(ID)).toEqual({ text: '', truncated: false })
    expect(existsSync(join(stateRoot, 'contacts', ID))).toBe(false)
  })

  it('appends one line per feedback and reads it back', () => {
    const { stateRoot, memory } = setup()
    const first = memory.append(
      ID,
      '2026-10-27 · 👍 · 「好」 · 来源：单聊「a」',
    )
    const second = memory.append(
      ID,
      '2026-10-28 · 👎 · 「长」 · 来源：单聊「b」',
    )
    expect(memory.entries(ID)).toEqual([
      { ...first, date: '2026-10-27', rating: 'up' },
      { ...second, date: '2026-10-28', rating: 'down' },
    ])
    const file = join(stateRoot, 'contacts', ID, 'memory', 'MEMORY.local.md')
    expect(readFileSync(file, 'utf8')).toBe(
      '# 个人记忆\n\n- 2026-10-27 · 👍 · 「好」 · 来源：单聊「a」\n- 2026-10-28 · 👎 · 「长」 · 来源：单聊「b」\n',
    )
    expect(memory.promptText(ID).text).toContain(
      '- 2026-10-28 · 👎 · 「长」 · 来源：单聊「b」',
    )
  })

  it('changes and deletes one entry by its id', () => {
    const { stateRoot, memory } = setup()
    const first = memory.append(ID, '标题要短')
    const second = memory.append(ID, '先给结论')
    const changed = memory.update(ID, first.id, '  标题不超过 20 字  ')
    expect(changed.text).toBe('标题不超过 20 字')
    expect(memory.entries(ID).map((entry) => entry.text)).toEqual([
      '标题不超过 20 字',
      '先给结论',
    ])
    memory.delete(ID, second.id)
    expect(memory.entries(ID).map((entry) => entry.text)).toEqual([
      '标题不超过 20 字',
    ])
    // A stale id (the entry changed meanwhile) is refused, not guessed.
    expect(() => memory.update(ID, first.id, 'x')).toThrow(
      expect.objectContaining({ code: 'contact_memory_entry_not_found' }),
    )
    // Old contents are kept as memory versions.
    expect(
      readdirSync(
        join(stateRoot, 'contacts', ID, 'memory', 'versions', 'snapshots'),
      ).length,
    ).toBeGreaterThan(0)
  })

  it('takes one line of at most 500 characters', () => {
    const { memory } = setup()
    const entry = memory.append(ID, '好')
    expect(() => memory.update(ID, entry.id, '')).toThrow(
      expect.objectContaining({ code: 'contact_invalid' }),
    )
    expect(() => memory.update(ID, entry.id, '一\n二')).toThrow(
      expect.objectContaining({ code: 'contact_invalid' }),
    )
    expect(() => memory.update(ID, entry.id, '长'.repeat(501))).toThrow(
      expect.objectContaining({ code: 'contact_invalid' }),
    )
  })

  it('puts only the newest 4 KB into the prompt', () => {
    const { memory } = setup()
    for (let n = 1; n <= 60; n += 1)
      memory.append(ID, `第 ${n} 条 ${'记'.repeat(30)}`)
    const { text, truncated } = memory.promptText(ID)
    expect(truncated).toBe(true)
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(4 * 1024)
    expect(text).toContain('第 60 条')
    expect(text).not.toContain('第 1 条 ')
    // Whole lines only.
    for (const line of text.split('\n').filter((line) => line.startsWith('- ')))
      expect(line).toMatch(/^- 第 \d+ 条 记{30}$/)
    expect(memory.listing(ID, true)).toMatchObject({
      truncated: true,
      limit: 4 * 1024,
      notice: expect.stringContaining('整理'),
    })
  })
})
