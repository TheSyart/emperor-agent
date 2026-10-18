import { randomUUID } from 'node:crypto'
import type { Agent } from '../agent/agent'
import type { ChildProvider, ChildResult } from '../workflow/types'
import { jsonSchema } from '../tools/json-schema'
import {
  DelegationError,
  TERMINAL_RUN_PHASES,
  type DelegationOwner,
} from './types'
import type { DelegationService } from './service'
export function createRoutingChildProvider(options: {
  internal: ChildProvider
  delegations: () => DelegationService | undefined
  ownerResolver: (agent: Agent, callId: string) => DelegationOwner
  readOnly: (agent: Agent) => boolean
}): ChildProvider {
  return {
    ...options.internal,
    async start(request) {
      if (!request.backend || request.backend === 'internal') {
        if (request.profileId)
          throw new DelegationError(
            'UNSUPPORTED_OPTION',
            'profileId selects an external executor only',
          )
        return options.internal.start(request)
      }
      if (!['claude-code', 'codex'].includes(request.backend))
        throw new DelegationError(
          'UNSUPPORTED_OPTION',
          'unknown executor backend',
        )
      if (request.provider)
        throw new DelegationError(
          'UNSUPPORTED_OPTION',
          'external backend does not accept an internal provider route',
        )
      const service = options.delegations()
      if (!service)
        throw new DelegationError(
          'EXECUTOR_UNAVAILABLE',
          'external executor service is not composed',
        )
      if (request.outputSchema)
        jsonSchema.assertObjectJsonSchema(request.outputSchema)
      const inherited = options.ownerResolver(
          request.parent,
          request.callId ?? 'workflow',
        ),
        owner = {
          ...inherited,
          source:
            inherited.source === 'scheduler'
              ? ('scheduler' as const)
              : ('workflow' as const),
        }
      let record: Awaited<ReturnType<DelegationService['start']>>
      try {
        record = await service.start(
          owner,
          {
            backend: request.backend,
            profileId: request.profileId,
            description: request.label ?? 'workflow agent',
            prompt: request.prompt,
            context: 'isolated',
            workspace: options.readOnly(request.parent)
              ? 'shared-readonly'
              : 'isolated-worktree',
            base: 'committed',
            model: request.model,
            outputSchema: request.outputSchema,
            runInBackground: false,
            clientRequestId:
              request.clientRequestId ?? 'workflow-' + randomUUID(),
          },
          request.signal,
        )
      } catch (error) {
        // The user kept their quota (AGT-05): the step runs as an internal
        // subagent instead.
        if (
          error instanceof DelegationError &&
          error.code === 'EXECUTOR_CONSENT_DENIED'
        )
          return options.internal.start({
            ...request,
            backend: 'internal',
            profileId: undefined,
          })
        throw error
      }
      const runId = record.currentRunId!
      const result = service.wait(record.id, runId).then((run): ChildResult => {
        let stopReason = run.phase
        if (
          stopReason === 'completed' &&
          request.outputSchema &&
          jsonSchema.validateJsonSchemaValue(
            request.outputSchema,
            run.structured,
          ).length
        )
          stopReason = 'failed'
        const state = service.inspect(record.id)
        return {
          output: [
            {
              type: 'text',
              text: `External ${record.backend} delegation ${record.id}, run ${runId}, workspace ${state.record!.cwd}, artifact acceptance ${run.acceptance}.\n${run.summary ?? run.failureCode ?? ''}`,
            },
          ],
          ...(stopReason === 'completed' && run.structured !== undefined
            ? { structured: run.structured }
            : {}),
          stopReason,
        }
      })
      let disposing: Promise<void> | undefined
      return {
        id: record.id,
        externalRunId: runId,
        backend: record.backend,
        result,
        dispose() {
          disposing ??= (async () => {
            const run = service.inspect(record.id).runs[runId]!
            if (!TERMINAL_RUN_PHASES.has(run.phase))
              await service.interrupt(record.id, runId)
            await result
          })()
          return disposing
        },
      }
    },
  }
}
