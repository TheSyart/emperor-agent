import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  HybridMemoryDerivedIndexStore,
  chunkHybridMemoryDocuments,
  type HybridMemoryDocument,
} from './hybrid-index'

describe('hybrid memory derived index', () => {
  it('chunks Markdown deterministically, preserves line provenance, and drops scaffolds', () => {
    const document = doc(
      'global',
      [
        '# Memory',
        '',
        '## Database',
        '',
        'Primary endpoint is db.internal:6543.',
        '',
        '## Empty',
        '',
        '<!-- add facts here -->',
        '',
        '## Deploy',
        '',
        'Release channel is canary.',
      ].join('\n'),
    )

    const first = chunkHybridMemoryDocuments([document], { maxChars: 120 })
    const second = chunkHybridMemoryDocuments([document], { maxChars: 120 })

    expect(second).toEqual(first)
    expect(first.map((item) => item.text)).toEqual([
      '## Database\n\nPrimary endpoint is db.internal:6543.',
      '## Deploy\n\nRelease channel is canary.',
    ])
    expect(first).toEqual([
      expect.objectContaining({
        path: document.path,
        source: 'global',
        startLine: 3,
        endLine: 5,
      }),
      expect.objectContaining({ startLine: 11, endLine: 13 }),
    ])
    expect(first[0]!.id).toMatch(/^[a-f0-9]{64}$/)
  })

  it('is a rebuildable atomic derivative and avoids rewrites for an identical source digest', () => {
    const root = mkdtempSync(join(tmpdir(), 'emperor-hybrid-index-'))
    const store = new HybridMemoryDerivedIndexStore(root)
    const source = doc(
      'global',
      '## Database\n\nPrimary endpoint is db.internal:6543.',
    )

    const initial = store.sync([source])
    const unchanged = store.sync([source])

    expect(initial).toMatchObject({ changed: true, added: 1, removed: 0 })
    expect(unchanged).toMatchObject({ changed: false, added: 0, removed: 0 })
    expect(initial.derivedDiskBytes).toBeGreaterThan(0)
    expect(store.load().chunks).toEqual(initial.chunks)
    expect(readFileSync(source.path, 'utf8')).toBe(source.content)

    rmSync(store.indexPath)
    expect(existsSync(store.indexPath)).toBe(false)
    const rebuilt = store.sync([source])
    expect(rebuilt).toMatchObject({ changed: true, added: 1, removed: 0 })
    expect(readFileSync(source.path, 'utf8')).toBe(source.content)
  })

  it('isolates a corrupt derivative and rebuilds from Markdown without mutating facts', () => {
    const root = mkdtempSync(join(tmpdir(), 'emperor-hybrid-corrupt-'))
    const source = doc('global', '## Fact\n\nRecovery code is SAFE-99.', root)
    const store = new HybridMemoryDerivedIndexStore(root)
    store.sync([source])
    writeFileSync(store.indexPath, '{truncated', 'utf8')

    const loaded = store.load()
    const rebuilt = store.sync([source])

    expect(loaded).toMatchObject({ status: 'corrupt', chunks: [] })
    expect(rebuilt.changed).toBe(true)
    expect(rebuilt.chunks[0]!.text).toContain('SAFE-99')
    expect(readFileSync(source.path, 'utf8')).toBe(source.content)
  })
})

function doc(
  id: string,
  content: string,
  root = mkdtempSync(join(tmpdir(), 'emperor-hybrid-doc-')),
): HybridMemoryDocument {
  const path = join(root, 'MEMORY.local.md')
  writeFileSync(path, content, 'utf8')
  return {
    id,
    content,
    source: 'global',
    path,
    createdAt: Date.UTC(2026, 6, 19),
  }
}
