import { describe, expect, it } from 'vitest'
import {
  DICTATION_QUIET_LEVEL,
  DICTATION_WAVE_SLOTS,
  dictationWaveSlots,
} from './dictationWave'

describe('the recording bar waveform (RV-06)', () => {
  it('is a row of dots before anything is heard', () => {
    const slots = dictationWaveSlots([])
    expect(slots).toHaveLength(DICTATION_WAVE_SLOTS)
    expect(slots.every((slot) => slot === null)).toBe(true)
  })

  it('puts the newest level on the right and quiet ones as dots', () => {
    expect(dictationWaveSlots([0.2, 0.01, 0.9], { slots: 5 })).toEqual([
      null,
      null,
      0.2,
      null,
      0.9,
    ])
    expect(
      dictationWaveSlots([DICTATION_QUIET_LEVEL, 1.4], { slots: 2 }),
    ).toEqual([DICTATION_QUIET_LEVEL, 1])
  })

  it('lets the oldest levels leave on the left', () => {
    expect(dictationWaveSlots([0.1, 0.2, 0.3, 0.4], { slots: 3 })).toEqual([
      0.2, 0.3, 0.4,
    ])
  })

  it('shows only the current level, without scrolling, for reduced motion', () => {
    expect(
      dictationWaveSlots([0.5, 0.9, 0.3], { slots: 4, reducedMotion: true }),
    ).toEqual([null, null, null, 0.3])
    expect(dictationWaveSlots([], { slots: 2, reducedMotion: true })).toEqual([
      null,
      null,
    ])
  })
})
