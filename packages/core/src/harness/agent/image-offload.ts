/**
 * Logged image offload (KRN-05, DSH-13). Before each request on a vision
 * route, once the surface's images exceed the route's inline budget, the
 * oldest image-bearing nodes are offloaded: an `image/offload` event names
 * each one, and the session sends a placeholder for it from then on, on
 * any route, after a fallback and after a reopen. Offloading goes down to
 * half the budget, so a long run of screenshots offloads in batches rather
 * than one image (and one broken prompt prefix) per step. The node with
 * the newest image is never offloaded here; the adapter's own request
 * bound still applies to it.
 */

import { requestImageBytes } from '../../llm/content'
import type { ContentBlock } from '../../llm/types'
import type { Session } from '../../session-log/session'

/** Offloading stops once the images fit this share of the budget. */
export const OFFLOAD_TARGET_RATIO = 0.5

function imageBytes(blocks: readonly ContentBlock[]): number {
  let bytes = 0
  for (const block of blocks) {
    if (block.type === 'image') bytes += requestImageBytes(block.attachment)
    else if (block.type === 'tool-result') bytes += imageBytes(block.content)
  }
  return bytes
}

/** Offload the oldest images over `maxBytes`; returns the offloaded node seqs. */
export function offloadImages(session: Session, maxBytes: number): number[] {
  const candidates: Array<{ seq: number; bytes: number }> = []
  let total = 0
  for (const seq of session.surface.nodes) {
    const event = session.events[seq]
    const message =
      event === undefined ? null : session.deriveEventMessage(event)
    if (message === null) continue
    const bytes = imageBytes(message.content)
    if (bytes === 0) continue
    candidates.push({ seq, bytes })
    total += bytes
  }
  if (total <= maxBytes) return []
  const target = Math.floor(maxBytes * OFFLOAD_TARGET_RATIO)
  const offloaded: number[] = []
  for (const candidate of candidates.slice(0, -1)) {
    if (total <= target) break
    session.append('image/offload', {
      seq: candidate.seq,
      reason: 'request-bytes',
    })
    total -= candidate.bytes
    offloaded.push(candidate.seq)
  }
  return offloaded
}
