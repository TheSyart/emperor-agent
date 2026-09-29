/** Argument schemas for the GUI tools (bounded; strict objects). */

import { z } from 'zod'
import {
  elementRefSchema,
  MAX_TEXT_INPUT,
  menuTitle,
  MAX_URL_LENGTH,
  pointRefSchema,
  waitConditionSchema,
} from '../schemas'

const targetId = z
  .string()
  .min(1)
  .max(256)
  .describe(
    'Target id from browser_open / ui_list_targets; omit for the current tab.',
  )

export const uiGetCapabilitiesInput = z.object({}).strict()

export const uiListTargetsInput = z.object({}).strict()

export const uiRequestControlInput = z
  .object({
    driver: z.literal('embedded-browser').default('embedded-browser'),
    origins: z
      .array(z.string().min(1).max(512))
      .min(1)
      .max(8)
      .describe('Exact origins such as https://example.com'),
    actions: z
      .array(z.enum(['observe', 'interact', 'navigate']))
      .min(1)
      .max(3),
    background: z
      .boolean()
      .optional()
      .describe(
        'Ask to keep working while the user is away (scheduler / goal runs).',
      ),
    reason: z.string().min(1).max(300).optional(),
  })
  .strict()

export const uiDelegateGrantInput = z
  .object({
    grantId: z.string().min(1).max(128),
    childId: z.string().min(1).max(256),
    actions: z
      .array(z.enum(['observe', 'interact', 'navigate']))
      .min(1)
      .max(3),
    origins: z.array(z.string().min(1).max(512)).min(1).max(8).optional(),
  })
  .strict()

export const uiReleaseControlInput = z
  .object({
    targetId: targetId.optional(),
    grantId: z.string().min(1).max(128).optional(),
  })
  .strict()
  .refine(
    (value) => (value.targetId === undefined) !== (value.grantId === undefined),
    {
      message: 'give exactly one of targetId or grantId',
    },
  )

export const uiActionStatusInput = z
  .object({
    operationId: z.string().min(1).max(128).optional(),
    callId: z.string().min(1).max(256).optional(),
  })
  .strict()
  .refine(
    (value) =>
      (value.operationId === undefined) !== (value.callId === undefined),
    { message: 'give exactly one of operationId or callId' },
  )

export const uiCancelActionInput = z
  .object({ operationId: z.string().min(1).max(128) })
  .strict()

const url = z.string().min(1).max(MAX_URL_LENGTH)

const profileId = z
  .string()
  .regex(/^(temporary|p_[0-9a-f]{12})$/)
  .describe(
    'Browser profile id from browser_profile_list (default: temporary, cleared when the tab closes).',
  )

export const browserOpenInput = z
  .object({
    url: url.describe('http(s) URL to open in a new agent tab.'),
    profile: profileId.optional(),
    reason: z.string().min(1).max(300).optional(),
  })
  .strict()

export const browserProfileListInput = z.object({}).strict()

export const browserProfileManageInput = z
  .object({
    action: z
      .enum(['create', 'clear', 'delete'])
      .describe(
        'create a new persistent profile; clearing or deleting one is done by the user in Settings.',
      ),
    name: z.string().min(1).max(60).optional(),
    profileId: profileId.optional(),
  })
  .strict()

export const browserTabListInput = z.object({}).strict()

export const browserTabSelectInput = z.object({ targetId }).strict()

export const browserCloseInput = z
  .object({ targetId: targetId.optional() })
  .strict()

export const browserObserveInput = z
  .object({
    targetId: targetId.optional(),
    role: z
      .string()
      .min(1)
      .max(32)
      .optional()
      .describe('Only elements of this role.'),
    nameContains: z.string().min(1).max(200).optional(),
    diff: z
      .boolean()
      .optional()
      .describe('Return only what changed since your last observation.'),
    cursor: z
      .string()
      .min(1)
      .max(256)
      .optional()
      .describe('Continue a truncated result.'),
    maxElements: z.number().int().min(1).max(200).optional(),
    includeText: z
      .boolean()
      .optional()
      .describe('Include a page text excerpt (default true).'),
  })
  .strict()

