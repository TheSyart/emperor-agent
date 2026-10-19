/**
 * Vendor model lists and connection checks (MOD-02). See
 * `docs/design/vendor-model-apis.md` for each vendor's endpoint, fields,
 * paging and pitfalls.
 */
export { resolveParser, usesPresetBase, type ParserQuery } from './registry'
export {
  ModelDiscovery,
  DISCOVERY_CACHE_TTL_MS,
  connectionHash,
  type ModelDiscoveryOptions,
} from './service'
export { DISCOVERY_TIMEOUT_MS, type DiscoveryFetch } from './http'
export { MAX_MODELS, MAX_PAGES } from './paging'
export type { ModelListParser } from './parser'
export {
  DiscoveryError,
  type ConnectionFix,
  type DiscoveredFactField,
  type DiscoveredModel,
  type DiscoveryConnection,
  type DiscoveryErrorCode,
  type DiscoveryFailure,
  type DiscoveryProtocol,
  type DiscoveryResult,
  type DiscoverySuccess,
  type ParserId,
  type ProbeErrorCode,
  type ProbeResult,
  type VendorModel,
} from './types'
