import { describe, expect, it } from 'vitest'
import { EMPTY_CHAT_SNAPSHOT } from './chatSnapshot'
import { deriveComposerPhase } from './composerPhase'
import { loadKernelLog, replay } from './testing/fixtures'

describe('composer phase', () => {
  it('derives blank, engaging and active', () => {
    const empty = EMPTY_CHAT_SNAPSHOT
    expect(
      deriveComposerPhase({ snapshot: empty, promptAttempted: false }),
    ).toBe('blank')
    expect(
      deriveComposerPhase({ snapshot: empty, promptAttempted: true }),
    ).toBe('engaging')
    expect(
      deriveComposerPhase({
        snapshot: empty,
        promptAttempted: true,
        busy: true,
      }),
    ).toBe('active')
    expect(
      deriveComposerPhase({
        snapshot: empty,
        promptAttempted: false,
        pendingInteraction: true,
      }),
    ).toBe('active')
    const { snapshot } = replay(loadKernelLog().root.events)
    expect(deriveComposerPhase({ snapshot, promptAttempted: false })).toBe(
      'active',
    )
  })
})