export const browserScreenshotInput = z
  .object({ targetId: targetId.optional() })
  .strict()

const desktopTargetId = z
  .string()
  .min(1)
  .max(256)
  .describe(
    'Desktop target id from desktop_bind or ui_list_targets; omit for the current target.',
  )

export const desktopListAppsInput = z.object({}).strict()

export const desktopListWindowsInput = z
  .object({
    appId: z.string().min(1).max(256).optional(),
  })
  .strict()

export const desktopBindInput = z
  .object({
    windowRef: z
      .string()
      .min(1)
      .max(256)
      .describe('Fresh window reference from desktop_list_windows.'),
  })
  .strict()

export const desktopObserveInput = z
  .object({
    targetId: desktopTargetId.optional(),
    role: z.string().min(1).max(32).optional(),
    nameContains: z.string().min(1).max(200).optional(),
    diff: z.boolean().optional(),
    cursor: z.string().min(1).max(256).optional(),
    maxElements: z.number().int().min(1).max(200).optional(),
    maxDepth: z.number().int().min(1).max(16).optional(),
    includeText: z.boolean().optional(),
  })
  .strict()

export const desktopScreenshotInput = z
  .object({
    targetId: desktopTargetId.optional(),
  })
  .strict()

const desktopActionTarget = { targetId: desktopTargetId.optional() }

export const desktopClickInput = z
  .object({
    ...desktopActionTarget,
    ref: elementRefSchema.optional(),
    point: pointRefSchema
      .optional()
      .describe(
        'Screenshot pixel coordinates from desktop_screenshot; requires image vision.',
      ),
    button: z.enum(['left', 'right', 'middle']).optional(),
    count: z.union([z.literal(1), z.literal(2)]).optional(),
  })
  .strict()
  .refine(
    (value) => (value.ref === undefined) !== (value.point === undefined),
    {
      message: 'give exactly one of ref or point',
    },
  )

export const desktopFillInput = z
  .object({
    ...desktopActionTarget,
    ref: elementRefSchema,
    text: z
      .string()
      .max(MAX_TEXT_INPUT)
      .describe('Non-secret text; it is recorded in the task log.'),
    append: z
      .boolean()
      .optional()
      .describe(
        'Insert the text at the end of the field instead of replacing its content; a document keeps its formatting.',
      ),
  })
  .strict()

export const desktopSelectInput = z
  .object({
    ...desktopActionTarget,
    ref: elementRefSchema,
    option: z
      .string()
      .min(1)
      .max(500)
      .describe('Non-secret option label; it is recorded in the task log.'),
  })
  .strict()

export const desktopFillCredentialInput = z
  .object({
    ...desktopActionTarget,
    ref: elementRefSchema,
    handleId: z.string().regex(/^cred_[0-9a-f]{24}$/),
    field: z.enum(['username', 'password', 'totp']),
  })
  .strict()

export const desktopTypeInput = z
  .object({
    ...desktopActionTarget,
    text: z.string().min(1).max(2_000),
    ref: elementRefSchema.optional(),
  })
  .strict()

export const desktopPressInput = z
  .object({
    ...desktopActionTarget,
    key: z.string().min(1).max(64),
    ref: elementRefSchema.optional(),
  })
  .strict()

export const desktopScrollInput = z
  .object({
    ...desktopActionTarget,
    direction: z.enum(['up', 'down', 'left', 'right']),
    amount: z.number().int().min(1).max(20).default(1),
    unit: z.enum(['page', 'line']).default('page'),
    ref: elementRefSchema.optional(),
  })
  .strict()

export const desktopDragInput = z
  .object({
    ...desktopActionTarget,
    from: z.union([elementRefSchema, pointRefSchema]),
    to: z.union([elementRefSchema, pointRefSchema]),
  })
  .strict()

const menuPath = z.array(menuTitle).max(4)

