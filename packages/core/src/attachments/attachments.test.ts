import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AttachmentStore, MAX_IMAGE_BYTES, TEXT_INLINE_LIMIT } from './store'

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

describe('AttachmentStore (agent/attachments.py parity)', () => {
  it('saves text attachments with safe names, sidecars, ids, and lookup by id', () => {
    const root = tmp('emperor-attachments-text-')
    const store = new AttachmentStore(root)
    const ref = store.save({
      raw: Buffer.from('hello\nworld', 'utf8'),
      name: '../报告.md',
      mime: 'text/markdown',
    })

    expect(ref.id).toMatch(/^att_\d{4}-\d{2}_[0-9a-f]{8}$/)
    expect(ref.kind).toBe('text')
    expect(ref.has_text).toBe(true)
    expect(ref.has_image).toBe(false)
    expect(ref.rel_path).toContain('memory/attachments/')
    expect(basename(ref.rel_path)).not.toContain('/')
    expect(existsSync(join(root, ref.rel_path))).toBe(true)
    expect(existsSync(join(root, ref.text_rel_path!))).toBe(true)
    expect(store.readText(ref)).toBe('hello\nworld')

    const fresh = new AttachmentStore(root)
    const loaded = fresh.get(ref.id)!
    expect(loaded.rel_path).toBe(ref.rel_path)
    expect(loaded.text_rel_path).toBe(ref.text_rel_path)
    expect(loaded.name).toBe(
      basename(ref.rel_path).replace(/^[0-9a-f]{8}-/, ''),
    )
  })

  it('removes an attachment and its sidecar, then no longer finds it', () => {
    const root = tmp('emperor-attachments-remove-')
    const store = new AttachmentStore(root)
    const ref = store.save({
      raw: Buffer.from('notes', 'utf8'),
      name: 'a.md',
      mime: 'text/markdown',
    })
    expect(store.remove(ref.id)).toBeGreaterThan(0)
    expect(existsSync(join(root, ref.rel_path))).toBe(false)
    expect(existsSync(join(root, ref.text_rel_path!))).toBe(false)
    expect(store.get(ref.id)).toBeNull()
    expect(store.remove(ref.id)).toBe(0)
  })

  it('removes every copy saved under one id', () => {
    const root = tmp('emperor-attachments-copies-')
    const store = new AttachmentStore(root)
    const bytes = Buffer.from('same screenshot bytes', 'utf8')
    const first = store.save({
      raw: bytes,
      name: 'shot-1.md',
      mime: 'text/markdown',
    })
    const second = store.save({
      raw: bytes,
      name: 'shot-2.md',
      mime: 'text/markdown',
    })
    expect(second.id).toBe(first.id)
    expect(second.rel_path).not.toBe(first.rel_path)
    expect(store.remove(second.id)).toBeGreaterThan(0)
    for (const ref of [first, second]) {
      expect(existsSync(join(root, ref.rel_path))).toBe(false)
      expect(existsSync(join(root, ref.text_rel_path!))).toBe(false)
    }
    expect(new AttachmentStore(root).get(first.id)).toBeNull()
  })

  it('validates mime and size limits', () => {
    const store = new AttachmentStore(tmp('emperor-attachments-limits-'))
    expect(() =>
      store.save({
        raw: Buffer.from('x'),
        name: 'bad.exe',
        mime: 'application/x-msdownload',
      }),
    ).toThrow(/unsupported mime/)
    expect(() =>
      store.save({
        raw: Buffer.alloc(MAX_IMAGE_BYTES + 1),
        name: 'big.png',
        mime: 'image/png',
      }),
    ).toThrow(/file too large/)
  })

  it('extracts pdf text through the injected extractor without blocking uploads when absent', () => {
    const root = tmp('emperor-attachments-pdf-')
    const noExtractor = new AttachmentStore(root)
    const pdf = Buffer.from('%PDF-1.4\nfake', 'utf8')
    const noText = noExtractor.save({
      raw: pdf,
      name: 'doc.pdf',
      mime: 'application/pdf',
    })
    expect(noText.kind).toBe('document')
    expect(noText.has_text).toBe(false)

    const withExtractor = new AttachmentStore(root, {
      pdfTextExtractor: () => 'PDF text',
    })
    const withText = withExtractor.save({
      raw: Buffer.from('%PDF-1.4\nother', 'utf8'),
      name: 'doc.pdf',
      mime: 'application/pdf',
    })
    expect(withText.has_text).toBe(true)
    expect(withExtractor.readText(withText)).toBe('PDF text')
  })

  it('truncates sidecar text like the Python store', () => {
    const store = new AttachmentStore(tmp('emperor-attachments-truncate-'))
    const text = 'a'.repeat(TEXT_INLINE_LIMIT + 100)
    const ref = store.save({
      raw: Buffer.from(text),
      name: 'long.txt',
      mime: 'text/plain',
    })
    const out = store.readText(ref)
    expect(out.length).toBeLessThan(text.length)
    expect(out).toContain('[truncated, total')
  })
})
