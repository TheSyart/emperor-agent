/**
 * `ui_*` tools (spec 00 §9.1, S0): capability discovery, target listing,
 * proactive grant requests, release, and operation status / cancellation.
 */

import { defineTool, type ToolDefinition } from '../../tools/definition'
import { UiError } from '../errors'
import { requestGrant } from '../gate'
import { normalizeOrigin } from '../grants/match'
import { AUTO_APPROVED_CLASSES } from '../policy'
import { uiResult } from './result'
import { runGuiTool, type ToolRuntime } from './runtime'
import {
  uiActionStatusInput,
  uiCancelActionInput,
  uiCredentialListInput,
  uiDelegateGrantInput,
  uiGetCapabilitiesInput,
  uiListTargetsInput,
  uiReleaseControlInput,
  uiRequestControlInput,
} from './schemas'

export function createUiTools(runtime: ToolRuntime): ToolDefinition[] {
  const { service } = runtime
  return [
    defineTool({
      name: 'ui_get_capabilities',
      description:
        'Report which computer-use drivers are available right now (built-in browser, desktop), what each can do, what is missing, whether computer use is stopped, and which actions the persistent GUI authorization mode approves automatically. Call this before starting GUI work.',
      input: uiGetCapabilitiesInput,
      isConcurrencySafe: () => true,
      timeoutMs: 15_000,
      execute: async (_args, context) =>
        await runGuiTool(
          runtime,
          'ui_get_capabilities',
          context,
          async (op) => {
            const drivers = await service.capabilities()
            return uiResult({
              tool: 'ui_get_capabilities',
              summary: {
                platform: service.platform,
                stopped: service.stopped,
                autoApproved: op.identity.fullAccess
                  ? AUTO_APPROVED_CLASSES
                  : [],
                alwaysConfirmed: ['credential-fill', 'high-impact'],
                vision: op.vision,
                drivers: drivers.map((driver) => ({
                  driver: driver.driver,
                  stage: driver.stage,
                  label: driver.label,
                  available: driver.available,
                  actions: driver.actions,
                  missing: driver.missing,
                  ...(driver.reason === undefined
                    ? {}
                    : { reason: driver.reason }),
                })),
              },
              meta: { drivers: drivers.length, stopped: service.stopped },
            })
          },
        ),
    }),
    defineTool({
      name: 'ui_list_targets',
      description:
        'List the tabs and windows this conversation currently controls, with their ids, state and which one is current.',
      input: uiListTargetsInput,
      isConcurrencySafe: () => true,
      timeoutMs: 15_000,
      execute: async (_args, context) =>
        await runGuiTool(runtime, 'ui_list_targets', context, async (op) => {
          const current = service.lookup(op.identity)?.targetId
          const targets = service.listTargets(op.identity.ownerSessionId)
          return uiResult({
            tool: 'ui_list_targets',
            summary: {
              count: targets.length,
              targets: targets.map((target) => ({
                targetId: target.targetId,
                driver: target.driver,
                url: target.url,
                state: target.state,
                control: target.control,
                revision: target.revision,
                current: target.targetId === current,
              })),
            },
            ...(targets.length === 0
              ? {}
              : {
                  untrusted: {
                    kind: 'browser' as const,
                    locator: null,
                    transport: 'kernel',
                    content: targets
                      .map(
                        (target) =>
                          `${target.targetId} title=${JSON.stringify(target.title)}`,
                      )
                      .join('\n'),
                  },
                }),
            meta: { targets: targets.length },
          })
        }),
    }),
    defineTool({
      name: 'ui_request_control',
      description:
        'Ask the user up front for permission to observe, interact with, or navigate within the given origins in the built-in browser, instead of being asked action by action. Returns the granted scope, or "auto" when the persistent GUI mode already approves these actions. The reason you give is shown to the user as unverified.',
      input: uiRequestControlInput,
      execute: async (args, context) =>
        await runGuiTool(runtime, 'ui_request_control', context, async (op) => {
          const origins = args.origins.map((origin) => normalizeOrigin(origin))
          if (origins.some((origin) => origin === null))
            throw new UiError(
              'INVALID_REQUEST',
              'origins must be http(s) origins',
            )
          const unique = [...new Set(origins as string[])]
          if (
            op.identity.fullAccess &&
            args.actions.every((action) =>
              AUTO_APPROVED_CLASSES.includes(action),
            )
          )
            return uiResult({
              tool: 'ui_request_control',
              summary: {
                granted: 'auto',
                origins: unique,
                actions: args.actions,
                note: 'The persistent Computer Use authorization mode approves these actions automatically.',
              },
              meta: { granted: 'auto' },
            })
          const requirement = {
            driver: args.driver,
            actionClass: args.actions.includes('navigate')
              ? ('navigate' as const)
              : args.actions.includes('interact')
                ? ('interact' as const)
                : ('observe' as const),
            askActions: args.actions,
            profileId: 'temporary',
            origin: unique[0]!,
            callId: op.callId,
            toolName: 'ui_request_control',
            display: { url: unique.join('、') },
            ...(args.reason === undefined ? {} : { reason: args.reason }),
          }
          const verdict = runtime.gate.policy.evaluate(
            {
              ...op.identity,
              background: op.identity.background || args.background === true,
            },
            requirement,
          )
          if (verdict.kind === 'deny') throw verdict.error
          if (verdict.kind === 'allow' && verdict.via === 'grant')
            return uiResult({
              tool: 'ui_request_control',
              summary: {
                granted: verdict.grant.scope,
                grantId: verdict.grant.grantId,
                origins:
                  verdict.grant.targetScope.kind === 'browser'
                    ? verdict.grant.targetScope.origins
                    : [],
                actions: verdict.grant.allowedActions,
                note: 'An existing grant already covers this.',
              },
              meta: {
                granted: verdict.grant.scope,
                grantId: verdict.grant.grantId,
              },
            })
          const plan =
            verdict.kind === 'ask'
              ? verdict.plan
              : {
                  targetScope: {
                    kind: 'browser' as const,
                    profileId: 'temporary',
                    origins: unique,
                  },
                  actions: args.actions,
                  allowedScopes: ['once', 'task', 'session', 'timed'] as const,
                  background: args.background === true,
                }
          const grant = await requestGrant(runtime.gate, {
            identity: op.identity,
            agent: context.agent!,
            requirement,
            plan: {
              ...plan,
              targetScope: {
                kind: 'browser',
                profileId: 'temporary',
                origins: unique,
              },
              actions: [...new Set([...args.actions, 'observe' as const])],
              allowedScopes: plan.allowedScopes.filter(
                (scope) => scope !== 'once',
              ),
              background: args.background === true || plan.background,
            },
            callId: op.callId,
            toolName: 'ui_request_control',
            signal: op.signal,
          })
          return uiResult({
            tool: 'ui_request_control',
            summary: {
              granted: grant.scope,
              grantId: grant.grantId,
              origins: unique,
              actions: grant.allowedActions,
              ...(grant.expiresAt === undefined
                ? {}
                : { expiresAt: grant.expiresAt }),
              backgroundAllowed: grant.backgroundAllowed,
            },
            meta: { granted: grant.scope, grantId: grant.grantId },
          })
        }),
    }),
    defineTool({
      name: 'ui_delegate_grant',
      description:
        'Explicitly delegate a subset of one of your existing GUI grants to a direct subagent. The source grant must already allow background use. The child receives only the requested actions and origins for this task; revoking or narrowing the source immediately invalidates the delegation.',
      input: uiDelegateGrantInput,
      timeoutMs: 15_000,
      execute: async (args, context) =>
        await runGuiTool(runtime, 'ui_delegate_grant', context, async (op) => {
          if (!runtime.isDirectChild(op.identity.callerSessionId, args.childId))
            throw new UiError(
              'PERMISSION_DENIED',
              'the target is not your direct subagent',
            )
          const source = runtime.gate.grants.get(args.grantId)
          if (
            !source ||
            source.subject !== op.identity.subject ||
            source.ownerSessionId !== op.identity.ownerSessionId ||
            source.scope === 'once' ||
            !source.backgroundAllowed ||
            (source.scope === 'task' && source.taskId !== op.identity.taskId)
          )
            throw new UiError(
              'PERMISSION_DENIED',
              'the grant cannot be delegated to this subagent',
            )
          const actions = [...new Set(args.actions)]
          if (
            !actions.every((action) => source.allowedActions.includes(action))
          )
            throw new UiError(
              'PERMISSION_DENIED',
              'delegated actions exceed the source grant',
            )
          let targetScope = source.targetScope
          if (args.origins !== undefined) {
            if (source.targetScope.kind !== 'browser')
              throw new UiError(
                'INVALID_REQUEST',
                'origins only apply to browser grants',
              )
            const sourceScope = source.targetScope
            const origins = [
              ...new Set(args.origins.map((origin) => normalizeOrigin(origin))),
            ]
            if (
              origins.some(
                (origin) =>
                  origin === null || !sourceScope.origins.includes(origin),
              )
            )
              throw new UiError(
                'PERMISSION_DENIED',
                'delegated origins exceed the source grant',
              )
            targetScope = { ...sourceScope, origins: origins as string[] }
          }
          const grant = runtime.gate.grants.issue({
            subject: `subagent:${args.childId}`,
            ownerSessionId: op.identity.ownerSessionId,
            driver: source.driver,
            targetScope,
            allowedActions: actions,
            scope: 'task',
            taskId: op.identity.taskId,
            ...(source.expiresAt === undefined
              ? {}
              : { expiresAt: source.expiresAt }),
            backgroundAllowed: true,
            delegatedFrom: {
              grantId: source.grantId,
              revision: source.revision,
            },
          })
          context.agent!.session.append('ui/grant-delegated', {
            grantId: grant.grantId,
            sourceGrantId: source.grantId,
            childId: args.childId,
            actions,
            targetScope,
          })
          return uiResult({
            tool: 'ui_delegate_grant',
            summary: {
              grantId: grant.grantId,
              childId: args.childId,
              actions,
              targetScope,
              expiresAt: grant.expiresAt,
            },
            meta: { grantId: grant.grantId, childId: args.childId },
          })
        }),
    }),
    defineTool({
      name: 'ui_release_control',
      description:
        'Give back control: close a tab or window you opened (targetId), or drop a grant you no longer need (grantId).',
      input: uiReleaseControlInput,
      timeoutMs: 30_000,
      execute: async (args, context) =>
        await runGuiTool(runtime, 'ui_release_control', context, async (op) => {
          if (args.targetId !== undefined) {
            const record = await service.close(op, { targetId: args.targetId })
            return uiResult({
              tool: 'ui_release_control',
              summary: { released: 'target', targetId: record.targetId },
              meta: { targetId: record.targetId },
            })
          }
          const grant = runtime.gate.grants.get(args.grantId!)
          if (grant === undefined || grant.subject !== op.identity.subject)
            throw new UiError(
              'INVALID_REQUEST',
              `unknown grant ${args.grantId}`,
            )
          service.revokeGrant(grant.grantId)
          return uiResult({
            tool: 'ui_release_control',
            summary: { released: 'grant', grantId: grant.grantId },
            meta: { grantId: grant.grantId },
          })
        }),
    }),
    defineTool({
      name: 'ui_credential_list',
      description:
        'List the user’s saved credentials as handles (label, registered sites and apps, and username when allowed). Passwords and one-time codes are never shown; fill them with browser_fill_credential or desktop_fill_credential.',
      input: uiCredentialListInput,
      isConcurrencySafe: () => true,
      timeoutMs: 15_000,
      execute: async (args, context) =>
        await runGuiTool(runtime, 'ui_credential_list', context, async () => {
          const handles = service.listCredentials(
            args.origin === undefined ? {} : { origin: args.origin },
          )
          return uiResult({
            tool: 'ui_credential_list',
            summary: {
              count: handles.length,
              credentials: handles.map((handle) => ({
                handleId: handle.handleId,
                label: handle.label.slice(0, 80),
                sites: handle.bindings
                  .filter((binding) => binding.kind === 'origin')
                  .map((binding) =>
                    binding.kind === 'origin' ? binding.origin : '',
                  ),
                apps: handle.bindings
                  .filter((binding) => binding.kind === 'app')
                  .map((binding) =>
                    binding.kind === 'app' ? binding.bundleId : '',
                  ),
                ...(handle.username === undefined
                  ? {}
                  : { username: handle.username.slice(0, 120) }),
                fields: handle.fields,
                confirmEachTime: true,
              })),
              ...(handles.length === 0
                ? {
                    next: 'No saved credential matches; ask the user to sign in themselves (take over) or to save one in Settings.',
                  }
                : {}),
            },
            meta: { credentials: handles.length },
          })
        }),
    }),
    defineTool({
      name: 'ui_action_status',
      description:
        'Look up what happened to an earlier GUI action by operationId or callId: observed, no-effect, unknown (may have happened — observe before deciding anything), cancelled or still running. Use this instead of repeating an action whose result was unclear.',
      input: uiActionStatusInput,
      isConcurrencySafe: () => true,
      timeoutMs: 15_000,
      execute: async (args, context) =>
        await runGuiTool(runtime, 'ui_action_status', context, async (op) => {
          const status = service.actionStatus(op.identity, {
            ...(args.operationId === undefined
              ? {}
              : { operationId: args.operationId }),
            ...(args.callId === undefined ? {} : { callId: args.callId }),
          })
          if (status === undefined)
            throw new UiError(
              'INVALID_REQUEST',
              'no such operation in this conversation',
            )
          return uiResult({
            tool: 'ui_action_status',
            summary: { ...status },
            meta: { operationId: status.operationId, state: status.state },
          })
        }),
    }),
    defineTool({
      name: 'ui_cancel_action',
      description: 'Cancel a GUI action that is still running.',
      input: uiCancelActionInput,
      isConcurrencySafe: () => true,
      timeoutMs: 15_000,
      execute: async (args, context) =>
        await runGuiTool(runtime, 'ui_cancel_action', context, async (op) => {
          const cancelled = service.cancelAction(op.identity, args.operationId)
          return uiResult({
            tool: 'ui_cancel_action',
            summary: { operationId: args.operationId, cancelled },
            meta: { operationId: args.operationId, cancelled },
          })
        }),
    }),
  ]
}
