/** Content-block structure helpers (ported from dsh-llm content.ts). */

import type { Message } from './message'
import type { ContentBlock, ImageAttachmentRef } from './types'

/** Model-facing stand-in for an image removed to fit a request bound. */
export const OFFLOADED_IMAGE_TEXT =
  '[image omitted to keep the request within its image limit; older images are omitted first. If this image is still needed, read its file again when a path is available; otherwise ask the user to attach it again.]'

/** Stable text shown to a model that cannot accept images. */
export function textOnlyImageText(ref: ImageAttachmentRef): string {
  return `[image omitted because this model accepts text only; attachment ${ref.attachmentId}]`
}

/** True when content contains an image block, walking nested tool results. */
export function contentHasImage(content: readonly ContentBlock[]): boolean {
  return content.some(
    (block) =>
      block.type === 'image' ||
      (block.type === 'tool-result' && contentHasImage(block.content)),
  )
}

function mapImages(
  blocks: readonly ContentBlock[],
  replace: (
    block: Extract<ContentBlock, { type: 'image' }>,
  ) => ContentBlock | undefined,
): ContentBlock[] {
  let next: ContentBlock[] | undefined
  for (const [index, block] of blocks.entries()) {
    if (block.type === 'image') {
      const replacement = replace(block)
      if (replacement !== undefined) {
        next ??= blocks.slice(0, index)
        next.push(replacement)
        continue
      }
    }
    if (block.type === 'tool-result') {
      const content = mapImages(block.content, replace)
      if (content !== block.content) {
        next ??= blocks.slice(0, index)
        next.push({ ...block, content })
        continue
      }
    }
    next?.push(block)
  }
  return next ?? (blocks as ContentBlock[])
}

/** Project image history into deterministic text for a text-only model. */
export function projectImagesForTextModel(
  messages: readonly Message[],
): Message[] {
  if (!messages.some((message) => contentHasImage(message.content)))
    return [...messages]
  return messages.map((message) => {
    const content = mapImages(message.content, (block) => ({
      type: 'text',
      text: textOnlyImageText(block.attachment),
    }))
    return content === message.content ? message : { ...message, content }
  })
}

/**
 * Replace the oldest images (base64 size accounting) until the accumulated
 * payload fits `maxBytes`. Deterministic from durable order; durable messages
 * are never mutated.
 */
export function offloadRequestImages(
  messages: readonly Message[],
  maxBytes: number | undefined,
): Message[] {
  if (maxBytes === undefined) return [...messages]
  const lengths: number[] = []
  const collect = (blocks: readonly ContentBlock[]): void => {
    for (const block of blocks) {
      if (block.type === 'image')
        lengths.push(Math.ceil(block.attachment.bytes / 3) * 4)
      else if (block.type === 'tool-result') collect(block.content)
    }
  }
  for (const message of messages) collect(message.content)
  let total = lengths.reduce((sum, bytes) => sum + bytes, 0)
  let remove = 0
  while (total > maxBytes && remove < lengths.length) {
    total -= lengths[remove] ?? 0
    remove += 1
  }
  if (remove === 0) return [...messages]
  let remaining = remove
  return messages.map((message) => {
    const content = mapImages(message.content, () => {
      if (remaining <= 0) return undefined
      remaining -= 1
      return { type: 'text', text: OFFLOADED_IMAGE_TEXT }
    })
    return content === message.content ? message : { ...message, content }
  })
}

/** Resolves stored image bytes for request serialization. */
export type ImageResolver = (
  ref: ImageAttachmentRef,
  signal?: AbortSignal,
) => Promise<{ data: Uint8Array; mediaType: string }>
