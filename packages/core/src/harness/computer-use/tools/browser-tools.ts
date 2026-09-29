/**
 * `browser_*` tools for the built-in browser (spec 00 §9.1, S1). Every call
 * has already passed the gate; the body re-validates through the kernel.
 * The JSON summary carries only kernel facts (ids, URL, revisions,
 * outcome); anything the page wrote — titles, element names, change notes,
 * dialog text — goes into the untrusted external-content envelope.
 */

import type { ImageAttachmentRef } from '../../../llm/types'
import {
  defineTool,
  type ToolDefinition,
  type ToolReturn,
} from '../../tools/definition'
import type { ActResult, OpContext } from '../service/service'
import type { TargetRecord } from '../service/registry'
import type { UiAction } from '../types'
import { UiError } from '../errors'
import { renderObservationContent, uiResult } from './result'
import { runGuiTool, type ToolRuntime } from './runtime'
import {
  browserClickInput,
  browserCloseInput,
  browserDownloadInput,
  browserFillCredentialInput,
  browserFillInput,
  browserNavigateInput,
  browserObserveInput,
  browserOpenInput,
  browserPressInput,
  browserProfileListInput,
  browserProfileManageInput,
  browserScreenshotInput,
  browserScrollInput,
  browserSelectInput,
  browserTabListInput,
  browserTabSelectInput,
  browserTypeInput,
  browserUploadInput,
  browserWaitInput,
} from './schemas'

const VERIFY =
  'Observe again (browser_observe, diff: true) to confirm the result before the next step.'

function targetMeta(record: TargetRecord): Record<string, unknown> {
  return {
    driver: record.driver,
    targetId: record.targetId,
    target: { url: record.url, title: record.title.slice(0, 200) },
  }
}

function grantMeta(op: OpContext): Record<string, unknown> {
  return op.ticket.kind === 'auto'
    ? { autoApproved: true }
    : op.ticket.kind === 'grant'
      ? { autoApproved: false, grantId: op.ticket.grantId }
      : { autoApproved: false }
}

function actResult(tool: string, op: OpContext, result: ActResult): ToolReturn {
  const { target, outcome } = result
  const pageNotes = [
    ...(outcome.changes ?? []).map((line) => `change: ${line}`),
    ...(outcome.warnings ?? []).map((line) => `warning: ${line}`),
    ...(outcome.title === undefined ? [] : [`title: ${outcome.title}`]),
  ]
  return uiResult({
    tool,
    summary: {
      targetId: target.targetId,
      url: outcome.url ?? target.url,
      outcome: outcome.outcome,
      beforeRevision: result.beforeRevision,
      afterRevision: outcome.afterRevision,
      operationId: result.operationId,
      next: VERIFY,
    },
    ...(pageNotes.length === 0
      ? {}
      : {
          untrusted: {
            kind: 'browser' as const,
            locator: outcome.url ?? target.url,
            transport: 'cdp',
            content: pageNotes.join('\n'),
          },
        }),
    meta: {
      ...targetMeta(target),
      operationId: result.operationId,
      outcome: outcome.outcome,
      revisions: {
        before: result.beforeRevision,
        after: outcome.afterRevision,
      },
      ...grantMeta(op),
    },
  })
}

