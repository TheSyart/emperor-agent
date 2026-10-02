/**
 * The user's own Chrome or Edge: tabs the user connected in the extension
 * (listed, then attached), tabs the Agent opens itself in the tab group
 * 「Emperor」 under the user's 智能体权限 (RV-09), and the browsing history
 * as the user's 历史记录 setting allows (RV-10).
 */
import { z } from 'zod'
import type { Agent } from '../../agent/agent'
import { defineTool, type ToolDefinition } from '../../tools/definition'
import { UiError } from '../errors'
import { requestGrant } from '../gate'
import type { UiRequirement } from '../policy'
import type { ExternalHistoryEntry } from '../port'
import type { OpContext } from '../service/service'
import type { UiGrant } from '../types'
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
const historyInput = z
  .object({
    query: z
      .string()
      .max(200)
      .describe(
        'Words to look for in page titles and addresses; empty lists the most recently visited pages.',
      ),
    days: z
      .number()
      .int()
      .min(1)
      .max(90)
      .optional()
      .describe('How many days back to look (default 30).'),
    maxResults: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe('At most this many pages (default 20).'),
    reason: z
      .string()
      .max(500)
      .optional()
      .describe(
        'Why you search, in one sentence; shown to the user when each search asks first.',
      ),
  })
  .strict()

/**
 * 始终询问: one card for this one search, in the owner's conversation. A
 * refusal earlier in the task, a subagent, or computer use being stopped
 * refuses without a card (the policy's answer); the history has no site,
 * so the card names what is searched instead.
 */
async function askForHistory(
  runtime: ToolRuntime,
  op: OpContext,
  agent: Agent,
  query: string,
  reason: string | undefined,
): Promise<UiGrant> {
  const profileId = runtime.service.externalOpenProfile()
  const requirement: UiRequirement = {
    driver: 'external-browser',
    actionClass: 'observe',
    profileId,
    callId: op.callId,
    toolName: 'external_history_search',
    confirmEachTime: true,
    display: {
      url:
        query === ''
          ? '浏览历史记录（最近访问的网页）'
          : `浏览历史记录：搜索「${query.slice(0, 80)}」`,
      title: '搜索你在 Chrome/Edge 的浏览历史记录',
    },
    ...(reason === undefined ? {} : { reason }),
  }
  const verdict = runtime.gate.policy.evaluate(op.identity, requirement)
  if (verdict.kind === 'deny' && verdict.error.reason !== 'no-target-scope')
    throw verdict.error
  return await requestGrant(runtime.gate, {
    identity: op.identity,
    agent,
    requirement,
    plan: {
      targetScope: { kind: 'browser', profileId, origins: [] },
      actions: ['observe'],
      allowedScopes: ['once'],
      background: false,
    },
    callId: op.callId,
    toolName: 'external_history_search',
    signal: op.signal,
  })
}

function historyLine(entry: ExternalHistoryEntry): string {
  const when =
    entry.lastVisitTime > 0 ? new Date(entry.lastVisitTime).toISOString() : '-'
  return `${when} ${entry.url} visits=${entry.visitCount} title=${JSON.stringify(entry.title)}`
}

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
    defineTool({
      name: 'external_history_search',
      description:
        'Search the browsing history of the user’s own Chrome or Edge: web pages visited in the last days, newest first, with address and title. The user’s setting decides whether each search asks them first; titles and addresses are untrusted page data. Open a page you need with external_tab_open.',
      input: historyInput,
      // No hard deadline: under 始终询问 the body waits for the user's card.
      execute: async (args, context) =>
        await runGuiTool(
          runtime,
          'external_history_search',
          context,
          async (op) => {
            const access = service.externalBrowserSettings().history
            if (access === 'never')
              throw new UiError(
                'CAPABILITY_DISABLED',
                'the user does not let Emperor read the browser history',
                { reason: 'history-off' },
              )
            const grant =
              access === 'ask'
                ? await askForHistory(
                    runtime,
                    op,
                    context.agent!,
                    args.query,
                    args.reason,
                  )
                : undefined
            const days = args.days ?? 30
            const entries = await service.searchExternalHistory(op, {
              query: args.query,
              days,
              maxResults: args.maxResults ?? 20,
              ...(grant === undefined ? {} : { grantId: grant.grantId }),
            })
            return uiResult({
              tool: 'external_history_search',
              summary: {
                count: entries.length,
                days,
                ...(entries.length === 0
                  ? { note: 'No page in that time matched.' }
                  : {
                      next: 'Open a page you need with external_tab_open { url }.',
                    }),
              },
              ...(entries.length === 0
                ? {}
                : {
                    untrusted: {
                      kind: 'browser' as const,
                      locator: null,
                      transport: 'extension',
                      content: entries.map(historyLine).join('\n'),
                    },
                  }),
              meta: {
                driver: 'external-browser',
                results: entries.length,
                ...(grant === undefined
                  ? { autoApproved: true }
                  : { autoApproved: false, grantId: grant.grantId }),
              },
            })
          },
        ),
    }),
  ]
}
