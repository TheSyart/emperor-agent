/**
 * zod schemas for the shared Computer Use contract values (actions, waits,
 * observation budgets). The helper protocol and the tool argument schemas
 * both reuse them, so a value accepted by one is accepted by the other.
 */

import { z } from 'zod'
import { UI_ROLES, type UiRole } from './types'

export const MAX_TEXT_INPUT = 10_000
export const MAX_URL_LENGTH = 2_048

export const elementRefSchema = z
  .string()
  .regex(/^r\d{1,9}\.\d{1,6}$/, 'element ref must look like r12.37')

export const pointRefSchema = z
  .object({
    screenshotId: z.string().min(1).max(64),
    x: z.number().finite().nonnegative(),
    y: z.number().finite().nonnegative(),
  })
  .strict()

const mouseButton = z.enum(['left', 'right', 'middle'])
/** One menu title as shown, e.g. `View` or `Command Palette...`. */
export const menuTitle = z
  .string()
  .min(1)
  .max(200)
  .refine((title) => title.trim().length > 0, 'menu title is empty')
const clickCount = z.union([z.literal(1), z.literal(2)])

export const uiActionSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('click'),
      ref: elementRefSchema,
      button: mouseButton.optional(),
      count: clickCount.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('clickPoint'),
      point: pointRefSchema,
      button: mouseButton.optional(),
      count: clickCount.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('fill'),
      ref: elementRefSchema,
      text: z.string().max(MAX_TEXT_INPUT),
    })
    .strict(),
  z
    .object({
      kind: z.literal('appendText'),
      ref: elementRefSchema,
      text: z.string().min(1).max(MAX_TEXT_INPUT),
    })
    .strict(),
  z
    .object({
      kind: z.literal('typeText'),
      text: z.string().min(1).max(2_000),
      ref: elementRefSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('press'),
      key: z.string().min(1).max(64),
      ref: elementRefSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('select'),
      ref: elementRefSchema,
      option: z.string().min(1).max(500),
    })
    .strict(),
  z
    .object({
      kind: z.literal('scroll'),
      ref: elementRefSchema.optional(),
      direction: z.enum(['up', 'down', 'left', 'right']),
      amount: z.number().int().min(1).max(20),
      unit: z.enum(['page', 'line']),
    })
    .strict(),
  z
    .object({
      kind: z.literal('drag'),
      from: z.union([elementRefSchema, pointRefSchema]),
      to: z.union([elementRefSchema, pointRefSchema]),
    })
    .strict(),
  z
    .object({
      kind: z.literal('secondary'),
      ref: elementRefSchema,
      action: z.string().min(1).max(64),
    })
    .strict(),
  z
    .object({
      kind: z.literal('navigate'),
      url: z.string().min(1).max(MAX_URL_LENGTH),
    })
    .strict(),
  z
    .object({
      kind: z.literal('history'),
      direction: z.enum(['back', 'forward', 'reload']),
    })
    .strict(),
  z
    .object({
      kind: z.literal('menu'),
      path: z.array(menuTitle).min(1).max(4),
    })
    .strict(),
  z.object({ kind: z.literal('activate') }).strict(),
])

export const waitConditionSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('navigation'),
      urlMatches: z.string().min(1).max(MAX_URL_LENGTH).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('element'),
      role: z.enum(UI_ROLES as [UiRole, ...UiRole[]]).optional(),
      name: z.string().min(1).max(200).optional(),
      state: z.enum(['present', 'absent', 'enabled']),
    })
    .strict(),
  z
    .object({ kind: z.literal('text'), contains: z.string().min(1).max(200) })
    .strict(),
  z
    .object({
      kind: z.literal('idle'),
      quietMs: z.number().int().min(100).max(10_000),
    })
    .strict(),
  z
    .object({
      kind: z.literal('window'),
      title: z.string().min(1).max(200).optional(),
      state: z.enum(['present', 'absent']),
    })
    .strict(),
])

export const observeBudgetSchema = z
  .object({
    maxElements: z.number().int().min(1).max(1_000),
    maxTextBytes: z
      .number()
      .int()
      .min(0)
      .max(64 * 1024),
    maxDepth: z.number().int().min(1).max(32),
    timeoutMs: z.number().int().min(100).max(10_000),
  })
  .strict()

export const observeQuerySchema = z
  .object({
    role: z.string().min(1).max(32).optional(),
    nameContains: z.string().min(1).max(200).optional(),
    frameId: z.string().min(1).max(128).optional(),
    visibleOnly: z.boolean().optional(),
  })
  .strict()

/** Default observation budget (§5.4). */
export const DEFAULT_OBSERVE_BUDGET = {
  maxElements: 200,
  maxTextBytes: 16 * 1024,
  maxDepth: 8,
  timeoutMs: 3_000,
} as const
