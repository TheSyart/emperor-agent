import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { HostExecutionAuthorization } from '../environment/process-runner'
import type { ToolCallRequest } from '../providers/base'
import { Tool, ToolResultObj } from '../tools/base'
import { ToolExecutionEngine } from '../tools/execution'
import { ToolRegistry } from '../tools/registry'
import { toolParamsSchema } from '../tools/schema'
import {
  ToolBatchCoordinator,
  createToolBatchContext,
  type ToolBatchPermissionAssessment,
} from './tool-batch-coordinator'

class TraceTool extends Tool {
  override description = 'Records coordinator scheduling.'
  override parameters = toolParamsSchema({}, [])

  constructor(
    override name: string,
    concurrencySafe: boolean,
  ) {
    super()
    this.concurrencySafe = concurrencySafe
    this.exclusive = !concurrencySafe
  }

  execute(): string {
    return 'unused'
  }
}

function call(id: string, name: string): ToolCallRequest {
  return { id, name, arguments: { value: id } }
}

function authorization(callId: string): HostExecutionAuthorization {
  return {
    version: 1,
    toolName: 'run_command',
    operationFingerprint: `fingerprint:${callId}`,
    source: 'user_approved_once',
    permissionMode: 'smart_auto',
    rule: 'test.allow_once',
    authorizationId: 'authorization_once',
  }
}