export const desktopMenuInput = z
  .object({
    ...desktopActionTarget,
    path: menuPath
      .default([])
      .describe(
        'Menu titles from the menu bar down, e.g. ["View"]; omit for the menu bar itself.',
      ),
  })
  .strict()

export const desktopMenuSelectInput = z
  .object({
    ...desktopActionTarget,
    path: menuPath
      .min(1)
      .describe(
        'Exact titles from desktop_menu, e.g. ["View", "Command Palette..."].',
      ),
  })
  .strict()

export const desktopActivateInput = z
  .object({ ...desktopActionTarget })
  .strict()

export const desktopSecondaryInput = z
  .object({
    ...desktopActionTarget,
    ref: elementRefSchema,
    action: z.string().min(1).max(64),
  })
  .strict()

export const browserClickInput = z
  .object({
    targetId: targetId.optional(),
    ref: elementRefSchema,
    button: z.enum(['left', 'right', 'middle']).optional(),
    count: z.union([z.literal(1), z.literal(2)]).optional(),
  })
  .strict()

export const browserFillInput = z
  .object({
    targetId: targetId.optional(),
    ref: elementRefSchema,
    text: z
      .string()
      .max(MAX_TEXT_INPUT)
      .describe('Non-secret text; it is recorded in the task log.'),
  })
  .strict()

export const browserTypeInput = z
  .object({
    targetId: targetId.optional(),
    text: z.string().min(1).max(2_000),
    ref: elementRefSchema.optional(),
  })
  .strict()

export const browserPressInput = z
  .object({
    targetId: targetId.optional(),
    key: z
      .string()
      .min(1)
      .max(64)
      .describe('A key or combination such as Enter, Tab, Escape, Meta+A.'),
    ref: elementRefSchema.optional(),
  })
  .strict()

export const browserSelectInput = z
  .object({
    targetId: targetId.optional(),
    ref: elementRefSchema,
    option: z.string().min(1).max(500),
  })
  .strict()

export const browserScrollInput = z
  .object({
    targetId: targetId.optional(),
    direction: z.enum(['up', 'down', 'left', 'right']),
    amount: z.number().int().min(1).max(20).default(1),
    unit: z.enum(['page', 'line']).default('page'),
    ref: elementRefSchema.optional(),
  })
  .strict()

export const browserNavigateInput = z
  .object({
    targetId: targetId.optional(),
    url: url.optional(),
    history: z.enum(['back', 'forward', 'reload']).optional(),
  })
  .strict()
  .refine(
    (value) => (value.url === undefined) !== (value.history === undefined),
    {
      message: 'give exactly one of url or history',
    },
  )

export const browserDownloadInput = z
  .object({
    targetId: targetId.optional(),
    ref: elementRefSchema
      .optional()
      .describe('The download link or button to click.'),
    url: url
      .optional()
      .describe('Or: an http(s) URL to download in this tab’s profile.'),
  })
  .strict()
  .refine((value) => (value.ref === undefined) !== (value.url === undefined), {
    message: 'give exactly one of ref or url',
  })

export const browserUploadInput = z
  .object({
    targetId: targetId.optional(),
    ref: elementRefSchema.describe(
      'The page’s file input (role textbox/button of type file).',
    ),
  })
  .strict()

export const uiCredentialListInput = z
  .object({
    origin: z
      .string()
      .min(1)
      .max(512)
      .optional()
      .describe('Only credentials registered for this exact origin.'),
  })
  .strict()

export const browserFillCredentialInput = z
  .object({
    targetId: targetId.optional(),
    ref: elementRefSchema.describe(
      'The username, password or one-time-code field.',
    ),
    handleId: z.string().regex(/^cred_[0-9a-f]{24}$/),
    field: z.enum(['username', 'password', 'totp']),
  })
  .strict()

export const browserWaitInput = z
  .object({
    targetId: targetId.optional(),
    condition: waitConditionSchema,
    timeoutMs: z.number().int().min(100).max(60_000).default(10_000),
  })
  .strict()
