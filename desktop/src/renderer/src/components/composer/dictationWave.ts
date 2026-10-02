/**
 * The recording bar's waveform (RV-06) as slots from left to right: the
 * microphone's latest levels, newest on the right, one slot each; silence,
 * and the time before the recording began, as dots. With reduced motion
 * the waveform does not scroll: only the newest slot shows a level, the
 * current one.
 */

/** Slots in the waveform: enough for the widest composer, 5px each. */
export const DICTATION_WAVE_SLOTS = 128
/** Quieter than this is drawn as a dot. */
export const DICTATION_QUIET_LEVEL = 0.08

/** A bar's level (0–1 of its full height), or null for a dot. */
export type DictationWaveSlot = number | null

export function dictationWaveSlots(
  levels: readonly number[],
  options: { slots?: number; reducedMotion?: boolean } = {},
): DictationWaveSlot[] {
  const count = options.slots ?? DICTATION_WAVE_SLOTS
  const shown = levels.slice(options.reducedMotion ? -1 : -count)
  const slots: DictationWaveSlot[] = Array.from(
    { length: count - shown.length },
    () => null,
  )
  for (const level of shown)
    slots.push(level >= DICTATION_QUIET_LEVEL ? Math.min(1, level) : null)
  return slots
}
