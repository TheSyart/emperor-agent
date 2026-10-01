/**
 * `ui_*` tools (spec 00 §9.1, S0): capability discovery, target listing,
 * early release of a target, credential handles, and operation status /
 * cancellation. The AI drives continuously while computer use is on
 * (2026-09-29): nothing is requested up front or delegated.
 */

import { defineTool, type ToolDefinition } from '../../tools/definition'
import { UiError } from '../errors'
import { AUTO_APPROVED_CLASSES } from '../policy'
import { uiResult } from './result'
import { runGuiTool, type ToolRuntime } from './runtime'
import {
  uiActionStatusInput,
  uiCancelActionInput,
  uiCredentialListInput,
  uiGetCapabilitiesInput,
  uiListTargetsInput,
  uiReleaseControlInput,
} from './schemas'

export function createUiTools(runtime: ToolRuntime): ToolDefinition[] {
  const { service } = runtime
  return [
    defineTool({
      name: 'ui_get_capabilities',
      description:
        'Report which computer-use drivers are available right now (built-in browser, desktop), what each can do, what is missing, and which actions run without asking. Call this before starting GUI work.',
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
              meta: { drivers: drivers.length },
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
          const targets = service
            .listTargets(op.identity.ownerSessionId)
            .filter((target) => target.state !== 'released')
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
      name: 'ui_release_control',
      description:
        'Release a window or tab before the task ends, when you are done with it: its screen sharing stops and its handle stops working; the window or tab itself stays open. Everything you control is released at the end of the task anyway.',
      input: uiReleaseControlInput,
      timeoutMs: 30_000,
      execute: async (args, context) =>
        await runGuiTool(runtime, 'ui_release_control', context, async (op) => {
          const record = await service.releaseTarget(op, args.targetId)
          return uiResult({
            tool: 'ui_release_control',
            summary: { released: 'target', targetId: record.targetId },
            meta: { targetId: record.targetId },
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
                    next: 'No saved credential matches; ask the user with ask_user_question to sign in themselves in that window, or to save one in Settings.',
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
