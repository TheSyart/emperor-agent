/**
 * GUI tool catalog: what each tool is, for the gate. `info` tools only read
 * the caller's own kernel state; `control` tools narrow or manage state and
 * do their own checks; `target` tools touch a page or window and need a
 * grant (or D1 auto-approval) for a concrete requirement.
 */

import { UiError } from '../errors'
import { normalizeOrigin } from '../grants/match'
import type { UiCallerIdentity } from '../identity'
import type { UiRequirement } from '../policy'
import type { HighImpactClassifier } from '../risk'
import type { ComputerUseService } from '../service/service'
import type { TargetRecord } from '../service/registry'
import type { UiActionClass } from '../types'

export type CatalogKind = 'info' | 'control' | 'target'

export interface ClassifyInput {
  readonly args: Record<string, unknown>
  readonly identity: UiCallerIdentity
  readonly service: ComputerUseService
  readonly highImpact: HighImpactClassifier
  readonly callId: string
  readonly toolName: string
}

export interface Classified {
  readonly requirement: UiRequirement
  readonly target?: TargetRecord
}

export interface CatalogEntry {
  readonly kind: CatalogKind
  /** Allowed while plan mode is on (read-only). */
  readonly planSafe: boolean
  classify?(input: ClassifyInput): Classified
}

const TEMPORARY = 'temporary'

function webUrl(value: unknown): string {
  const origin = typeof value === 'string' ? normalizeOrigin(value) : null
  if (origin === null)
    throw new UiError('INVALID_REQUEST', 'only http(s) URLs can be used', {
      reason: 'non-web-url',
    })
  return String(value)
}

function currentTarget(
  input: ClassifyInput,
  missing = 'no open tab; call browser_open first',
): TargetRecord {
  const targetId =
    typeof input.args.targetId === 'string' ? input.args.targetId : undefined
  const record = input.service.lookup(input.identity, targetId)
  if (record === undefined)
    throw new UiError(
      'INVALID_REQUEST',
      targetId === undefined ? missing : `unknown target ${targetId}`,
    )
  return record
}

function onTarget(
  actionClass: UiActionClass,
  extra?: (
    input: ClassifyInput,
    target: TargetRecord,
  ) => Partial<UiRequirement>,
): (input: ClassifyInput) => Classified {
  return (input) => {
    const target = currentTarget(input)
    if (
      target.driver !== 'embedded-browser' &&
      target.driver !== 'external-browser'
    )
      throw new UiError('INVALID_REQUEST', 'select a browser tab for this tool')
    // An element inside a cross-origin frame is authorised for the frame's
    // origin (a grant for the page must not cover an embedded payment or
    // sign-in frame).
    const frameOrigin =
      actionClass === 'observe'
        ? undefined
        : elementOf(input, target)?.frameOrigin
    return {
      target,
      requirement: {
        driver: target.driver,
        actionClass,
        profileId: target.profileId,
        origin: frameOrigin ?? target.url,
        ...(frameOrigin === undefined ? {} : { inFrame: true }),
        callId: input.callId,
        toolName: input.toolName,
        display:
          frameOrigin === undefined
            ? { url: target.url, title: target.title }
            : {
                url: frameOrigin,
                title: target.title,
                embeddedIn: target.url,
              },
        ...(extra?.(input, target) ?? {}),
      },
    }
  }
}

function onDesktopTarget(
  actionClass: UiActionClass,
  extra?: (
    input: ClassifyInput,
    target: TargetRecord,
  ) => Partial<UiRequirement>,
): (input: ClassifyInput) => Classified {
  return (input) => {
    const target = currentTarget(
      input,
      'no bound window (it may have closed); call desktop_list_windows, then desktop_bind',
    )
    if (
      target.driver !== 'desktop' ||
      target.appId === undefined ||
      target.windowRef === undefined
    )
      throw new UiError(
        'INVALID_REQUEST',
        'select a desktop window with desktop_bind first',
      )
    if (input.service.isProtectedApp(target.appId))
      throw new UiError('TARGET_FORBIDDEN', 'this app is protected')
    const highRisk = input.service.isHighRiskApp(target.appId)
    const { display, ...more } = extra?.(input, target) ?? {}
    return {
      target,
      requirement: {
        driver: 'desktop',
        actionClass,
        appId: target.appId,
        windowRef: target.windowRef,
        ...(highRisk ? { highRiskApp: true } : {}),
        ...(highRisk && actionClass !== 'observe' && !input.identity.fullAccess
          ? { confirmEachTime: true }
          : {}),
        callId: input.callId,
        toolName: input.toolName,
        display: { appName: target.appId, title: target.title, ...display },
        ...more,
      },
    }
  }
}