describe('ToolBatchCoordinator golden traces', () => {
  it('owns an immutable batch context without importing AgentRunner', () => {
    const source = readFileSync(
      new URL('./tool-batch-coordinator.ts', import.meta.url),
      'utf8',
    )
    const context = createToolBatchContext({
      toolCalls: [call('immutable', 'safe')],
      emit: null,
      signal: null,
      turnId: 'turn_immutable',
      taskIntent: null,
      permissionAuthorizationId: null,
    })

    expect(source).not.toMatch(/from ['"]\.\/runner['"]|AgentRunner/)
    expect(Object.isFrozen(context)).toBe(true)
    expect(Object.isFrozen(context.toolCalls)).toBe(true)
    expect(Object.isFrozen(context.toolCalls[0])).toBe(true)
    expect(Object.isFrozen(context.toolCalls[0]!.arguments)).toBe(true)
  })

  it('preserves ordered messages, exclusive barriers, observations, and one terminal per call', async () => {
    const registry = new ToolRegistry()
    registry.register(new TraceTool('safe', true))
    registry.register(new TraceTool('exclusive', false))
    const trace: string[] = []
    const events: Array<Record<string, unknown>> = []
    const coordinator = new ToolBatchCoordinator({
      executionEngine: new ToolExecutionEngine(registry),
      ports: {
        controlEnabled: false,
        prepareCall: (item) => item,
        guardCall: () => null,
        runHook: async () => ({
          decision: 'passthrough',
          reason: '',
        }),
        assessPermissionBatch: async () => {
          throw new Error('permission assessment must not run')
        },
        approvalResult: () => ToolResultObj.fromText('approval'),
        pauseForApproval: () => undefined,
        emitToolCall: async (item) => {
          trace.push(`call:${item.id}`)
        },
        executeCall: async ({ call: item }) => {
          trace.push(`execute:${item.id}`)
          return {
            result: ToolResultObj.fromText(`result:${item.id}`),
            executed: true,
            executedCall: item,
          }
        },
        observeResult: async ({ call: item }) => {
          trace.push(`observe:${item.id}`)
          return { observations: [`observed:${item.id}`] }
        },
        emitResultSummary: async (calls) => {
          trace.push(`summary:${calls.map((item) => item.id).join(',')}`)
        },
      },
    })
    const context = createToolBatchContext({
      toolCalls: [
        call('a', 'safe'),
        call('barrier', 'exclusive'),
        call('b', 'safe'),
      ],
      emit: (event) => {
        events.push(event)
      },
      signal: null,
      turnId: 'turn_1',
      taskIntent: 'run tools',
      permissionAuthorizationId: null,
    })

    const result = await coordinator.run(context)

    expect(result.messages.map((message) => message.tool_call_id)).toEqual([
      'a',
      'barrier',
      'b',
    ])
    expect(result.observations).toEqual([
      'observed:a',
      'observed:barrier',
      'observed:b',
    ])
    expect(trace).toEqual([
      'call:a',
      'execute:a',
      'observe:a',
      'call:barrier',
      'execute:barrier',
      'observe:barrier',
      'call:b',
      'execute:b',
      'observe:b',
      'summary:a,barrier,b',
    ])
    for (const item of context.toolCalls) {
      const terminals = events.filter(
        (event) =>
          event.id === item.id &&
          [
            'tool_run_completed',
            'tool_run_failed',
            'tool_run_cancelled',
          ].includes(String(event.event)),
      )
      expect(terminals, item.id).toHaveLength(1)
    }
  })

  it('revalidates a permission-hook transform and carries allow-once host/sandbox boundaries through partial failure', async () => {
    const registry = new ToolRegistry()
    registry.register(new TraceTool('run_command', false))
    const trace: string[] = []
    const boundaries: string[] = []
    let assessments = 0
    const hostAuthorization = authorization('host')
    const allowed = (
      calls: readonly ToolCallRequest[],
    ): ToolBatchPermissionAssessment => ({
      allowed: true,
      requiresApproval: false,
      reason: 'approved once',
      decisions: calls.map(() => ({
        allowed: true,
        requiresApproval: false,
        reason: 'approved once',
      })),
      operations: calls.map((item) => ({
        callId: item.id,
        fingerprint: `fingerprint:${item.id}`,
        decision: {},
        executionBoundary: item.id === 'host' ? 'host' : 'sandbox',
        executionAuthorization: item.id === 'host' ? hostAuthorization : null,
      })),
      authorizationId: 'authorization_once',
    })
    const coordinator = new ToolBatchCoordinator({
      executionEngine: new ToolExecutionEngine(registry),
      ports: {
        controlEnabled: true,
        prepareCall: (item) => {
          trace.push(`prepare:${item.id}:${String(item.arguments.value)}`)
          return { ...item, arguments: { ...item.arguments } }
        },
        guardCall: (item) => {
          trace.push(`guard:${item.id}:${String(item.arguments.value)}`)
          return null
        },
        runHook: async (event, item) => {
          trace.push(`hook:${event}:${item.id}:${String(item.arguments.value)}`)
          if (event === 'PermissionRequest') {
            return {
              decision: 'passthrough',
              reason: '',
              updatedInput: { value: 'hook-approved' },
            }
          }
          return { decision: 'passthrough', reason: '' }
        },
        assessPermissionBatch: async (calls, context) => {
          assessments += 1
          trace.push(
            `assess:${assessments}:${context.permissionAuthorizationId}:${String(calls[0]!.arguments.value)}`,
          )
          if (assessments > 1) return allowed(calls)
          return {
            ...allowed(calls),
            allowed: false,
            requiresApproval: true,
            decisions: calls.map((_, index) => ({
              allowed: index !== 0,
              requiresApproval: index === 0,
              reason: index === 0 ? 'needs approval' : 'allowed',
            })),
          }
        },
        approvalResult: () => ToolResultObj.fromText('approval'),
        pauseForApproval: () => undefined,
        emitToolCall: async (item) => {
          trace.push(`call:${item.id}`)
        },
        executeCall: async ({ call: item, preparedCall, processExecution }) => {
          boundaries.push(`${item.id}:${processExecution?.kind ?? 'none'}`)
          trace.push(
            `execute:${item.id}:${String(preparedCall?.arguments.value)}:${processExecution?.kind ?? 'none'}`,
          )
          return {
            result:
              item.id === 'sandbox'
                ? ToolResultObj.fromText('Error: partial failure', {
                    isError: true,
                  })
                : ToolResultObj.fromText('ok'),
            executed: true,
            executedCall: preparedCall ?? item,
          }
        },
        observeResult: async ({ call: item, outcome }) => ({
          observations: [
            `${item.id}:${outcome.result.isError ? 'failed' : 'completed'}`,
          ],
        }),
        emitResultSummary: async () => undefined,
      },
    })
    const context = createToolBatchContext({
      toolCalls: [call('host', 'run_command'), call('sandbox', 'run_command')],
      emit: null,
      signal: null,
      turnId: 'turn_permission',
      taskIntent: 'run approved commands',
      permissionAuthorizationId: 'authorization_once',
    })

    const result = await coordinator.run(context)

    expect(assessments).toBe(2)
    expect(boundaries).toEqual(['host:host', 'sandbox:sandbox'])
    expect(result.preparedCalls.get('host')?.arguments).toEqual({
      value: 'hook-approved',
    })
    expect(result.observations).toEqual(['host:completed', 'sandbox:failed'])
    expect(result.results.get('sandbox')?.isError).toBe(true)
    expect(trace).toContain('assess:1:authorization_once:host')
    expect(trace).toContain('assess:2:authorization_once:hook-approved')
    expect(trace).toContain('hook:PreToolUse:host:hook-approved')
  })
})
