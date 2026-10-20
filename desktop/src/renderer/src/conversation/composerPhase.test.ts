import { describe, expect, it } from 'vitest'
import { EMPTY_CHAT_SNAPSHOT } from './chatSnapshot'
import { conversationContent, deriveComposerPhase } from './composerPhase'
import { loadKernelLog, replay } from './testing/fixtures'

describe('composer phase', () => {
  it('derives blank, engaging and active', () => {
    const empty = conversationContent(EMPTY_CHAT_SNAPSHOT)
    expect(
      deriveComposerPhase({ content: empty, promptAttempted: false }),
    ).toBe('blank')
    expect(deriveComposerPhase({ content: empty, promptAttempted: true })).toBe(
      'engaging',
    )
    expect(
      deriveComposerPhase({
        content: empty,
        promptAttempted: true,
        busy: true,
      }),
    ).toBe('active')
    expect(
      deriveComposerPhase({
        content: empty,
        promptAttempted: false,
        pendingInteraction: true,
      }),
    ).toBe('active')
    const { snapshot } = replay(loadKernelLog().root.events)
    expect(
      deriveComposerPhase({
        content: conversationContent(snapshot),
        promptAttempted: false,
      }),
    ).toBe('active')
    // A running turn alone (no row yet) is active too.
    expect(
      deriveComposerPhase({
        content: { rows: 0, turns: 0, running: true },
        promptAttempted: false,
      }),
    ).toBe('active')
  })
})
