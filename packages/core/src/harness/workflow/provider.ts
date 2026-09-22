/**
 * The `spawn` child provider for workflow `agent()` calls: an adapter from the
 * reduced dsh subagent seam ({@link ChildProvider}) onto Emperor's in-process
 * {@link SubagentManager}. Every child is a real delegated subagent session —
 * `subagent/started` / `subagent/settled` land on the parent's log with the
 * workflow tool's call id, so children stream as `subagent_*` events under the
 * workflow tool card and are listed in the Task panel while they run. Children
 * are foreground-collected (no parent notice) and disposed after collection
 * (dsh semantics); their logs stay on disk.
 */

import type { LlmCallConfig } from '../../llm/call-config'
import type { LlmClient } from '../../llm/client'
import type { SubagentManager } from '../subagent/manager'
import type { ChildProvider, ChildResult, ChildRun } from './types'

/** How long a disposing child may take to settle its cancelled turn before it is torn down. */
const CHILD_DISPOSE_SETTLE_MS = 2_000

/** Resolve a per-child route override (`provider` = model route id, `model` = model id). */
export function resolveChildCallConfig(
  llm: LlmClient | undefined,
  provider: string | undefined,
  model: string | undefined,
): (() => LlmCallConfig) | undefined {
  if (provider === undefined && model === undefined) return undefined
  if (llm === undefined)
    throw new Error(
      'model overrides are unavailable: no LLM client is configured',
    )
  let routeId = provider
  if (routeId === undefined && model !== undefined) {
    routeId = llm
      .listRoutes()
      .find((route) => route.id === model || route.modelId === model)?.id
  }
  // Validate now so a bad route fails the start (AGENT_START), not the child's first request.
  const base = llm.defaultCallConfig(routeId)
  const config: LlmCallConfig = model === undefined ? base : { ...base, model }
  return () => config
}

export function createSpawnChildProvider(deps: {
  manager: SubagentManager
  llm?: LlmClient
}): ChildProvider {
  return {
    name: 'spawn',
    capabilities: { outputSchema: true },
    inheritsParentContext: false,
    async start(request): Promise<ChildRun> {
      if (request.signal.aborted)
        throw new Error('workflow child start aborted before publication')
      const callConfig = resolveChildCallConfig(
        deps.llm,
        request.provider,
        request.model,
      )
      const child = deps.manager.start(request.parent, {
        description: request.label ?? 'workflow agent',
        prompt: request.prompt,
        mode: 'spawn',
        background: false,
        ...(request.callId === undefined ? {} : { callId: request.callId }),
        ...(request.outputSchema === undefined
          ? {}
          : { outputSchema: request.outputSchema }),
        ...(callConfig === undefined ? {} : { agentOptions: { callConfig } }),
      })
      const controller = new AbortController()
      const onAbort = (): void => {
        controller.abort(request.signal.reason)
      }
      request.signal.addEventListener('abort', onAbort, { once: true })
      let settle!: (result: ChildResult) => void
      const result = new Promise<ChildResult>((resolve) => {
        settle = resolve
      })
      void deps.manager
        .waitForSettlement(child.id, controller.signal)
        .then(
          (settlement) => {
            settle({
              output:
                settlement.text === undefined
                  ? []
                  : [{ type: 'text', text: settlement.text }],
              ...(settlement.structured === undefined
                ? {}
                : { structured: settlement.structured }),
              stopReason: settlement.stopReason,
            })
          },
          () => {
            settle({ output: [], stopReason: 'aborted' })
          },
        )
        .finally(() => {
          request.signal.removeEventListener('abort', onAbort)
        })
      let disposal: Promise<void> | undefined
      return {
        id: child.id,
        result,
        dispose(): Promise<void> {
          disposal ??= (async () => {
            controller.abort('workflow child disposed')
            await Promise.race([
              result,
              new Promise<void>((resolve) => {
                setTimeout(resolve, CHILD_DISPOSE_SETTLE_MS).unref()
              }),
            ])
            request.signal.removeEventListener('abort', onAbort)
            deps.manager.dispose(child.id)
            settle({ output: [], stopReason: 'aborted' })
          })()
          return disposal
        },
      }
    },
  }
}
