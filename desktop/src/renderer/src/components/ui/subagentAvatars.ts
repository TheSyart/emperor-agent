/**
 * Approved measured portraits. Identity alone selects art; status never does.
 * Kept for the settings preview; the art and the hash live in
 * subagentPortraits so every surface shows the same portrait for an agent.
 */
import frames from '../../assets/subagent-avatars/frames.json'
import { avatarSeed } from '../workspace/environmentModel'
import { SUBAGENT_PORTRAITS, subagentPortrait } from './subagentPortraits'

export const subagentFrames = frames
export function subagentFrame(sessionId: string) {
  return subagentPortrait(avatarSeed(sessionId))
}
export function subagentSheet(group: string): string {
  return SUBAGENT_PORTRAITS.find((frame) => frame.group === group)!.sheet
}
