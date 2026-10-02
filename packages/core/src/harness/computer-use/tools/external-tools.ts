/**
 * The user's own Chrome or Edge: tabs the user connected in the extension
 * (listed, then attached), and tabs the Agent opens itself in the tab group
 * 「Emperor」 under the user's 智能体权限 (RV-09).
 */
import { z } from 'zod'
import { defineTool, type ToolDefinition } from '../../tools/definition'
import { uiResult } from './result'
import { runGuiTool, type ToolRuntime } from './runtime'

const listInput = z.object({}).strict()
const attachInput = z
  .object({
    targetId: z
      .string()
      .min(1)
      .max(256)
      .describe('Target id from external_tab_list.'),
  })
  .strict()
const openInput = z
  .object({
    url: z.string().min(1).max(2_048).describe('The http(s) address to open.'),
    reason: z
      .string()
      .max(500)
      .optional()
      .describe(
        'Why this site, in one sentence; shown to the user when the site needs approval.',
      ),
  })
  .strict()

export function createExternalTools(runtime: ToolRuntime): ToolDefinition[] {
  const { service } = runtime
  return [
    defineTool({
      name: 'external_tab_list',
      description:
        'List Chrome tabs the user explicitly attached in the Emperor extension. An attached tab must be claimed with external_tab_attach before observation or action.',
      input: listInput,
      isConcurrencySafe: () => true,
      timeoutMs: 15_000,
      execute: async (_args, context) =>
        await runGuiTool(runtime, 'external_tab_list', context, async (op) => {
          const tabs = service.listExternalTabs(op.identity.ownerSessionId)
          return uiResult({
            tool: 'external_tab_list',
            summary: {
              count: tabs.length,
              tabs: tabs.map((tab) => ({
                targetId: tab.targetId,
                origin: tab.origin,
                generation: tab.generation,
                ...(tab.claimedBy === null ? {} : { currentTask: true }),
              })),
              next: 'Call external_tab_attach with an unclaimed targetId to work in that tab.',
            },
            meta: { driver: 'external-browser', tabs: tabs.length },
          })
        }),
    }),
    defineTool({
      name: 'external_tab_attach',
      description:
        'Claim one Chrome tab that the user connected from the Emperor extension. The extension and exact tab identity are rechecked before it becomes a target.',
      input: attachInput,
      timeoutMs: 30_000,
      execute: async (args, context) =>
        await runGuiTool(
          runtime,
          'external_tab_attach',
          context,
          async (op) => {
            const record = await service.attachExternal(op, args.targetId)
            return uiResult({
              tool: 'external_tab_attach',
              summary: {
                targetId: record.targetId,
                origin: record.url,
                generation: record.generation,
                next: 'Call browser_observe to inspect this tab.',
              },
              meta: {
                driver: 'external-browser',
                targetId: record.targetId,
                outcome: 'observed',
              },
            })
          },
        ),
    }),
    defineTool({
      name: 'external_tab_open',
      description:
        'Open an http(s) URL in a new tab of the user’s own Chrome or Edge (in the tab group “Emperor”) and work in it; use it for sites where the user is signed in. The user’s per-site rules apply: a blocked site is refused, a site that needs approval asks the user first, and browser_navigate in the tab follows the same rules. Call browser_observe next.',
      input: openInput,
      timeoutMs: 60_000,
      execute: async (args, context) =>
        await runGuiTool(runtime, 'external_tab_open', context, async (op) => {
          const record = await service.openExternal(op, { url: args.url })
          return uiResult({
            tool: 'external_tab_open',
            summary: {
              targetId: record.targetId,
              origin: record.url,
              generation: record.generation,
              next: 'Call browser_observe to read the page.',
            },
            meta: {
              driver: 'external-browser',
              targetId: record.targetId,
              target: { url: record.url, title: record.title.slice(0, 200) },
              outcome: 'observed',
              ...(op.ticket.kind === 'grant'
                ? { autoApproved: false, grantId: op.ticket.grantId }
                : { autoApproved: op.ticket.kind === 'auto' }),
            },
          })
        }),
    }),
  ]
}
