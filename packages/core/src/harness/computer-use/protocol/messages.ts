/**
 * Platform helper protocol v1 (spec 00 §11): the JSON messages exchanged
 * between Electron main and a native desktop helper. The same schema is
 * exported as JSON Schema (`schema.json`) and exercised by golden fixtures
 * shared with the helper test suites.
 *
 * Handshake: helper → `hello`; main → `welcome` (carries the launch nonce on
 * macOS). A different major protocol version is `PROTOCOL_MISMATCH`.
 */

import { z } from 'zod'
import { UI_ERROR_CODES, UiError } from '../errors'
import {
  elementRefSchema,
  menuTitle,
  observeBudgetSchema,
  observeQuerySchema,
  uiActionSchema,
  waitConditionSchema,
} from '../schemas'

export const HELPER_PROTOCOL_VERSION = 1

const permissionStatus = z.enum(['granted', 'denied', 'unknown', 'stale'])
const requestId = z.number().int().nonnegative()
const identifier = z.string().min(1).max(256)
const errorCode = z.enum(Object.keys(UI_ERROR_CODES) as [string, ...string[]])

export const helloSchema = z
  .object({
    type: z.literal('hello'),
    protocol: z.number().int().positive(),
    helperVersion: z.string().min(1).max(64),
    platform: z.enum(['macos', 'windows', 'linux']),
    arch: z.string().min(1).max(32),
    capabilities: z.array(z.string().min(1).max(64)).max(64),
    permissions: z.record(z.string(), permissionStatus),
  })
  .strict()

export const welcomeSchema = z
  .object({
    type: z.literal('welcome'),
    protocol: z.number().int().positive(),
    /** One-time launch nonce the helper was started with (macOS). */
    nonce: z.string().min(16).max(128).optional(),
    sessionToken: z.string().min(16).max(128).optional(),
  })
  .strict()

export const requestSchema = z
  .object({
    type: z.literal('request'),
    id: requestId,
    method: z.string().min(1).max(64),
    params: z.unknown(),
    deadlineMs: z.number().int().positive().max(120_000),
  })
  .strict()

export const helperErrorSchema = z
  .object({
    code: errorCode,
    message: z.string().max(2_000),
    reason: z.string().max(200).optional(),
  })
  .strict()

export const responseSchema = z.union([
  z
    .object({
      type: z.literal('response'),
      id: requestId,
      ok: z.literal(true),
      result: z.unknown(),
    })
    .strict(),
  z
    .object({
      type: z.literal('response'),
      id: requestId,
      ok: z.literal(false),
      error: helperErrorSchema,
    })
    .strict(),
])

export const eventSchema = z
  .object({
    type: z.literal('event'),
    name: z.string().min(1).max(64),
    data: z.unknown(),
  })
  .strict()

export const cancelSchema = z
  .object({ type: z.literal('cancel'), id: requestId })
  .strict()

export const pingSchema = z
  .object({ type: z.literal('ping'), seq: z.number().int().nonnegative() })
  .strict()

export const pongSchema = z
  .object({ type: z.literal('pong'), seq: z.number().int().nonnegative() })
  .strict()

export const helperMessageSchema = z.union([
  helloSchema,
  welcomeSchema,
  requestSchema,
  responseSchema,
  eventSchema,
  cancelSchema,
  pingSchema,
  pongSchema,
])

export type HelperMessage = z.infer<typeof helperMessageSchema>
export type HelperHello = z.infer<typeof helloSchema>
export type HelperWelcome = z.infer<typeof welcomeSchema>
export type HelperRequest = z.infer<typeof requestSchema>
export type HelperResponse = z.infer<typeof responseSchema>
export type HelperEvent = z.infer<typeof eventSchema>

// ---------------------------------------------------------------------------
// v1 methods: params and results.

const boundsSchema = z
  .object({
    x: z.number().finite(),
    y: z.number().finite(),
    width: z.number().finite().nonnegative(),
    height: z.number().finite().nonnegative(),
  })
  .strict()

const blobRef = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)

