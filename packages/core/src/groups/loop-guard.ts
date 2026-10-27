/**
 * 防打转 (GRP-07): group chat has no quota, so a turn could go round in
 * circles. This is not a count limit: it looks only at two members trading
 * messages, and flags the pair once they have alternated at least
 * LOOP_MIN_EXCHANGES times and each of their last two messages adds almost
 * nothing to the two before it. Similarity is Jaccard over character
 * 3-grams, which works for Chinese without word segmentation.
 */
import type { ContactId, GroupMessage } from './types'

/** Alternating messages between the same two members before it can trigger. */
export const LOOP_MIN_EXCHANGES = 4
/** Below this novelty (less than half new) a message adds nothing new. */
export const LOOP_NOVELTY = 0.5

function shingles(text: string): Set<string> {
  const plain = text.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
  const chars = Array.from(plain)
  const out = new Set<string>()
  if (chars.length < 3) {
    if (chars.length) out.add(chars.join(''))
    return out
  }
  for (let i = 0; i + 3 <= chars.length; i++)
    out.add(chars.slice(i, i + 3).join(''))
  return out
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size && !b.size) return 1
  let shared = 0
  for (const s of a) if (b.has(s)) shared++
  return shared / (a.size + b.size - shared)
}

/** 1 − the highest similarity to any earlier message; 0 for an empty reply. */
export function novelty(reply: string, earlier: readonly string[]): number {
  const mine = shingles(reply)
  if (!mine.size) return 0
  const best = Math.max(0, ...earlier.map((e) => jaccard(mine, shingles(e))))
  return Math.round((1 - best) * 1000) / 1000
}

export interface LoopStall {
  stalled: boolean
  pair?: [ContactId, ContactId]
}

/** Whether the tail of a turn's messages is two members going round in circles. */
export function loopStall(messages: readonly GroupMessage[]): LoopStall {
  // Only members' spoken messages; system lines and 没有补充 are skipped,
  // anything from the user ends the run.
  const tail: GroupMessage[] = []
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.from === 'user') break
    if (m.from === 'system' || m.kind !== 'say') continue
    tail.unshift(m)
  }
  let run = 0
  for (let i = tail.length - 1; i >= 0; i--) {
    const m = tail[i]!
    if (i === tail.length - 1) {
      run = 1
      continue
    }
    const next = tail[i + 1]!
    const other = tail[tail.length - 2]
    const a = tail[tail.length - 1]!.from
    const b = other?.from
    if (m.from === next.from || (m.from !== a && m.from !== b)) break
    run++
  }
  if (run < LOOP_MIN_EXCHANGES) return { stalled: false }
  const pairRun = tail.slice(-run)
  const texts = pairRun.map((m) => m.text)
  const last = texts.length - 1
  const fresh = [
    novelty(texts[last]!, texts.slice(last - 2, last)),
    novelty(texts[last - 1]!, texts.slice(last - 3, last - 1)),
  ]
  if (fresh.every((v) => v < LOOP_NOVELTY))
    return {
      stalled: true,
      pair: [pairRun[0]!.from, pairRun[1]!.from] as [ContactId, ContactId],
    }
  return { stalled: false }
}
