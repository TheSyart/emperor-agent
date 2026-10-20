export { PublicHttpClient, PublicHttpError } from '../network/public-http'
export type {
  PublicHttpResolvedAddress,
  PublicHttpTransport,
  PublicHttpTransportRequest,
  PublicHttpTransportResponse,
} from '../network/public-http'
export type { WebFetchClient } from '../network/web-fetch-client'
export {
  createEmperorPathCatalog,
  defaultEmperorHome,
  defaultStateRoot,
  legacyDefaultStateRoot,
} from '../runtime/paths'
export {
  applyPendingHomeRestore,
  bootstrapEmperorHome,
  compareAppVersions,
  CURRENT_DATA_VERSION,
  CURRENT_STATE_LAYOUT_VERSION,
  InstallationBootstrapError,
  loadHomeBackupModule,
  runPendingDataMigrations,
} from '../runtime/installation'
// REL-03: data versions, read-only newer files, 备份与恢复. The backup code
// is reached through loadHomeBackupModule() only (its own chunk, never in
// the main bundle), so only its types are exported here.
export {
  DataFileNewerError,
  NEWER_FILE_MESSAGE,
  declaredVersion,
  newerVersionOf,
} from '../store/persistence/version'
export { DATA_FILES, inspectDataFiles } from '../storage/data-files'
export type { DataFileSpec, DataFileState } from '../storage/data-files'
export type {
  BackupCategoryId,
  BackupPlan,
  BackupPlanCategory,
  HomeBackupManifest,
  RestoreResult,
} from '../storage/backup'
export type {
  BootstrapEmperorHomeOptions,
  BootstrapEmperorHomeResult,
  InstallationBootstrapErrorCode,
  InstallationStateV1,
  StateLayoutVersion,
} from '../runtime/installation'
export type {
  EmperorPathCatalog,
  EmperorPathId,
  PathCreatePolicy,
  PathDescriptor,
  PathScope,
} from '../runtime/paths'
export {
  migrateLegacyRuntimeSkills,
  runtimeRevision,
  validateRuntimeManifest,
} from '../runtime/resources'
export type {
  LegacySkillMigrationResult,
  RuntimeManifest,
} from '../runtime/resources'
export type { PtyHandle, PtyHost } from '../workspace/terminal'
export type {
  ActHooks,
  ActOutcome,
  ActRequest,
  BrowserDriver,
  BrowserProfileSpec,
  ComputerUseHostPort,
  CredentialVaultPort,
  CredentialFillRequest,
  DesktopCredentialFillRequest,
  DesktopAppInfo,
  DesktopMenuItem,
  DesktopMenuListing,
  DesktopWindowInfo,
  DriverEvent,
  DriverEventListener,
  DriverObservation,
  NativeDesktopDriver,
  NavigationPolicy,
  NavigationRequest,
  ObserveBudget,
  ObserveQuery,
  ObserveRequest,
  ScreenshotCapture,
  ScreenshotRequest,
  TargetCloseReason,
  TargetDriver,
  TargetSnapshot,
  WaitOutcome,
  WaitRequest,
  DownloadRequest,
  UploadRequest,
  SitePermissionPolicy,
  SitePermissionRequest,
} from '../harness/computer-use/port'
export { UiError, UI_ERROR_CODES } from '../harness/computer-use/errors'
export { looksSensitive, maskedValue } from '../harness/computer-use/sensitive'
export {
  downloadBucket,
  isExecutableDownload,
  safeDownloadName,
} from '../harness/computer-use/downloads'
export {
  defaultBrowserPreferences,
  normalizeBrowserPreferences,
} from '../config/local-config'
export type { UiErrorCode } from '../harness/computer-use/errors'
export { searchProbe } from './search-probe'
export type { SearchProbeRequest } from './search-probe'
export { writeJsonAtomic } from '../store/atomic-json'
export { LocalSandbox } from '../harness/sandbox/backend'
export {
  LocalSecretError,
  LocalSecretStore,
  openWithKey,
  sealWithKey,
} from '../security/local-secret-store'
export type {
  LocalSecretProblem,
  LocalSecretStoreOptions,
} from '../security/local-secret-store'
export {
  createLocalKeySealer,
  localSecretKeyPath,
  sealerFromSecretStore,
  SecretSealError,
} from '../security/secret-sealer'
export type { SecretSealer, SecretStoreLike } from '../security/secret-sealer'
export { loadBundledToolCatalog } from '../environment/catalog'
export type { LoadedToolCatalog } from '../environment/catalog'
export type {
  ExternalDriverEvent,
  ExternalHistoryEntry,
  ExternalSiteDecider,
  ExternalSiteVerdict,
} from '../harness/computer-use/port'
export { redactLogText } from '../util/redaction'
export { setCoreLogSink } from '../util/log'
export type { LogLevel, LogLine, LogSink } from '../util/log'
