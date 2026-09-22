/** Claude Code-compatible command hooks for the harness kernel (ported from dsh hook-protocol + hooks-claude-code). */

export type {
  CommandHook,
  HookDialect,
  HookOutput,
  MatcherGroup,
  MatcherMode,
} from './types'
export { matcherDiagnostic, matchesMatcher } from './matcher'
export { parseHookOutput } from './codec'
export { mergeHookOutputs } from './merge'
export type { MergedDecision, MergedHookOutcome } from './merge'
export { DEFAULT_HOOK_TIMEOUT_MS, runHook } from './runner'
export type { RunHookOptions, RunHookResult } from './runner'
export {
  appendHookInvoked,
  appendHookResult,
  DEFAULT_STDERR_SUMMARY_MAX_CHARS,
  summarizeStderr,
} from './events'
export type { HookInvocation, HookResultRecord } from './events'
export { createDetachedRuns } from './detached'
export type { DetachedRuns } from './detached'
export {
  CLAUDE_HOOK_EVENTS,
  defaultHookConfigPaths,
  parseClaudeCodeConfig,
  substituteCommand,
} from './config'
export type {
  ClaudeCodeHookConfig,
  ClaudeHookEvent,
  ParsedClaudeConfig,
  SkippedHook,
  SubstitutionVars,
} from './config'
export {
  ClaudeCodeHooks,
  DEFAULT_MAX_STOP_CONTINUATIONS,
  HOOKS_CONTEXT_PRODUCER,
} from './claude-code'
export type {
  ClaudeCodeHooksDescription,
  ClaudeCodeHooksOptions,
  SessionStartSource,
} from './claude-code'
