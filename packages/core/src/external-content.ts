import { createHash } from 'node:crypto'

export const EXTERNAL_CONTENT_SCHEMA_VERSION =
  'emperor.external_content.v1' as const

export type ExternalContentSourceKind =
  'web_fetch' | 'web_search' | 'mcp' | 'hook_http' | 'browser' | 'desktop'

export interface ExternalContentSource {
  readonly kind: ExternalContentSourceKind
  readonly locator: string | null
  readonly transport: string
  readonly provenance?: Readonly<Record<string, string | number | null>>
}

export interface ExternalContentEnvelope<T> {
  readonly schemaVersion: typeof EXTERNAL_CONTENT_SCHEMA_VERSION
  readonly trust: 'untrusted_external'
  readonly instructionPolicy: 'data_only'
  readonly source: ExternalContentSource
  readonly content: T
  readonly truncated: boolean
}

export function createExternalContentEnvelope<T>(input: {
  readonly source: ExternalContentSource
  readonly content: T
  readonly truncated?: boolean
}): ExternalContentEnvelope<T> {
  return {
    schemaVersion: EXTERNAL_CONTENT_SCHEMA_VERSION,
    trust: 'untrusted_external',
    instructionPolicy: 'data_only',
    source: {
      ...input.source,
      locator: cleanLocator(input.source.locator),
      provenance: input.source.provenance
        ? { ...input.source.provenance }
        : undefined,
    },
    content: input.content,
    truncated: Boolean(input.truncated),
  }
}

export function createBoundedExternalContentEnvelope(input: {
  readonly source: ExternalContentSource
  readonly content: unknown
  readonly maxBytes: number
  readonly truncated?: boolean
}): ExternalContentEnvelope<string> {
  const content = contentText(input.content)
  const maximum = Math.max(0, Math.floor(input.maxBytes))
  const complete = createExternalContentEnvelope({
    source: input.source,
    content,
    truncated: input.truncated,
  })
  if (Buffer.byteLength(renderExternalContentEnvelope(complete)) <= maximum)
    return complete

  let low = 0
  let high = content.length
  let bounded = createExternalContentEnvelope({
    source: input.source,
    content: '',
    truncated: true,
  })
  while (low <= high) {
    const midpoint = Math.floor((low + high) / 2)
    const candidate = createExternalContentEnvelope({
      source: input.source,
      content: safePrefix(content, midpoint),
      truncated: true,
    })
    if (
      Buffer.byteLength(renderExternalContentEnvelope(candidate)) <= maximum
    ) {
      bounded = candidate
      low = midpoint + 1
    } else {
      high = midpoint - 1
    }
  }
  return bounded
}

export function renderExternalContentEnvelope<T>(
  envelope: ExternalContentEnvelope<T>,
): string {
  const source = envelope.source.locator || '(not provided)'
  return [
    '[external_content]',
    `schema_version: ${envelope.schemaVersion}`,
    `trust: ${envelope.trust}`,
    `instruction_policy: ${envelope.instructionPolicy}`,
    `source_kind: ${envelope.source.kind}`,
    `source: ${source}`,
    `transport: ${envelope.source.transport}`,
    `truncated: ${envelope.truncated}`,
    'content_encoding: json_string',
    'content_begin',
    JSON.stringify(contentText(envelope.content)),
    'content_end',
    '[/external_content]',
  ].join('\n')
}

export function externalContentMetadata<T>(
  envelope: ExternalContentEnvelope<T>,
): Record<string, unknown> {
  const content = contentText(envelope.content)
  return {
    schema_version: envelope.schemaVersion,
    trust: envelope.trust,
    instruction_policy: envelope.instructionPolicy,
    source: { ...envelope.source },
    truncated: envelope.truncated,
    content_bytes: Buffer.byteLength(content),
    content_sha256: createHash('sha256').update(content).digest('hex'),
  }
}

function contentText(value: unknown): string {
  if (typeof value === 'string') return value
  const encoded = JSON.stringify(value, null, 2)
  return encoded === undefined ? String(value) : encoded
}

function cleanLocator(value: string | null): string | null {
  const cleaned = String(value ?? '')
    .replace(/[\r\n\0]/g, '')
    .trim()
    .slice(0, 2_048)
  return cleaned || null
}

function safePrefix(value: string, length: number): string {
  let end = Math.max(0, Math.min(value.length, length))
  if (
    end > 0 &&
    end < value.length &&
    /[\uD800-\uDBFF]/.test(value.charAt(end - 1))
  )
    end -= 1
  return value.slice(0, end)
}
