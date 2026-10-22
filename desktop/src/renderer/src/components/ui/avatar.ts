/**
 * Avatar scale and the stable picks behind it (DS-04): the five sizes, the
 * first letter a tile shows, and the avatar colour slot for a name.
 */
import { avatarIndex } from '../workspace/environmentModel'

export const AVATAR_SIZES = [16, 20, 24, 28, 40] as const
export type AvatarSize = (typeof AVATAR_SIZES)[number]

export function isAvatarSize(value: unknown): value is AvatarSize {
  return AVATAR_SIZES.includes(value as AvatarSize)
}

/** The scale size closest to `px` (a tie goes to the larger size). */
export function nearestAvatarSize(px: number): AvatarSize {
  let best: AvatarSize = AVATAR_SIZES[0]
  for (const size of AVATAR_SIZES)
    if (Math.abs(size - px) <= Math.abs(best - px)) best = size
  return best
}

/** The first character of a name, upper-cased ('?' when there is none). */
export function avatarInitial(label: string | null | undefined): string {
  return Array.from((label ?? '').trim())[0]?.toUpperCase() ?? '?'
}

/** 1-based --avatar-N colour slot, stable for an id or name. */
export function avatarColorSlot(seed: string): number {
  return avatarIndex(seed) + 1
}
