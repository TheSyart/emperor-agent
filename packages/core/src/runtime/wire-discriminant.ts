import {
  RUNTIME_EVENT_NAMES,
  type RuntimeEventName,
} from '../harness/projection/wire-names'
import type { RuntimeEvent } from './types'

/** Runtime discriminants accepted at the renderer/ACP wire boundary. */
export { RUNTIME_EVENT_NAMES, type RuntimeEventName }

type MissingRuntimeEventName = Exclude<RuntimeEvent['event'], RuntimeEventName>
type ExtraRuntimeEventName = Exclude<RuntimeEventName, RuntimeEvent['event']>
const _runtimeEventNamesCoverUnion: [MissingRuntimeEventName] extends [never]
  ? true
  : never = true
const _runtimeEventNamesDoNotInventEvents: [ExtraRuntimeEventName] extends [
  never,
]
  ? true
  : never = true
void _runtimeEventNamesCoverUnion
void _runtimeEventNamesDoNotInventEvents

const RUNTIME_EVENT_NAME_SET: ReadonlySet<string> = new Set(RUNTIME_EVENT_NAMES)

export function isRuntimeEventWire(input: unknown): input is RuntimeEvent {
  if (!input || typeof input !== 'object') return false
  const event = (input as { event?: unknown }).event
  return typeof event === 'string' && RUNTIME_EVENT_NAME_SET.has(event)
}
