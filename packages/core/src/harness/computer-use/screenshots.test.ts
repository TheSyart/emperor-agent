import { mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SCREENSHOT_LEDGER_FILE, ScreenshotLedger } from './screenshots'

const id = (n: number) => `att_2026-09_${n.toString(16).padStart(8, '0')}`
const root = () => mkdtempSync(join(tmpdir(), 'emperor-cu-shots-'))

describe('screenshot quota', () => {
  it('evicts the oldest of a session past its count or size limit', () => {
    const dir = root()
    const ledger = new ScreenshotLedger(dir, {
      perSession: { count: 3, bytes: 1_000 },
      total: { count: 100, bytes: 100_000 },
    })
    expect(ledger.record('s1', [{ attachmentId: id(1), bytes: 100 }])).toEqual(
      [],
    )
    ledger.record('s1', [{ attachmentId: id(2), bytes: 100 }])
    ledger.record('s2', [{ attachmentId: id(9), bytes: 100 }])
    ledger.record('s1', [{ attachmentId: id(3), bytes: 100 }])
    // A fourth image of s1: its oldest goes, s2 is untouched.
    expect(ledger.record('s1', [{ attachmentId: id(4), bytes: 100 }])).toEqual([
      id(1),
    ])
    // One large image pushes s1 over 1000 bytes: older ones go first.
    expect(ledger.record('s1', [{ attachmentId: id(5), bytes: 900 }])).toEqual([
      id(2),
      id(3),
    ])
    expect(ledger.usage('s1')).toEqual({ count: 2, bytes: 1_000 })
    expect(ledger.usage('s2')).toEqual({ count: 1, bytes: 100 })
    expect(statSync(join(dir, SCREENSHOT_LEDGER_FILE)).mode & 0o777).toBe(0o600)
    // A fresh ledger reads the same state back.
    expect(new ScreenshotLedger(dir).usage()).toEqual({
      count: 3,
      bytes: 1_100,
    })
  })

  it('keeps the global limit across sessions and never evicts the new save', () => {
    const ledger = new ScreenshotLedger(root(), {
      perSession: { count: 10, bytes: 10_000 },
      total: { count: 2, bytes: 10_000 },
    })
    ledger.record('a', [{ attachmentId: id(1), bytes: 1 }])
    ledger.record('b', [{ attachmentId: id(2), bytes: 1 }])
    expect(
      ledger.record('c', [
        { attachmentId: id(3), bytes: 1 },
        { attachmentId: id(4), bytes: 1 },
      ]),
    ).toEqual([id(1), id(2)])
    expect(ledger.usage()).toEqual({ count: 2, bytes: 2 })
  })

  it('clears one session or everything', () => {
    const ledger = new ScreenshotLedger(root())
    ledger.record('a', [{ attachmentId: id(1), bytes: 5 }])
    ledger.record('b', [{ attachmentId: id(2), bytes: 7 }])
    expect(ledger.clear('a').map((item) => item.attachmentId)).toEqual([id(1)])
    expect(ledger.usage()).toEqual({ count: 1, bytes: 7 })
    expect(ledger.clear().map((item) => item.attachmentId)).toEqual([id(2)])
    expect(ledger.usage()).toEqual({ count: 0, bytes: 0 })
  })
})