export const HELPER_METHODS = {
  'permissions.status': {
    params: z.object({}).strict(),
    result: z
      .object({ permissions: z.record(z.string(), permissionStatus) })
      .strict(),
  },
  'permissions.request': {
    params: z
      .object({ permission: z.enum(['accessibility', 'screen-recording']) })
      .strict(),
    result: z.object({ opened: z.boolean() }).strict(),
  },
  'apps.list': {
    params: z.object({}).strict(),
    result: z
      .object({
        apps: z.array(
          z
            .object({
              appId: identifier,
              name: z.string().max(256),
              pid: z.number().int().positive(),
              frontmost: z.boolean(),
              hidden: z.boolean(),
            })
            .strict(),
        ),
      })
      .strict(),
  },
  'windows.list': {
    params: z.object({ appId: identifier.optional() }).strict(),
    result: z
      .object({
        windows: z.array(
          z
            .object({
              windowRef: identifier,
              appId: identifier,
              appName: z.string().max(256),
              pid: z.number().int().positive(),
              title: z.string().max(1_024),
              minimized: z.boolean(),
              main: z.boolean(),
              bounds: boundsSchema.optional(),
            })
            .strict(),
        ),
      })
      .strict(),
  },
  'target.bind': {
    params: z.object({ windowRef: identifier }).strict(),
    result: z
      .object({
        targetId: identifier,
        generation: z.number().int().positive(),
        revision: z.number().int().nonnegative(),
        appId: identifier,
        title: z.string().max(1_024),
      })
      .strict(),
  },
  'target.release': {
    params: z.object({ targetId: identifier }).strict(),
    result: z.object({}).strict(),
  },
  /**
   * Start or stop the low-rate stream on an agent-controlled window (E-M16):
   * macOS then badges the window and lists the helper as sharing the screen.
   * `active` in the result says whether a stream runs now; a failed start is
   * retried by the helper while the target stays wanted.
   */
  'target.capture': {
    params: z
      .object({
        targetId: identifier,
        generation: z.number().int().positive(),
        active: z.boolean(),
      })
      .strict(),
    result: z.object({ active: z.boolean() }).strict(),
  },
  /**
   * Hand the front back to the app that had it before the first `activate`,
   * only while the target still holds the front (task end).
   */
  'front.restore': {
    params: z
      .object({
        targetId: identifier,
        generation: z.number().int().positive(),
      })
      .strict(),
    result: z.object({ restored: z.boolean() }).strict(),
  },
  /** The stream's latest frame as a JPEG blob, only when newer than `afterSeq`. */
  'target.preview': {
    params: z
      .object({
        targetId: identifier,
        generation: z.number().int().positive(),
        maxEdge: z.number().int().min(64).max(1_024),
        afterSeq: z.number().int().nonnegative().optional(),
      })
      .strict(),
    result: z
      .object({
        seq: z.number().int().nonnegative(),
        live: z.boolean(),
        blobId: blobRef.optional(),
        width: z.number().int().positive().optional(),
        height: z.number().int().positive().optional(),
      })
      .strict(),
  },
  'observe.semantic': {
    params: z
      .object({
        targetId: identifier,
        generation: z.number().int().positive(),
        budget: observeBudgetSchema,
        query: observeQuerySchema.optional(),
        diffFrom: z.number().int().nonnegative().optional(),
        cursor: z.string().max(256).optional(),
        includeText: z.boolean(),
      })
      .strict(),
    result: z
      .object({
        generation: z.number().int().positive(),
        revision: z.number().int().nonnegative(),
        title: z.string().max(1_024),
        urlOrApp: z.string().max(2_048),
        focus: z.boolean(),
        frameOrWindowId: identifier,
        viewport: z
          .object({
            width: z.number().nonnegative(),
            height: z.number().nonnegative(),
            scale: z.number().positive(),
          })
          .strict(),
        elements: z.array(
          z
            .object({
              ref: elementRefSchema,
              role: z.string().min(1).max(32),
              nativeRole: z.string().max(64).optional(),
              name: z.string().max(1_024).optional(),
              value: z.string().max(4_096).optional(),
              states: z.array(z.string().max(32)).max(16).optional(),
              bounds: boundsSchema.optional(),
              actions: z.array(z.string().max(64)).max(16),
              frameId: z.string().max(128).optional(),
              depth: z.number().int().nonnegative().optional(),
            })
            .strict(),
        ),
        removed: z.array(elementRefSchema).optional(),
        textExcerpt: z
          .string()
          .max(64 * 1024)
          .optional(),
        diffFrom: z.number().int().nonnegative().optional(),
        truncated: z.boolean(),
        cursor: z.string().max(256).optional(),
        redactions: z.number().int().nonnegative(),
        notes: z.array(z.string().max(256)).max(16).optional(),
      })
      .strict(),
  },
  /** The bound app's menu bar, or the menu under `path` (Apple menu excluded). */
  'observe.menu': {
    params: z
      .object({
        targetId: identifier,
        generation: z.number().int().positive(),
        path: z.array(menuTitle).max(4),
      })
      .strict(),
    result: z
      .object({
        items: z
          .array(
            z
              .object({
                title: z.string().min(1).max(200),
                enabled: z.boolean(),
                submenu: z.boolean(),
                shortcut: z.string().max(64).optional(),
              })
              .strict(),
          )
          .max(100),
        truncated: z.boolean(),
      })
      .strict(),
  },
  'observe.screenshot': {
    params: z
      .object({
        targetId: identifier,
        generation: z.number().int().positive(),
        modelCopy: z.boolean(),
        modelMaxEdge: z.number().int().min(64).max(4_096),
      })
      .strict(),
    result: z
      .object({
        screenshotId: identifier,
        generation: z.number().int().positive(),
        revision: z.number().int().nonnegative(),
        width: z.number().int().positive(),
        height: z.number().int().positive(),
        scale: z.number().positive(),
        blobId: blobRef,
        model: z
          .object({
            blobId: blobRef,
            width: z.number().int().positive(),
            height: z.number().int().positive(),
          })
          .strict()
          .optional(),
      })
      .strict(),
  },
  act: {
    params: z
      .object({
        operationId: identifier,
        targetId: identifier,
        generation: z.number().int().positive(),
        expectedRevision: z.number().int().nonnegative(),
        action: uiActionSchema,
        /** The user let this window come forward during this task. */
        bringForward: z.boolean().optional(),
      })
      .strict(),
    result: z
      .object({
        outcome: z.enum(['observed', 'no-effect']),
        afterRevision: z.number().int().nonnegative(),
        title: z.string().max(1_024).optional(),
        changes: z.array(z.string().max(256)).max(16).optional(),
        warnings: z.array(z.string().max(256)).max(16).optional(),
      })
      .strict(),
  },
  'act.fillSecret': {
    params: z
      .object({
        operationId: identifier,
        targetId: identifier,
        generation: z.number().int().positive(),
        expectedRevision: z.number().int().nonnegative(),
        ref: elementRefSchema,
        field: z.enum(['username', 'password', 'totp']),
        secret: z.string().min(1).max(4_096),
        binding: z
          .object({
            bundleId: z.string().regex(/^[A-Za-z0-9.-]{3,200}$/),
            teamId: z
              .string()
              .regex(/^[A-Z0-9]{3,32}$/)
              .optional(),
            path: z.string().startsWith('/').max(4_096).optional(),
          })
          .strict()
          .refine(
            (value) => value.teamId !== undefined || value.path !== undefined,
          ),
      })
      .strict(),
    result: z.object({ filled: z.boolean() }).strict(),
  },
  wait: {
    params: z
      .object({
        targetId: identifier,
        generation: z.number().int().positive(),
        condition: waitConditionSchema,
        timeoutMs: z.number().int().min(1).max(60_000),
      })
      .strict(),
    result: z
      .object({
        satisfied: z.boolean(),
        revision: z.number().int().nonnegative(),
        detail: z.string().max(256).optional(),
      })
      .strict(),
  },
  'input.releaseAll': {
    /** `recovery`: also release what a crashed predecessor held (00 §12). */
    params: z.object({ recovery: z.boolean().optional() }).strict(),
    result: z.object({}).strict(),
  },
  shutdown: {
    params: z.object({}).strict(),
    result: z.object({}).strict(),
  },
} as const

