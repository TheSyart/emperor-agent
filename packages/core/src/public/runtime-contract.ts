export {
  RUNTIME_EVENT_NAMES,
  isRuntimeEventWire,
} from '../runtime/wire-discriminant'
export type { RuntimeEventName } from '../runtime/wire-discriminant'
export type {
  BrowserPreferences,
  RuntimeEvent,
  RuntimeEventEnvelope,
  RuntimeGoalView,
} from '../runtime/types'
export { DRAFT_SESSION_PREFIX } from '../sessions/constants'
// SET-02: a failed model request in Chinese, with where to fix it.
export { modelFailureText } from '../llm/failure-text'
// MOD-01: the three modes and which one a session belongs to.
export {
  APP_MODES,
  SESSION_SURFACES,
  defaultAppMode,
  isAppMode,
  isKnownSessionSurface,
  isModeRouteId,
  normalizeModeRoutes,
  sessionAppMode,
} from '../sessions/app-mode'
export type {
  AppMode,
  AppModeSessionFacts,
  ModeRoutes,
  SessionSurface,
} from '../sessions/app-mode'
// REL-02: the update status the settings page and the bell read.
export type {
  UpdateAttestation,
  UpdateChannel,
  UpdateDiagnostics,
  UpdateDownloadState,
  UpdateElectronFacts,
  UpdateRelease,
  UpdateStatus,
} from '../updates/types'
export type {
  ActionOutcome,
  BrowserProfileView,
  DownloadRecord,
  DownloadState,
  UploadRecord,
  ComputerUseStatusView,
  ControlIndicatorState,
  ControlState,
  CredentialField,
  CredentialBinding,
  CredentialHandle,
  CredentialFillOutcome,
  DriverCapability,
  DriverKind,
  DriverStage,
  HostPlatform,
  PermissionStatus,
  RedactedUiAction,
  TargetKind,
  TargetState,
  UiAction,
  UiActionClass,
  UiElement,
  UiRole,
  UiGrantScope,
  UiTargetScope,
  UiTargetView,
} from '../harness/computer-use/types'
export type {
  AssistantMessage,
  ContentBlock,
  EpochHeader,
  ImageAttachmentRef,
  LlmFailure,
  Message,
  RequestContext,
  SessionEvent,
  SessionEventMap,
  SessionEventType,
  SessionHeader,
  SessionHistoryPage,
  SessionLineage,
  SessionLineageEntry,
  StreamChunk,
  SubagentChildView,
  SubagentMode,
  SubagentStopReason,
  TodoItem,
  TokenUsage,
  ToolResultMessage,
  ToolSchema,
  TurnBudgetReason,
  TurnEndReason,
  TurnFileEntry,
  TurnFilesRecord,
  TurnFilesReverted,
  UserMessage,
  WireSessionEvent,
  WireTruncation,
} from './session-event-types'
export {
  SITE_PERMISSION_KINDS,
  type SitePermission,
  type SitePermissionKind,
} from '../harness/computer-use/types'
export type {
  ExternalBrowserSettings,
  ExternalBrowserSettingsPatch,
  ExternalBrowserSettingsView,
  ExternalHistoryAccess,
  ExternalSiteDecision,
  ExternalSiteRule,
} from '../harness/computer-use/external-site-rules'

export type {
  ExecutorConfig,
  ExecutorModelCatalog,
  ExecutorModelCandidate,
  ExecutorProfile,
  ExecutorProbe,
  ExecutorAuthState,
  ClaudeSignInView,
  ExecutorInstallKind,
  ExecutorUpgradeView,
  ExecutorVersionView,
  ExecutorVersionsView,
  ExecutorCapabilities,
  ExecutorRuntimeFacts,
  NativeCapabilityStatus,
  NativeCapabilityEvidence,
  DelegationRecord,
  DelegationRunRecord,
  DelegationResult,
  VersionFailureContext,
} from '../harness/delegation/types'
export {
  executorIntroduction,
  executorSpecialties,
} from '../harness/delegation/specialties'
export type {
  DelegationProjection,
  DelegationResultRecord,
  DelegationRuntimeName,
} from '../harness/delegation/events'
export type { DelegationReceipt } from '../harness/delegation/receipts'
export type {
  AcceptanceCriteria,
  AcceptanceReceipt,
} from '../harness/delegation/acceptance'
export type {
  IntegrationPreview,
  IntegrationReceipt,
} from '../workspace/delegation-integration'

export { mergeExternalTranscript } from '../runtime/external-transcript'

// UI-S15: what opened a turn (a task starts with the user's message; a
// subagent's or job's result continues it).
export { turnOpener, TURN_OPENER_PRODUCERS } from '../harness/host/turn-opener'
export type { TurnOpener, TurnOpenerSource } from '../harness/host/turn-opener'

export {
  agentTitle,
  agentSourceLabel,
  agentPhaseLabel,
  delegationNeedsExit,
  RESULT_CLEANUP_AFTER_MS,
  resultNeedsCleanup,
} from '../runtime/agent-view'
export type { AgentView, AgentBackend, AgentPhase } from '../runtime/agent-view'

export { ROLE_CREATOR_CONTACT_ID } from '../contacts/types'

// CG-CT-01: the conversation layer parses an unsaved creator draft without
// importing the full Core API. Saving remains in the contact components.
export type {
  Contact,
  ContactDraftInput,
  ContactPatch,
} from '../contacts/types'
