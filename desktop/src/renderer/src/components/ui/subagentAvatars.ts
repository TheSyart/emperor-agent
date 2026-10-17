/** Approved measured portraits. Identity alone selects art; status never does. */
import frames from '../../assets/subagent-avatars/frames.json'
import A from '../../assets/subagent-avatars/A-transparent.png'
import B from '../../assets/subagent-avatars/B-transparent.png'
import C from '../../assets/subagent-avatars/C-transparent.png'
import D from '../../assets/subagent-avatars/D-transparent.png'
export const subagentFrames = frames
const sheets: Record<string, string> = { A, B, C, D }
export function subagentFrame(sessionId: string) {
  let hash = 0x811c9dc5
  for (let i = 0; i < sessionId.length; i++)
    hash = Math.imul(hash ^ sessionId.charCodeAt(i), 0x01000193) >>> 0
  return subagentFrames[hash % subagentFrames.length]!
}
export function subagentSheet(group: string): string {
  return sheets[group]!
}