function elementOf(input: ClassifyInput, target: TargetRecord) {
  const ref = typeof input.args.ref === 'string' ? input.args.ref : undefined
  return ref === undefined ? undefined : target.elements.get(ref)
}

const info: CatalogEntry = { kind: 'info', planSafe: true }
const control: CatalogEntry = { kind: 'control', planSafe: true }

export const GUI_TOOL_CATALOG: Readonly<Record<string, CatalogEntry>> = {
  ui_get_capabilities: info,
  ui_list_targets: info,
  ui_action_status: info,
  ui_credential_list: info,
  ui_request_control: { kind: 'control', planSafe: false },
  ui_delegate_grant: { kind: 'control', planSafe: false },
  ui_release_control: control,
  ui_cancel_action: control,

  browser_tab_list: info,
  browser_profile_list: info,
  browser_profile_manage: { kind: 'control', planSafe: false },
  browser_tab_select: control,
  browser_close: control,
  browser_open: {
    kind: 'target',
    planSafe: false,
    classify: (input) => {
      const url = webUrl(input.args.url)
      return {
        requirement: {
          driver: 'embedded-browser',
          actionClass: 'navigate',
          askActions: ['observe', 'interact', 'navigate'],
          profileId:
            typeof input.args.profile === 'string'
              ? input.args.profile
              : TEMPORARY,
          origin: url,
          callId: input.callId,
          toolName: input.toolName,
          display: { url },
          ...(typeof input.args.reason === 'string'
            ? { reason: input.args.reason }
            : {}),
        },
      }
    },
  },
  browser_observe: {
    kind: 'target',
    planSafe: true,
    classify: onTarget('observe'),
  },
  browser_screenshot: {
    kind: 'target',
    planSafe: true,
    classify: onTarget('observe'),
  },
  browser_wait: {
    kind: 'target',
    planSafe: true,
    classify: onTarget('observe'),
  },
  browser_fill_credential: {
    kind: 'target',
    planSafe: false,
    classify: onTarget('interact', (input, target) => {
      const handleId =
        typeof input.args.handleId === 'string' ? input.args.handleId : ''
      input.service.assertVaultReady()
      const handle = input.service.credentialHandle(handleId)
      if (handle === undefined)
        throw new UiError(
          'INVALID_REQUEST',
          `there is no credential ${handleId}; call ui_credential_list`,
        )
      // Hard rule before any card: the page must be a registered origin.
      input.service.credentialBinding(handle, target)
      // And the field must suit the secret (00 §6.4), when the page says.
      const inputType = elementOf(input, target)?.inputType
      if (inputType !== undefined) {
        const fits =
          input.args.field === 'password'
            ? inputType === 'password'
            : input.args.field === 'username'
              ? ['text', 'email'].includes(inputType)
              : ['text', 'tel', 'number'].includes(inputType)
        if (!fits)
          throw new UiError(
            'INVALID_REQUEST',
            'credential field type does not match the saved field',
            { reason: 'credential-field-type' },
          )
      }
      const field =
        input.args.field === 'password'
          ? '密码'
          : input.args.field === 'totp'
            ? '一次性验证码'
            : '用户名'
      return {
        confirmEachTime: true,
        display: {
          url: target.url,
          title: `代填「${handle.label.slice(0, 60)}」的${field}`,
        },
      }
    }),
  },
  browser_upload: {
    kind: 'target',
    planSafe: false,
    classify: onTarget('transfer', (input, target) => {
      const element = elementOf(input, target)
      return {
        display: {
          url: target.url,
          title: `上传文件${element?.name ? `到「${element.name.slice(0, 80)}」` : ''}（你将亲自选择文件）`,
        },
      }
    }),
  },
  browser_download: {
    kind: 'target',
    planSafe: false,
    classify: onTarget('transfer', (input, target) => {
      const url =
        typeof input.args.url === 'string' ? input.args.url : undefined
      const element = elementOf(input, target)
      return {
        display: {
          url: url ?? target.url,
          title: `下载${element?.name ? `「${element.name.slice(0, 80)}」` : ''}`,
        },
      }
    }),
  },
  browser_click: {
    kind: 'target',
    planSafe: false,
    classify: onTarget('interact', (input, target) => {
      const element = elementOf(input, target)
      return input.highImpact({
        toolName: input.toolName,
        ...(element === undefined ? {} : { element }),
      })
        ? { highImpact: true }
        : {}
    }),
  },
  browser_press: {
    kind: 'target',
    planSafe: false,
    classify: onTarget('interact', (input, target) => {
      const element = elementOf(input, target)
      return input.highImpact({
        toolName: input.toolName,
        ...(element === undefined ? {} : { element }),
        ...(typeof input.args.key === 'string' ? { key: input.args.key } : {}),
      })
        ? { highImpact: true }
        : {}
    }),
  },
  browser_fill: {
    kind: 'target',
    planSafe: false,
    classify: onTarget('interact'),
  },
  browser_type: {
    kind: 'target',
    planSafe: false,
    classify: onTarget('interact'),
  },
  browser_select: {
    kind: 'target',
    planSafe: false,
    classify: onTarget('interact'),
  },
  browser_scroll: {
    kind: 'target',
    planSafe: false,
    classify: onTarget('interact'),
  },
  browser_navigate: {
    kind: 'target',
    planSafe: false,
    classify: (input) => {
      const target = currentTarget(input)
      if (
        target.driver !== 'embedded-browser' &&
        target.driver !== 'external-browser'
      )
        throw new UiError(
          'INVALID_REQUEST',
          'select a browser tab for this tool',
        )
      const history = input.args.history
      const destination =
        typeof history === 'string'
          ? (input.service.historyTarget(
              target,
              history as 'back' | 'forward' | 'reload',
            ) ?? target.url)
          : webUrl(input.args.url)
      return {
        target,
        requirement: {
          driver: target.driver,
          actionClass: 'navigate',
          askActions: ['observe', 'interact', 'navigate'],
          profileId: target.profileId,
          origin: destination,
          callId: input.callId,
          toolName: input.toolName,
          display: { url: destination, title: target.title },
        },
      }
    },
  },

  external_tab_list: info,
  external_tab_attach: {
    kind: 'target',
    planSafe: false,
    classify: (input) => {
      const targetId = input.args.targetId
      if (typeof targetId !== 'string')
        throw new UiError('INVALID_REQUEST', 'targetId is required')
      const candidate = input.service.externalCandidate(
        input.identity.ownerSessionId,
        targetId,
      )
      return {
        requirement: {
          driver: 'external-browser',
          actionClass: 'observe',
          profileId: candidate.profileId,
          origin: candidate.origin,
          callId: input.callId,
          toolName: input.toolName,
          display: { url: candidate.origin, title: '连接外部浏览器标签页' },
        },
      }
    },
  },

  desktop_list_apps: info,
  desktop_list_windows: info,
  desktop_bind: {
    kind: 'target',
    planSafe: false,
    classify: (input) => {
      const windowRef = input.args.windowRef
      if (typeof windowRef !== 'string')
        throw new UiError('INVALID_REQUEST', 'windowRef is required')
      const candidate = input.service.desktopCandidate(
        input.identity,
        windowRef,
      )
      return {
        requirement: {
          driver: 'desktop',
          actionClass: 'observe',
          appId: candidate.appId,
          windowRef: candidate.windowRef,
          ...(input.service.isHighRiskApp(candidate.appId)
            ? { highRiskApp: true }
            : {}),
          callId: input.callId,
          toolName: input.toolName,
          display: { appName: candidate.appName, title: candidate.title },
        },
      }
    },
  },
  desktop_observe: {
    kind: 'target',
    planSafe: true,
    classify: onDesktopTarget('observe'),
  },
  desktop_screenshot: {
    kind: 'target',
    planSafe: true,
    classify: onDesktopTarget('observe', (input, target) => {
      // Refuse before any card: a sensitive app is never captured.
      if (input.service.isSensitiveApp(target.appId!))
        throw new UiError(
          'CAPABILITY_DISABLED',
          'the user marked this app as sensitive; screenshots are not taken',
          { reason: 'sensitive-app' },
        )
      return {}
    }),
  },
  desktop_click: {
    kind: 'target',
    planSafe: false,
    classify: onDesktopTarget('interact', (input, target) => {
      const element = elementOf(input, target)
      return input.args.point !== undefined ||
        input.highImpact({
          toolName: input.toolName,
          ...(element === undefined ? {} : { element }),
        })
        ? { highImpact: true }
        : {}
    }),
  },
  desktop_fill: {
    kind: 'target',
    planSafe: false,
    classify: onDesktopTarget('interact'),
  },
  desktop_select: {
    kind: 'target',
    planSafe: false,
    classify: onDesktopTarget('interact', (input, target) => {
      const element = elementOf(input, target)
      const option =
        typeof input.args.option === 'string' ? input.args.option : ''
      return input.highImpact({
        toolName: 'desktop_click',
        element: {
          role: element?.role ?? '',
          name: `${element?.name ?? ''} ${option}`,
        },
      })
        ? { highImpact: true }
        : {}
    }),
  },
  desktop_fill_credential: {
    kind: 'target',
    planSafe: false,
    classify: onDesktopTarget('interact', (input, target) => {
      const handleId =
        typeof input.args.handleId === 'string' ? input.args.handleId : ''
      input.service.assertVaultReady()
      const handle = input.service.credentialHandle(handleId)
      if (handle === undefined)
        throw new UiError(
          'INVALID_REQUEST',
          `there is no credential ${handleId}; call ui_credential_list`,
        )
      input.service.desktopCredentialBinding(handle, target)
      const field =
        input.args.field === 'password'
          ? '密码'
          : input.args.field === 'totp'
            ? '一次性验证码'
            : '用户名'
      return {
        confirmEachTime: true,
        display: {
          appName: target.appId,
          title: `代填「${handle.label.slice(0, 60)}」的${field}`,
        },
      }
    }),
  },
  desktop_type: {
    kind: 'target',
    planSafe: false,
    classify: onDesktopTarget('interact', (input) =>
      typeof input.args.text === 'string'
        ? { display: { input: { kind: 'text', text: input.args.text } } }
        : {},
    ),
  },
  desktop_press: {
    kind: 'target',
    planSafe: false,
    classify: onDesktopTarget('interact', (input, target) => {
      const element = elementOf(input, target)
      const key =
        typeof input.args.key === 'string' ? input.args.key : undefined
      const highImpact = input.highImpact({
        toolName: input.toolName,
        ...(element === undefined ? {} : { element }),
        ...(key === undefined ? {} : { key }),
      })
      return {
        ...(highImpact ? { highImpact: true } : {}),
        ...(key === undefined
          ? {}
          : { display: { input: { kind: 'key', key } } }),
      }
    }),
  },
  desktop_scroll: {
    kind: 'target',
    planSafe: false,
    classify: onDesktopTarget('interact'),
  },
  desktop_drag: {
    kind: 'target',
    planSafe: false,
    classify: onDesktopTarget('interact', (input, target) => {
      const from =
        typeof input.args.from === 'string'
          ? target.elements.get(input.args.from)
          : undefined
      const to =
        typeof input.args.to === 'string'
          ? target.elements.get(input.args.to)
          : undefined
      return typeof input.args.from !== 'string' ||
        typeof input.args.to !== 'string' ||
        [from, to].some(
          (element) =>
            element !== undefined &&
            input.highImpact({ toolName: 'desktop_click', element }),
        )
        ? { highImpact: true }
        : {}
    }),
  },
  desktop_menu: {
    kind: 'target',
    planSafe: true,
    classify: onDesktopTarget('observe'),
  },
  desktop_menu_select: {
    kind: 'target',
    planSafe: false,
    classify: onDesktopTarget('interact', (input, target) => {
      const path = Array.isArray(input.args.path)
        ? input.args.path.filter(
            (title): title is string => typeof title === 'string',
          )
        : []
      const name = path.join(' › ')
      return {
        ...(input.highImpact({
          toolName: input.toolName,
          element: { role: 'menuitem', name },
        })
          ? { highImpact: true }
          : {}),
        display: { title: `${target.title} · 菜单 ${name}` },
      }
    }),
  },
  desktop_activate: {
    kind: 'target',
    planSafe: false,
    // An ordinary, reversible step (the front goes back when the task
    // ends): it follows the user's mode like any interaction. Continuous
    // allow proceeds; per-item mode asks, then not again this task.
    classify: onDesktopTarget('interact', (input, target) =>
      input.service.hasForegroundConsent(
        input.identity.ownerSessionId,
        target.targetId,
      )
        ? {}
        : {
            display: {
              title: `把「${target.title.slice(0, 80)}」切到前台（本任务结束后还原）`,
            },
          },
    ),
  },
  desktop_secondary: {
    kind: 'target',
    planSafe: false,
    classify: onDesktopTarget('interact', (input, target) => {
      const element = elementOf(input, target)
      const action = input.args.action
      const name = `${element?.name ?? ''} ${typeof action === 'string' ? action : ''}`
      return input.highImpact({
        toolName: 'desktop_click',
        element: { role: element?.role ?? '', name },
      })
        ? { highImpact: true }
        : {}
    }),
  },
}

export const GUI_TOOL_PREFIXES = [
  'ui_',
  'browser_',
  'external_',
  'desktop_',
] as const

export function isGuiToolName(name: string): boolean {
  return GUI_TOOL_PREFIXES.some((prefix) => name.startsWith(prefix))
}
