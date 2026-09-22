// Ports key dsh spill-policy / spill-local cases onto the plain middleware.
import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createTestHarness } from '../testing'
import { defineTool, textOf, type ToolExecutionResult } from './definition'
import type { ToolCallInfo } from './registry'
import {
  createSpillMiddleware,
  headTailPreview,
  spillText,
  SPILL_RETRIEVAL_HINT,
} from './spill'

const call = (name = 'bash'): ToolCallInfo => ({
  callId: 'c1',
  name,
  arguments: {},
  signal: new AbortController().signal,
})
const ok = (text: string): ToolExecutionResult => ({
  isError: false,
  content: [{ type: 'text', text }],
})

function spillPathOf(text: string): string {
  const match = /Full formatted result stored at: (.+?)\. Use read/.exec(text)
  if (match?.[1] === undefined)
    throw new Error(`no spill path in: ${text.slice(-300)}`)
  return match[1]
}

describe('spill middleware', () => {
  it('leaves results within the cap untouched', async () => {
    const root = mkdtempSync(join(tmpdir(), 'spill-'))
    const spill = createSpillMiddleware({ root, maxInlineBytes: 100 })
    expect(await spill(call(), ok('x'.repeat(100)))).toBeUndefined()
  })

  it('spills an oversized result: full file content, head/tail preview, dsh notice, under the cap', async () => {
    const root = mkdtempSync(join(tmpdir(), 'spill-'))
    const spill = createSpillMiddleware({ root, maxInlineBytes: 1000 })
    const text = `HEAD${'m'.repeat(10_000)}TAIL`
    const decision = await spill(call(), ok(text))
    expect(decision?.kind).toBe('accept')
    const replaced = textOf(
      decision?.kind === 'accept' ? (decision.content ?? []) : [],
    )
    expect(Buffer.byteLength(replaced)).toBeLessThanOrEqual(1000)
    expect(replaced.startsWith('HEAD')).toBe(true)
    const path = spillPathOf(replaced)
    expect(path.startsWith(root)).toBe(true)
    expect(readFileSync(path, 'utf8')).toBe(text)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    const [preview, notice] = replaced.split('\n\n(')
    expect(preview!.endsWith('TAIL')).toBe(true)
    const omitted = Buffer.byteLength(text) - Buffer.byteLength(preview!)
    expect(`(${notice}`).toBe(
      `(Omitted ${omitted} bytes. Full formatted result stored at: ${path}. ${SPILL_RETRIEVAL_HINT})`,
    )
  })

  it('guarantees the cap across sizes and multibyte text', async () => {
    const root = mkdtempSync(join(tmpdir(), 'spill-'))
    for (const cap of [300, 301, 512, 2048]) {
      const spill = createSpillMiddleware({ root, maxInlineBytes: cap })
      const text = '€'.repeat(cap) + 'z'
      const decision = await spill(call(), ok(text))
      const replaced = textOf(
        decision?.kind === 'accept' ? (decision.content ?? []) : [],
      )
      expect(Buffer.byteLength(replaced)).toBeLessThanOrEqual(cap)
      expect(replaced).not.toContain('�')
    }
  })

  it('keeps the original when the notice alone cannot fit', async () => {
    const root = mkdtempSync(join(tmpdir(), 'spill-'))
    const skipped: string[] = []
    const spill = createSpillMiddleware({
      root,
      maxInlineBytes: 10,
      onSkip: (_n, reason) => skipped.push(reason),
    })
    expect(await spill(call(), ok('x'.repeat(100)))).toBeUndefined()
    expect(skipped).toEqual(['spill notice exceeds maxInlineBytes'])
  })

  it('skips errors, non-text results, and excluded tools (read by default)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'spill-'))
    const spill = createSpillMiddleware({ root, maxInlineBytes: 10 })
    const big = 'x'.repeat(5000)
    expect(await spill(call('read'), ok(big))).toBeUndefined()
    expect(
      await spill(call(), {
        isError: true,
        content: [{ type: 'text', text: big }],
      }),
    ).toBeUndefined()
    expect(
      await spill(call(), {
        isError: false,
        content: [
          { type: 'text', text: big },
          { type: 'image', mediaType: 'image/png', data: 'AA==' } as never,
        ],
      }),
    ).toBeUndefined()
  })

  it('writes one unique file per call, session-scoped, through the registry', async () => {
    const root = mkdtempSync(join(tmpdir(), 'spill-'))
    const h = createTestHarness()
    h.tools.register(
      defineTool({
        name: 'big',
        description: 'big',
        input: z.object({}),
        execute: async () => 'y'.repeat(60_000),
      }),
    )
    h.tools.postExecute.push(createSpillMiddleware({ root }))
    const agent = h.agent('spill-session')
    const exec = (id: string) =>
      h.tools.execute({
        callId: id,
        name: 'big',
        arguments: {},
        agent,
        signal: new AbortController().signal,
      })
    const a = spillPathOf(textOf((await exec('a')).content))
    const b = spillPathOf(textOf((await exec('b')).content))
    expect(a).not.toBe(b)
    expect(dirname(a)).toBe(dirname(b))
    expect(dirname(a)).toMatch(/session-[0-9a-f]{12}$/)
    expect(
      Buffer.byteLength(textOf((await exec('c')).content)),
    ).toBeLessThanOrEqual(50_000)
  })
})

describe('spillText / headTailPreview', () => {
  it('saves under root with a sanitized label', async () => {
    const root = mkdtempSync(join(tmpdir(), 'spill-'))
    const ref = await spillText(root, 'hello', '../evil name.txt')
    expect(dirname(ref.path)).toBe(root)
    expect(ref.path).not.toContain('../')
    expect(ref.bytes).toBe(5)
    expect(readFileSync(ref.path, 'utf8')).toBe('hello')
  })

  it('splits the budget ceil/floor and reports exact omitted bytes', () => {
    expect(headTailPreview('abcdefghij', 5)).toEqual({
      text: 'abcij',
      omittedBytes: 5,
    })
    expect(headTailPreview('abc', 5)).toEqual({ text: 'abc', omittedBytes: 0 })
  })
})
