import type { ContextProjection } from './context-builder'
import type { ExecutionEnvironment } from '../environment/snapshot'
import type { HookSnapshot } from '../hooks/models'
import type { ProviderSnapshot } from '../model/router'

export interface TurnExecutionIdentity {
  readonly sessionId: string
  readonly turnId: string
  readonly taskId: string
  readonly executionId: string
  readonly rootTurnId: string
}

export interface TurnExecutionScope {
  readonly mode: 'chat' | 'build'
  readonly workspaceRoot: string
  readonly projectId: string | null
  readonly projectFingerprint: string | null
}

export interface TurnExecutionPorts {
  readonly control: object
  readonly plan: object
  readonly goal: object
  readonly todo: object
  readonly runtime: object
}

export interface TurnExecutionContext {
  readonly identity: Readonly<TurnExecutionIdentity>
  readonly scope: Readonly<TurnExecutionScope>
  readonly permissionMode: string
  readonly executionEnvironment: ExecutionEnvironment
  readonly hookSnapshot: HookSnapshot
  readonly promptProjection: ContextProjection
  readonly modelRoute: ProviderSnapshot
  readonly ports: Readonly<TurnExecutionPorts>
  readonly eventSink:
    ((event: Record<string, unknown>) => void | Promise<void>) | null
}

export function createTurnExecutionContext(
  input: TurnExecutionContext,
): TurnExecutionContext {
  return Object.freeze({
    ...input,
    identity: Object.freeze({ ...input.identity }),
    scope: Object.freeze({ ...input.scope }),
    ports: Object.freeze({ ...input.ports }),
  })
}
