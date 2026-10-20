// KRN-12 (CORE-36): the session index lives in memory. It is built once
// from the session directories and kept current by this store's own writes;
// a write by another process (it rewrites index.json) makes it reload.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SessionStore } from './store'

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'emperor-session-index-'))
}

/** Write `count` sessions straight to disk (one meta snapshot each). */
function seed(root: string, count: number): string[] {
  const ids: string[] = []
  for (let index = 0; index < count; index += 1) {
    const id = `s${String(index).padStart(5, '0')}`
    const dir = join(root, 'sessions', id)
    mkdirSync(dir, { recursive: true })
    const ts = new Date(Date.UTC(2026, 0, 1) + index * 1000).toISOString()
    writeFileSync(
      join(dir, 'meta.jsonl'),
      `${JSON.stringify({
        type: 'session_snapshot',
        ts,
        session: {
          id,
          title: `会话 ${index}`,
          created_at: ts,
          updated_at: ts,
          preview: '',
          message_count: 0,
          title_status: 'manual',
          mode: 'chat',
          version: 1,
        },
      })}\n`,
      'utf8',
    )
    ids.push(id)
  }
  return ids
}

function lines(path: string): number {
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).length
}

describe('SessionStore index in memory (KRN-12)', () => {
  it('answers get in under 5 ms with 5000 sessions (1)', () => {
    const root = tmp()
    const ids = seed(root, 5000)
    const store = new SessionStore(root)
    expect(store.list({ includeArchived: true })).toHaveLength(5000)
    const started = performance.now()
    for (let index = 0; index < 200; index += 1)
      expect(store.get(ids[(index * 37) % ids.length]!)).not.toBeNull()
    const perCall = (performance.now() - started) / 200
    expect(perCall).toBeLessThan(5)
  })

  it('keeps its own writes without rescanning, and they survive a reload', () => {
    const root = tmp()
    const store = new SessionStore(root)
    const first = store.create('第一个')
    const second = store.create('第二个')
    expect(store.rename(first.id, '改过的名字')).toBe(true)
    expect(store.get(first.id)?.title).toBe('改过的名字')
    expect(store.list().map((item) => item.id)).toContain(second.id)
    const fresh = new SessionStore(root)
    expect(fresh.get(first.id)?.title).toBe('改过的名字')
    expect(fresh.list()).toHaveLength(2)
  })

  it('sees a session another process created', () => {
    const root = tmp()
    const here = new SessionStore(root)
    here.create('这里的')
    expect(here.list()).toHaveLength(1)
    const elsewhere = new SessionStore(root)
    const made = elsewhere.create('别处的')
    expect(here.get(made.id)?.title).toBe('别处的')
    expect(here.list()).toHaveLength(2)
  })

  it('compacts meta.jsonl to one snapshot past 1000 lines', () => {
    const root = tmp()
    const store = new SessionStore(root)
    store.create('keeper')
    const entry = store.create('often renamed')
    const meta = store.metaPath(entry.id)
    for (let index = 0; index < 1001; index += 1)
      store.rename(entry.id, `名字 ${index}`)
    expect(lines(meta)).toBeLessThanOrEqual(1000)
    expect(store.get(entry.id)?.title).toBe('名字 1000')
    expect(new SessionStore(root).get(entry.id)?.title).toBe('名字 1000')
  })
})
