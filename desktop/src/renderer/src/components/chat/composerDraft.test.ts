import { describe, expect, it } from 'vitest'
import type { AttachmentRef } from '../../types'
import {
  clearComposerDrafts,
  saveComposerDraft,
  takeComposerDraft,
} from '../../composables/useComposerDrafts'
import { EMPTY_DRAFT, mergeDrafts } from './composerDraft'

const file = (id: string) => ({ id, name: `${id}.png` }) as AttachmentRef
const skill = (start: number) => ({
  kind: 'skill' as const,
  id: 'review',
  label: 'review',
  start,
  end: start + 7,
})

describe('composer drafts', () => {
  it('fills an empty composer as is', () => {
    expect(
      mergeDrafts(EMPTY_DRAFT, {
        text: '/review this',
        references: [skill(0)],
        attachments: [file('a')],
      }),
    ).toEqual({
      text: '/review this',
      references: [skill(0)],
      attachments: [file('a')],
    })
  })

  it('appends after what the user typed, moving chips along', () => {
    const merged = mergeDrafts(
      { text: 'mine', references: [], attachments: [file('a')] },
      {
        text: '/review it',
        references: [skill(0)],
        attachments: [file('a'), file('b')],
      },
    )
    expect(merged.text).toBe('mine\n\n/review it')
    expect(
      merged.text.slice(merged.references[0]!.start, merged.references[0]!.end),
    ).toBe('/review')
    expect(merged.attachments.map((a) => a.id)).toEqual(['a', 'b'])
  })

  it('does not duplicate the same text', () => {
    expect(
      mergeDrafts(
        { text: 'same', references: [], attachments: [] },
        { text: 'same', references: [], attachments: [] },
      ).text,
    ).toBe('same')
  })

  it('keeps one draft per session and hands it back once', () => {
    clearComposerDrafts()
    saveComposerDraft('A', {
      text: 'for A',
      references: [],
      attachments: [file('x')],
    })
    saveComposerDraft('B', EMPTY_DRAFT)
    expect(takeComposerDraft('B')).toBeNull()
    expect(takeComposerDraft('A')).toEqual({
      text: 'for A',
      references: [],
      attachments: [file('x')],
    })
    expect(takeComposerDraft('A')).toBeNull()
  })
})
