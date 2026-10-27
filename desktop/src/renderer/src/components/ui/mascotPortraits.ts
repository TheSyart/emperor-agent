/**
 * The mascot's portraits an Avatar can wear (BRD-04), by pose: 小单 in the
 * robe outfit, crown on (the built-in Emperor contact). Pure.
 */
import crownHead from '../../assets/mascot/emperor-head.webp'

const PORTRAITS: Readonly<Record<string, string>> = {
  'crown-head': crownHead,
}

/** The image of a pose; null for one there is no portrait of. */
export function mascotPortrait(pose: string | null | undefined): string | null {
  return (pose && PORTRAITS[pose]) || null
}