export type HelperMethod = keyof typeof HELPER_METHODS
export type HelperParams<M extends HelperMethod> = z.infer<
  (typeof HELPER_METHODS)[M]['params']
>
export type HelperResult<M extends HelperMethod> = z.infer<
  (typeof HELPER_METHODS)[M]['result']
>

export const HELPER_EVENTS = {
  /** Sent right before the first side effect of an `act` (journals "dispatched"). */
  'act.dispatched': z
    .object({
      operationId: identifier,
      /**
       * Where the action lands, in global screen points, for the on-screen
       * virtual pointer; `visible` when the target window is frontmost there.
       * A drag also carries where it ends.
       */
      pointer: z
        .object({
          x: z.number().finite(),
          y: z.number().finite(),
          visible: z.boolean(),
          to: z
            .object({ x: z.number().finite(), y: z.number().finite() })
            .strict()
            .optional(),
        })
        .strict()
        .optional(),
    })
    .strict(),
  'target.changed': z
    .object({ targetId: identifier, revision: z.number().int().nonnegative() })
    .strict(),
  'target.lost': z
    .object({ targetId: identifier, reason: z.string().max(200) })
    .strict(),
  'permissions.changed': z
    .object({ permissions: z.record(z.string(), permissionStatus) })
    .strict(),
  /** Real user input detected on a bound target (§7.8 of the platform docs). */
  'user.input': z.object({ targetId: identifier }).strict(),
  /** The system stopped a capture stream; `user` is the menu-bar "Stop Sharing". */
  'target.capture.stopped': z
    .object({ targetId: identifier, reason: z.enum(['user', 'error']) })
    .strict(),
} as const

export type HelperEventName = keyof typeof HELPER_EVENTS

export function isHelperMethod(value: string): value is HelperMethod {
  return Object.hasOwn(HELPER_METHODS, value)
}

/** Parse one decoded JSON message; throws on anything off-schema. */
export function parseHelperMessage(value: unknown): HelperMessage {
  return helperMessageSchema.parse(value)
}

/** Validate a hello and enforce the major protocol version. */
export function acceptHello(value: unknown): HelperHello {
  const hello = helloSchema.parse(value)
  if (hello.protocol !== HELPER_PROTOCOL_VERSION)
    throw new UiError(
      'PROTOCOL_MISMATCH',
      `helper speaks protocol ${hello.protocol}; this app speaks ${HELPER_PROTOCOL_VERSION}`,
    )
  return hello
}
