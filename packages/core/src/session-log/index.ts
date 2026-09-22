/** Append-only session log: the single durable agent trajectory. */
export * from './types'
export * from './session'
export * from './store'
export {
  deriveEventMessage,
  foldSurface,
  isAppendSurfaceEvent,
  isReplacementSurfaceEvent,
  isSurfaceEvent,
  isSurfaceEligibleType,
  type SessionSurface,
} from './surface'
export {
  canonicalHeader,
  foldRequestHeader,
  headerEquals,
} from './request-header'
export {
  interruptedTurnClosers,
  TOOL_NOT_STARTED,
  TOOL_OUTCOME_UNKNOWN,
} from './repair'
export {
  decodeStorageRecord,
  packChunkRuns,
  type ChunkRow,
  type StorageRecord,
} from './chunk-rows'
export { isJsonValue, snapshotJsonValue } from './json'
export {
  DEFAULT_HISTORY_MAX_MESSAGES,
  historyFloor,
  historyPage,
  paginate,
  sanitizeForWire,
  type HistoryPageOptions,
  type SessionHistoryPage,
  type WireSessionEvent,
  type WireTruncation,
} from './history'