export function createBrowserTools(runtime: ToolRuntime): ToolDefinition[] {
  const { service } = runtime
  const act =
    (tool: string, action: (args: never) => UiAction) =>
    async (args: never, context: Parameters<ToolDefinition['execute']>[1]) =>
      await runGuiTool(runtime, tool, context, async (op) => {
        const input = args as { targetId?: string }
        const result = await service.act(op, {
          ...(input.targetId === undefined ? {} : { targetId: input.targetId }),
          action: action(args),
        })
        return actResult(tool, op, result)
      })

  return [
    defineTool({
      name: 'browser_open',
      description:
        'Open a URL in a new tab of the built-in browser, which the user can watch in the Browser pane. By default the tab uses a private temporary profile that is wiped when it closes; pass profile (from browser_profile_list) to keep logins across tasks. Returns the tab id; call browser_observe next to see the page.',
      input: browserOpenInput,
      timeoutMs: 45_000,
      execute: async (args, context) =>
        await runGuiTool(runtime, 'browser_open', context, async (op) => {
          const record = await service.open(op, {
            url: args.url,
            ...(args.profile === undefined || args.profile === 'temporary'
              ? {}
              : {
                  profile: {
                    kind: 'persistent' as const,
                    profileId: args.profile,
                  },
                }),
          })
          return uiResult({
            tool: 'browser_open',
            summary: {
              targetId: record.targetId,
              url: record.url,
              generation: record.generation,
              next: 'Call browser_observe to read the page.',
            },
            untrusted: {
              kind: 'browser',
              locator: record.url,
              transport: 'cdp',
              content: `title: ${record.title}`,
            },
            meta: {
              ...targetMeta(record),
              outcome: 'observed',
              ...grantMeta(op),
            },
          })
        }),
    }),
    defineTool({
      name: 'browser_tab_list',
      description: 'List the built-in browser tabs this conversation controls.',
      input: browserTabListInput,
      isConcurrencySafe: () => true,
      timeoutMs: 15_000,
      execute: async (_args, context) =>
        await runGuiTool(runtime, 'browser_tab_list', context, async (op) => {
          const current = service.lookup(op.identity)?.targetId
          const tabs = service
            .listTargets(op.identity.ownerSessionId)
            .filter((target) => target.driver !== 'desktop')
          const restorable = service.restorableFor(op.identity.ownerSessionId)
          const titles = [
            ...tabs.map(
              (tab) => `${tab.targetId} title=${JSON.stringify(tab.title)}`,
            ),
            ...restorable.map(
              (tab) =>
                `restorable ${tab.url} title=${JSON.stringify(tab.title)}`,
            ),
          ]
          return uiResult({
            tool: 'browser_tab_list',
            summary: {
              count: tabs.length,
              tabs: tabs.map((tab) => ({
                targetId: tab.targetId,
                url: tab.url,
                control: tab.control,
                current: tab.targetId === current,
              })),
              ...(restorable.length === 0
                ? {}
                : {
                    restorable: restorable.map((tab) => ({
                      profile: tab.profileId,
                      url: tab.url,
                      closedAt: tab.closedAt,
                    })),
                    next: 'Tabs of persistent profiles open before the app restarted can be reopened with browser_open { url, profile }.',
                  }),
            },
            ...(titles.length === 0
              ? {}
              : {
                  untrusted: {
                    kind: 'browser' as const,
                    locator: null,
                    transport: 'kernel',
                    content: titles.join('\n'),
                  },
                }),
            meta: { tabs: tabs.length },
          })
        }),
    }),
    defineTool({
      name: 'browser_download',
      description:
        'Download one file into the download inbox by clicking a download link (ref) or fetching a URL. The user confirms every download; executables and files over 200 MB are refused. The file stays in the inbox (outside the workspace) until the user moves it.',
      input: browserDownloadInput,
      timeoutMs: 120_000,
      execute: async (args, context) =>
        await runGuiTool(runtime, 'browser_download', context, async (op) => {
          const { target, operationId, download } = await service.download(op, {
            ...(args.targetId === undefined ? {} : { targetId: args.targetId }),
            ...(args.ref === undefined ? {} : { ref: args.ref }),
            ...(args.url === undefined ? {} : { url: args.url }),
          })
          return uiResult({
            tool: 'browser_download',
            summary: {
              downloadId: download.downloadId,
              state: download.state,
              bytes: download.bytes,
              ...(download.sha256 === undefined
                ? {}
                : { sha256: download.sha256 }),
              operationId,
              next:
                download.state === 'completed'
                  ? 'The file is in the download inbox; ask the user to move it into the workspace if you need to read it.'
                  : 'Nothing was saved.',
            },
            untrusted: {
              kind: 'browser',
              locator: download.url,
              transport: 'download',
              content: [
                `filename: ${download.filename}`,
                ...(download.mimeType === undefined
                  ? []
                  : [`type: ${download.mimeType}`]),
                ...(download.reason === undefined
                  ? []
                  : [`reason: ${download.reason}`]),
              ].join('\n'),
            },
            meta: {
              ...targetMeta(target),
              operationId,
              outcome:
                download.state === 'completed' ? 'observed' : 'no-effect',
              download: {
                downloadId: download.downloadId,
                state: download.state,
                filename: download.filename.slice(0, 200),
                bytes: download.bytes,
              },
              ...grantMeta(op),
            },
          })
        }),
    }),
    defineTool({
      name: 'browser_fill_credential',
      description:
        'Fill a username, password or one-time code from the user’s credential vault into a field, by handle (from ui_credential_list). You never see the secret. It only works on the exact sites the entry is registered for, and always asks the user to confirm this fill.',
      input: browserFillCredentialInput,
      timeoutMs: 45_000,
      execute: async (args, context) =>
        await runGuiTool(
          runtime,
          'browser_fill_credential',
          context,
          async (op) => {
            const { target, operationId, outcome } =
              await service.fillCredential(op, {
                ...(args.targetId === undefined
                  ? {}
                  : { targetId: args.targetId }),
                ref: args.ref,
                handleId: args.handleId,
                field: args.field,
              })
            return uiResult({
              tool: 'browser_fill_credential',
              summary: {
                targetId: target.targetId,
                field: args.field,
                filled: outcome.filled,
                origin: outcome.bindingMatched,
                operationId,
                next: outcome.filled
                  ? VERIFY
                  : 'The field still looks empty; observe the page or ask the user to take over.',
              },
              meta: {
                ...targetMeta(target),
                operationId,
                outcome: outcome.filled ? 'observed' : 'no-effect',
                credential: {
                  handleId: args.handleId,
                  field: args.field,
                  filled: outcome.filled,
                },
                ...grantMeta(op),
              },
            })
          },
        ),
    }),
    defineTool({
      name: 'browser_upload',
      description:
        'Upload files through a page’s file input. The user confirms, then picks the files themselves in a system file dialog — you never choose or see local paths. Returns the chosen file names.',
      input: browserUploadInput,
      timeoutMs: 300_000,
      execute: async (args, context) =>
        await runGuiTool(runtime, 'browser_upload', context, async (op) => {
          const { target, operationId, upload } = await service.upload(op, {
            ...(args.targetId === undefined ? {} : { targetId: args.targetId }),
            ref: args.ref,
          })
          return uiResult({
            tool: 'browser_upload',
            summary: {
              state: upload.state,
              count: upload.files.length,
              bytes: upload.bytes,
              operationId,
              next:
                upload.state === 'attached'
                  ? VERIFY
                  : 'The user cancelled the file picker; nothing was uploaded.',
            },
            ...(upload.files.length === 0
              ? {}
              : {
                  untrusted: {
                    kind: 'browser' as const,
                    locator: target.url,
                    transport: 'upload',
                    content: upload.files
                      .map((name) => `file: ${name}`)
                      .join('\n'),
                  },
                }),
            meta: {
              ...targetMeta(target),
              operationId,
              outcome: upload.state === 'attached' ? 'observed' : 'no-effect',
              upload: {
                state: upload.state,
                files: upload.files.slice(0, 20),
                bytes: upload.bytes,
              },
              ...grantMeta(op),
            },
          })
        }),
    }),
    defineTool({
      name: 'browser_profile_list',
      description:
        'List browser profiles: the temporary one and persistent ones that keep cookies and logins between tasks. Grants are per profile.',
      input: browserProfileListInput,
      isConcurrencySafe: () => true,
      timeoutMs: 15_000,
      execute: async (_args, context) =>
        await runGuiTool(runtime, 'browser_profile_list', context, async () => {
          const profiles = service.listProfiles()
          return uiResult({
            tool: 'browser_profile_list',
            summary: {
              profiles: profiles.map((profile) => ({
                profileId: profile.profileId,
                name: profile.name,
                kind: profile.kind,
                openTabs: profile.openTargets,
                ...(profile.lastUsedAt === undefined
                  ? {}
                  : { lastUsedAt: profile.lastUsedAt }),
              })),
            },
            meta: { profiles: profiles.length },
          })
        }),
    }),
    defineTool({
      name: 'browser_profile_manage',
      description:
        'Create a persistent browser profile (a separate cookie jar that keeps logins between tasks). Only the user can clear or delete a profile, in Settings.',
      input: browserProfileManageInput,
      timeoutMs: 15_000,
      execute: async (args, context) =>
        await runGuiTool(
          runtime,
          'browser_profile_manage',
          context,
          async () => {
            if (args.action !== 'create')
              throw new UiError(
                'PERMISSION_REQUIRED',
                'only the user can clear or delete a browser profile',
                {
                  reason: 'user-only',
                  hint: 'Ask the user to do it in Settings › 电脑操作 › 浏览器 profile.',
                },
              )
            if (args.name === undefined)
              throw new UiError(
                'INVALID_REQUEST',
                'give the new profile a name',
              )
            const created = service.createProfile(args.name)
            return uiResult({
              tool: 'browser_profile_manage',
              summary: {
                created: created.profileId,
                name: created.name,
                next: 'Open a tab with browser_open { profile } to use it.',
              },
              meta: { profileId: created.profileId },
            })
          },
        ),
    }),
    defineTool({
      name: 'browser_tab_select',
      description:
        'Make one of your tabs the current tab for later browser_* calls.',
      input: browserTabSelectInput,
      timeoutMs: 15_000,
      execute: async (args, context) =>
        await runGuiTool(runtime, 'browser_tab_select', context, async (op) => {
          const record = service.select(op.identity, args.targetId)
          return uiResult({
            tool: 'browser_tab_select',
            summary: { targetId: record.targetId, url: record.url },
            meta: targetMeta(record),
          })
        }),
    }),
    defineTool({
      name: 'browser_close',
      description:
        'Close one of your built-in browser tabs (the current one by default).',
      input: browserCloseInput,
      timeoutMs: 15_000,
      execute: async (args, context) =>
        await runGuiTool(runtime, 'browser_close', context, async (op) => {
          const record = await service.close(op, {
            ...(args.targetId === undefined ? {} : { targetId: args.targetId }),
          })
          return uiResult({
            tool: 'browser_close',
            summary: { closed: record.targetId },
            meta: targetMeta(record),
          })
        }),
    }),
    defineTool({
      name: 'browser_observe',
      description:
        'Read the current page as a list of interactive elements with refs such as r12.37 (valid only until the next observation or navigation), their roles, names, values and states, plus a text excerpt. Secret fields show only whether they have content. Use role / nameContains to narrow a large page, diff: true to see only what changed, and cursor to read the rest of a truncated list.',
      input: browserObserveInput,
      isConcurrencySafe: () => false,
      timeoutMs: 30_000,
      execute: async (args, context) =>
        await runGuiTool(runtime, 'browser_observe', context, async (op) => {
          const query = {
            ...(args.role === undefined ? {} : { role: args.role }),
            ...(args.nameContains === undefined
              ? {}
              : { nameContains: args.nameContains }),
          }
          const observation = await service.observe(op, {
            ...(args.targetId === undefined ? {} : { targetId: args.targetId }),
            ...(Object.keys(query).length === 0 ? {} : { query }),
            ...(args.diff === undefined ? {} : { diff: args.diff }),
            ...(args.cursor === undefined ? {} : { cursor: args.cursor }),
            ...(args.maxElements === undefined
              ? {}
              : { maxElements: args.maxElements }),
            ...(args.includeText === undefined
              ? {}
              : { includeText: args.includeText }),
          })
          const record = service.lookup(
            op.identity,
            observation.target.targetId,
          )
          const notes = observation.notes ?? []
          return uiResult({
            tool: 'browser_observe',
            summary: {
              targetId: observation.target.targetId,
              url: observation.urlOrApp,
              revision: observation.revision,
              generation: observation.target.generation,
              elements: observation.elements.length,
              truncated: observation.truncated,
              ...(observation.cursor === undefined
                ? {}
                : { cursor: observation.cursor }),
              ...(observation.diffFrom === undefined
                ? {}
                : { diffFrom: observation.diffFrom }),
              redactions: observation.redactions,
              viewport: observation.viewport,
            },
            untrusted: {
              kind: 'browser',
              locator: observation.urlOrApp,
              transport: 'cdp',
              content: [
                renderObservationContent(observation),
                ...(notes.length === 0 ? [] : ['notes:', ...notes]),
              ].join('\n'),
            },
            meta: {
              ...(record === undefined ? {} : targetMeta(record)),
              outcome: 'observed',
              revisions: { after: observation.revision },
              elements: observation.elements.length,
              redactions: observation.redactions,
              ...grantMeta(op),
            },
          })
        }),
    }),
    defineTool({
      name: 'browser_screenshot',
      description:
        'Capture the visible part of the current tab. The image is saved for the user; it is sent to you only when the current model can see images. Prefer browser_observe for finding and using elements.',
      input: browserScreenshotInput,
      timeoutMs: 30_000,
      execute: async (args, context) =>
        await runGuiTool(runtime, 'browser_screenshot', context, async (op) => {
          const shot = await service.screenshot(op, {
            ...(args.targetId === undefined ? {} : { targetId: args.targetId }),
          })
          const image: ImageAttachmentRef | undefined =
            shot.model === undefined
              ? undefined
              : {
                  attachmentId: shot.model.attachmentId,
                  mediaType: shot.model.mediaType,
                  bytes: shot.model.bytes,
                }
          return uiResult({
            tool: 'browser_screenshot',
            summary: {
              targetId: shot.target.targetId,
              url: shot.target.url,
              screenshotId: shot.screenshotId,
              width: shot.audit.width,
              height: shot.audit.height,
              sentToModel: image !== undefined,
              ...(image === undefined
                ? {
                    note: 'The current model cannot see images; the screenshot was saved for the user.',
                  }
                : {}),
            },
            ...(image === undefined ? {} : { image }),
            meta: {
              ...targetMeta(shot.target),
              outcome: 'observed',
              screenshot: {
                attachmentId: shot.audit.attachmentId,
                width: shot.audit.width,
                height: shot.audit.height,
              },
              ...grantMeta(op),
            },
          })
        }),
    }),
    defineTool({
      name: 'browser_click',
      description:
        'Click an element by its ref from the latest observation. Clicks that look like paying, ordering, deleting, sending or publishing always need the user’s one-time confirmation.',
      input: browserClickInput,
      timeoutMs: 30_000,
      execute: act(
        'browser_click',
        (args: {
          ref: string
          button?: 'left' | 'right' | 'middle'
          count?: 1 | 2
        }) => ({
          kind: 'click',
          ref: args.ref,
          ...(args.button === undefined ? {} : { button: args.button }),
          ...(args.count === undefined ? {} : { count: args.count }),
        }),
      ) as never,
    }),
    defineTool({
      name: 'browser_fill',
      description:
        'Replace the text of an input field. The text is recorded in the task log, so never use it for passwords, card numbers or one-time codes — secret fields are refused.',
      input: browserFillInput,
      timeoutMs: 30_000,
      execute: act('browser_fill', (args: { ref: string; text: string }) => ({
        kind: 'fill',
        ref: args.ref,
        text: args.text,
      })) as never,
    }),
    defineTool({
      name: 'browser_type',
      description:
        'Type text into the focused element (or the element ref). A newline presses Enter, which may submit a form.',
      input: browserTypeInput,
      timeoutMs: 30_000,
      execute: act('browser_type', (args: { text: string; ref?: string }) => ({
        kind: 'typeText',
        text: args.text,
        ...(args.ref === undefined ? {} : { ref: args.ref }),
      })) as never,
    }),
    defineTool({
      name: 'browser_press',
      description:
        'Press a key or key combination, e.g. Enter, Tab, Escape, Meta+A.',
      input: browserPressInput,
      timeoutMs: 30_000,
      execute: act('browser_press', (args: { key: string; ref?: string }) => ({
        kind: 'press',
        key: args.key,
        ...(args.ref === undefined ? {} : { ref: args.ref }),
      })) as never,
    }),
    defineTool({
      name: 'browser_select',
      description:
        'Choose an option of a drop-down list (select element) by its label.',
      input: browserSelectInput,
      timeoutMs: 30_000,
      execute: act(
        'browser_select',
        (args: { ref: string; option: string }) => ({
          kind: 'select',
          ref: args.ref,
          option: args.option,
        }),
      ) as never,
    }),
    defineTool({
      name: 'browser_scroll',
      description: 'Scroll the page or a scrollable element by pages or lines.',
      input: browserScrollInput,
      timeoutMs: 30_000,
      execute: act(
        'browser_scroll',
        (args: {
          direction: 'up' | 'down' | 'left' | 'right'
          amount: number
          unit: 'page' | 'line'
          ref?: string
        }) => ({
          kind: 'scroll',
          direction: args.direction,
          amount: args.amount,
          unit: args.unit,
          ...(args.ref === undefined ? {} : { ref: args.ref }),
        }),
      ) as never,
    }),
    defineTool({
      name: 'browser_navigate',
      description:
        'Go to a URL in the current tab, or move back / forward / reload. A site you have not been granted asks the user first (unless the preset allows it).',
      input: browserNavigateInput,
      timeoutMs: 45_000,
      execute: act(
        'browser_navigate',
        (args: { url?: string; history?: 'back' | 'forward' | 'reload' }) =>
          args.url !== undefined
            ? { kind: 'navigate', url: args.url }
            : { kind: 'history', direction: args.history! },
      ) as never,
    }),
    defineTool({
      name: 'browser_wait',
      description:
        'Wait until a condition holds: navigation (optionally to a URL containing text), an element present / absent / enabled, page text, or network idle. Never wait a fixed time.',
      input: browserWaitInput,
      timeoutMs: 75_000,
      execute: async (args, context) =>
        await runGuiTool(runtime, 'browser_wait', context, async (op) => {
          const result = await service.wait(op, {
            ...(args.targetId === undefined ? {} : { targetId: args.targetId }),
            condition: args.condition,
            timeoutMs: args.timeoutMs,
          })
          return uiResult({
            tool: 'browser_wait',
            summary: {
              targetId: result.target.targetId,
              satisfied: result.outcome.satisfied,
              revision: result.outcome.revision,
              url: result.outcome.url ?? result.target.url,
              ...(result.outcome.detail === undefined
                ? {}
                : { detail: result.outcome.detail }),
            },
            meta: {
              ...targetMeta(result.target),
              operationId: result.operationId,
              outcome: result.outcome.satisfied ? 'observed' : 'no-effect',
              ...grantMeta(op),
            },
          })
        }),
    }),
  ]
}
