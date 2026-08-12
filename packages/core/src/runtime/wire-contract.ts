import { z } from 'zod'
import { RUNTIME_EVENT_NAMES } from './wire-discriminant'
import type { RuntimeEvent } from './types'

export {
  RUNTIME_EVENT_NAMES,
  isRuntimeEventWire,
  type RuntimeEventName,
} from './wire-discriminant'

export const runtimeEventWireSchema = z
  .object({ event: z.enum(RUNTIME_EVENT_NAMES) })
  .passthrough()

export function parseRuntimeEventWire(input: unknown): RuntimeEvent {
  return runtimeEventWireSchema.parse(input) as RuntimeEvent
}
