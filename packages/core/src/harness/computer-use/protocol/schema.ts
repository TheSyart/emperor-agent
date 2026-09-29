/**
 * JSON Schema export of the helper protocol, checked in as `schema.json` so
 * native helpers can validate against the same contract. `schema.test.ts`
 * fails when the checked-in copy drifts from the zod source.
 */

import { z } from 'zod'
import {
  HELPER_EVENTS,
  HELPER_METHODS,
  HELPER_PROTOCOL_VERSION,
  helperMessageSchema,
} from './messages'

function jsonSchema(schema: z.ZodType): unknown {
  const { $schema: _schema, ...rest } = z.toJSONSchema(schema, {
    io: 'input',
    unrepresentable: 'any',
  }) as Record<string, unknown>
  return rest
}

export function helperProtocolJsonSchema(): Record<string, unknown> {
  return {
    $comment:
      'Generated from harness/computer-use/protocol/messages.ts — do not edit by hand.',
    protocol: HELPER_PROTOCOL_VERSION,
    message: jsonSchema(helperMessageSchema),
    methods: Object.fromEntries(
      Object.entries(HELPER_METHODS).map(([name, spec]) => [
        name,
        { params: jsonSchema(spec.params), result: jsonSchema(spec.result) },
      ]),
    ),
    events: Object.fromEntries(
      Object.entries(HELPER_EVENTS).map(([name, schema]) => [
        name,
        jsonSchema(schema),
      ]),
    ),
  }
}
