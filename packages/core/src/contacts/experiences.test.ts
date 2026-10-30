/**
 * CP-04: a contact's working experiences — idempotent distillation, scope
 * recall within 4 KiB, deletion tombstones and old feedback waiting for
 * confirmation.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ContactExperienceCollector } from './experience-collector'
import type { ExperienceTurn } from './experience-collector'
import { ContactExperienceStore, recallText } from './experiences'

function store() {
  return new ContactExperienceStore({
    stateRoot: mkdtempSync(join(tmpdir(), 'emperor-xp-')),
    now: () => 1_800_000_000_000,
  })
}

const SOURCE = {
  sessionId: 's1',
  turnId: 't1',
  messageIds: ['m1'],
  roleVersion: 3,
}

describe('the experience store (CP-04)', () => {
  it('adds once per source turn and keeps the order', async () => {
    const experiences = store()
    const added = await experiences.add(
      'ct-a',
      [
        { text: '先跑测试再下结论', evidence: [{ kind: 'tool_result', ref: 'c1' }], status: 'active' },
        { text: '含糊的猜测', status: 'candidate' },
      ],
      SOURCE,
    )
    expect(added.map((entry) => entry.status)).toEqual(['active', 'candidate'])
    const again = await experiences.add(
      'ct-a',
      [{ text: '不该重复' }],
      SOURCE,
    )
    expect(again).toEqual([])
    expect((await experiences.list('ct-a')).experiences).toHaveLength(2)
  })

  it('recalls active contact experiences within the budget', async () => {
    const experiences = store()
    await experiences.add(
      'ct-a',
      [
        { text: '短经验', status: 'active', evidence: [{ kind: 'tool_result', ref: 'c1' }] },
        { text: '很长的经验'.repeat(100), status: 'active', evidence: [{ kind: 'tool_result', ref: 'c2' }] },
      ],
      SOURCE,
    )
    const listing = await experiences.list('ct-a')
    const text = recallText(listing.experiences, { kind: 'contact' }, 40)
    expect(text).toContain('短经验')
    expect(text).not.toContain('很长的经验很长的经验很长的经验很长的经验很长的经验很长的经验很长的经验很长的经验很长的经验很长的经验')
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(40)
  })

  it('keeps a group experience inside its group and a session one in its chat', async () => {
    const experiences = store()
    await experiences.add(
      'ct-a',
      [
        { text: '群里先复述任务', status: 'active', scope: { kind: 'group', id: 'g1' }, evidence: [{ kind: 'tool_result', ref: 'c1' }] },
        { text: '这次只对这一段有效', status: 'active', scope: { kind: 'session', id: 's9' }, evidence: [{ kind: 'tool_result', ref: 'c2' }] },
      ],
      SOURCE,
    )
    const listing = await experiences.list('ct-a')
    expect(recallText(listing.experiences, { kind: 'group', id: 'g2' })).toBe('')
    expect(recallText(listing.experiences, { kind: 'group', id: 'g1' })).toContain('群里先复述任务')
    expect(recallText(listing.experiences, { kind: 'session', id: 's9' })).toContain('只对这一段有效')
    expect(recallText(listing.experiences, { kind: 'contact' })).toBe('')
  })

  it('removes with a tombstone and restores as a candidate', async () => {
    const experiences = store()
    const [entry] = await experiences.add(
      'ct-a',
      [{ text: '一条经验', status: 'active', evidence: [{ kind: 'tool_result', ref: 'c1' }] }],
      SOURCE,
    )
    await experiences.remove('ct-a', entry!.id)
    let listing = await experiences.list('ct-a')
    expect(listing.experiences[0]!.status).toBe('deleted')
    expect(recallText(listing.experiences, { kind: 'contact' })).toBe('')
    await experiences.restore('ct-a', entry!.id)
    listing = await experiences.list('ct-a')
    expect(listing.experiences[0]!.status).toBe('candidate')
  })

  it('imports old feedback once, waiting for confirmation', async () => {
    const experiences = store()
    await experiences.importLegacy('ct-a', [
      { rawText: '2026-10-20 · 👍 · 「先给结论」', rating: 'up', date: '2026-10-20' },
    ])
    await experiences.importLegacy('ct-a', [{ rawText: '不该重复', rating: null }])
    const listing = await experiences.list('ct-a')
    expect(listing.legacy).toHaveLength(1)
    expect(listing.legacy[0]!.status).toBe('needs_confirmation')
    expect(recallText([], { kind: 'contact' })).toBe('')
  })
})

describe('the experience collector (CP-04)', () => {
  const turn = (items: ExperienceTurn['items']): ExperienceTurn => ({
    contactId: 'ct-a',
    contactName: '审稿人',
    sessionId: 's1',
    turnId: 't1',
    roleVersion: 3,
    scope: { kind: 'contact' },
    items,
    messageIds: ['m1'],
  })

  it('keeps a cited conclusion and leaves an uncited one pending', async () => {
    const experiences = store()
    const complete = vi.fn(async () =>
      JSON.stringify([
        { text: '改完先跑测试', conditions: '改代码后', scope: 'contact', evidenceRefs: ['c1'] },
        { text: '猜的', scope: 'contact', evidenceRefs: ['missing'] },
      ]),
    )
    const collector = new ContactExperienceCollector({
      store: experiences,
      complete,
    })
    collector.collect(
      turn([
        { role: 'user', text: '改一下登录', ref: 'm1' },
        { role: 'tool', text: 'tests passed', ref: 'c1' },
        { role: 'assistant', text: '改完了，测试通过。', ref: 'm2' },
      ]),
    )
    await new Promise((resolve) => setTimeout(resolve, 50))
    const listing = await experiences.list('ct-a')
    expect(listing.experiences.map((entry) => [entry.text, entry.status])).toEqual([
      ['改完先跑测试', 'active'],
      ['猜的', 'candidate'],
    ])
    expect(complete).toHaveBeenCalledOnce()
  })

  it('does not call the model for a turn with no substance', async () => {
    const experiences = store()
    const complete = vi.fn(async () => '[]')
    const collector = new ContactExperienceCollector({
      store: experiences,
      complete,
    })
    collector.collect(
      turn([
        { role: 'user', text: '收到', ref: 'm1' },
        { role: 'assistant', text: '好的。', ref: 'm2' },
      ]),
    )
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(complete).not.toHaveBeenCalled()
  })

  it('records a failed distillation instead of throwing', async () => {
    const experiences = store()
    const collector = new ContactExperienceCollector({
      store: experiences,
      complete: async () => {
        throw new Error('模型不可用')
      },
    })
    collector.collect(
      turn([
        { role: 'tool', text: 'ok', ref: 'c1' },
        { role: 'assistant', text: 'done'.repeat(30), ref: 'm2' },
      ]),
    )
    await new Promise((resolve) => setTimeout(resolve, 50))
    const listing = await experiences.list('ct-a')
    expect(listing.lastError?.message).toContain('模型不可用')
  })
})
