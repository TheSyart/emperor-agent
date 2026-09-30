/**
 * Public surface of the browser-import module (ST-06). The renderer-facing IPC
 * and the write-back (vault + persistent session) added in the second half
 * import from here.
 */
export type {
  BrowserData,
  BrowserId,
  BrowserProfile,
  CookieRecord,
  DiscoveredBrowser,
  PasswordRecord,
  ReadBrowserDataDeps,
  ReadBrowserDataOptions,
  RunningReason,
  RunningStatus,
  SecurityRunner,
} from './types'
export {
  detectRunning,
  discoverBrowsers,
  listProfiles,
  userDataDir,
} from './browser-discovery'
export {
  decryptValue,
  deriveKey,
  readSafeStoragePassword,
  safeStorageService,
} from './chrome-crypto'
export { readBrowserData } from './read-browser-data'
export {
  ImportError,
  importBrowserData,
  listImportSources,
} from './import-service'
export type {
  CookieSink,
  CookieToSet,
  ImportDeps,
  ImportErrorReason,
  ImportResult,
  ImportRunRequest,
  ImportSource,
  ImportSourceProfile,
  ImportSources,
} from './import-service'
