import frames from '../../assets/subagent-avatars/frames.json'
import warm from '../../assets/subagent-avatars/A-sheet.webp'
import nature from '../../assets/subagent-avatars/B-sheet.webp'
import studio from '../../assets/subagent-avatars/C-sheet.webp'
import imagination from '../../assets/subagent-avatars/D-sheet.webp'

const sheets: Record<string, string> = {
  A: warm,
  B: nature,
  C: studio,
  D: imagination,
}

/** Local imagegen originals, losslessly encoded; framing never edits pixels. */
export const SUBAGENT_PORTRAITS = frames.map((frame) => ({
  ...frame,
  sheet: sheets[frame.group]!,
}))

export function subagentPortrait(seed: number) {
  return SUBAGENT_PORTRAITS[(seed >>> 0) % SUBAGENT_PORTRAITS.length]!
}
