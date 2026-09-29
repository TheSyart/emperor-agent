/**
 * GUI tool results (spec 00 §9.2): a bounded JSON summary first, page or
 * window content inside an untrusted external-content envelope, and an
 * optional image block for vision routes. The whole result stays under
 * {@link MAX_RESULT_BYTES} — below the spill threshold, so a GUI result
 * never lands in a spill file.
 */

import {
  createBoundedExternalContentEnvelope,
  renderExternalContentEnvelope,
} from '../../../external-content'
import type { ContentBlock, ImageAttachmentRef } from '../../../llm/types'
import type { ToolReturn } from '../../tools/definition'
import type { UiError, UiErrorPayload } from '../errors'
import type { UiElement, UiObservation } from '../types'

export const MAX_RESULT_BYTES = 40_000
const SUMMARY_LIMIT = 8_000

export interface UntrustedContent {
  readonly kind: 'browser' | 'desktop'
  readonly locator: string | null
  readonly transport: string
  readonly content: string
}

export interface UiResultInput {
  readonly tool: string
  readonly summary: Record<string, unknown>
  readonly untrusted?: UntrustedContent
  readonly image?: ImageAttachmentRef
  readonly meta: Record<string, unknown>
}

function boundedJson(value: Record<string, unknown>): string {
  const text = JSON.stringify(value)
  if (text.length <= SUMMARY_LIMIT) return text
  return JSON.stringify({
    ...Object.fromEntries(
      Object.entries(value).filter(
        ([, item]) => JSON.stringify(item).length < 512,
      ),
    ),
    truncated: true,
  })
}

export function uiResult(input: UiResultInput): ToolReturn {
  const summary = boundedJson({
    status: 'ok',
    tool: input.tool,
    ...input.summary,
  })
  const content: ContentBlock[] = [{ type: 'text', text: summary }]
  if (input.untrusted !== undefined) {
    const envelope = createBoundedExternalContentEnvelope({
      source: {
        kind: input.untrusted.kind,
        locator: input.untrusted.locator,
        transport: input.untrusted.transport,
      },
      content: input.untrusted.content,
      maxBytes: MAX_RESULT_BYTES - Buffer.byteLength(summary) - 256,
    })
    content.push({
      type: 'text',
      text: renderExternalContentEnvelope(envelope),
    })
  }
  if (input.image !== undefined)
    content.push({ type: 'image', attachment: input.image })
  return {
    content,
    meta: { computerUse: { v: 1, tool: input.tool, ...input.meta } },
  }
}

export function uiErrorResult(
  tool: string,
  error: UiError,
  meta: Record<string, unknown> = {},
): ToolReturn {
  const payload: UiErrorPayload = error.toPayload()
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({ status: 'error', tool, ...payload }),
      },
    ],
    isError: true,
    meta: { computerUse: { v: 1, tool, error: payload, ...meta } },
  }
}

function quote(value: string, limit: number): string {
  const clean = value.replace(/\s+/g, ' ').trim()
  return JSON.stringify(
    clean.length > limit ? `${clean.slice(0, limit)}…` : clean,
  )
}

/**
 * A value the helper cut from the top starts with `…`: a terminal's
 * scrollback, whose newest output is at the end. Keep that end, and more of
 * it, so the model can read back what its command printed.
 */
const TAIL_VALUE_CHARS = 800

function quoteValue(value: string): string {
  if (!value.startsWith('…')) return quote(value, 200)
  const clean = value.slice(1).replace(/\s+/g, ' ').trim()
  return JSON.stringify(
    `…${clean.length > TAIL_VALUE_CHARS ? clean.slice(-TAIL_VALUE_CHARS) : clean}`,
  )
}

/** One compact line per element: `r3.4 button "Submit" [disabled] actions=press`. */
export function renderElement(element: UiElement): string {
  const parts = [element.ref, element.role]
  if (element.name !== undefined && element.name !== '')
    parts.push(quote(element.name, 120))
  if (element.value !== undefined)
    parts.push(`value=${quoteValue(element.value)}`)
  if (element.states !== undefined && element.states.length > 0)
    parts.push(`[${element.states.join(',')}]`)
  if (element.frameId !== undefined && element.frameId !== 'main')
    parts.push(`frame=${element.frameId}`)
  if (element.actions.length > 0)
    parts.push(`actions=${element.actions.join(',')}`)
  return parts.join(' ')
}

/** Page content of an observation, for the untrusted envelope. */
export function renderObservationContent(observation: UiObservation): string {
  const lines = [
    `title: ${quote(observation.title, 300)}`,
    `location: ${observation.urlOrApp}`,
  ]
  if (observation.removed !== undefined && observation.removed.length > 0)
    lines.push(`removed: ${observation.removed.join(' ')}`)
  lines.push('elements:')
  for (const element of observation.elements) lines.push(renderElement(element))
  if (observation.textExcerpt !== undefined && observation.textExcerpt !== '')
    lines.push('text:', observation.textExcerpt)
  return lines.join('\n')
}
