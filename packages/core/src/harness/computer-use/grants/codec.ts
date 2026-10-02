/**
 * `~/.emperor/computer-use/grants.json` codec (schemaVersion 1). Only
 * `session` and `timed` grants are persisted; `once` and `task` grants live
 * in memory. Any entry that fails validation is dropped, never widened.
 *
 * `suspended` (the retired emergency stop and the corrupt-store stop,
 * 2026-10-01) is read without validation and written back once without it.
 */

import { z } from 'zod'
import type { SnapshotCodec } from '../../../store/persistence'
import { UI_ACTION_CLASSES, type UiActionClass, type UiGrant } from '../types'

export const GRANTS_SCHEMA_VERSION = 1

export interface GrantsDocument {
  readonly grants: readonly UiGrant[]
}

const iso = z.string().datetime({ offset: true })

const targetScopeSchema = z.union([
  z
    .object({
      kind: z.literal('browser'),
      profileId: z.string().min(1).max(128),
      origins: z.array(z.string().min(1).max(512)).min(1).max(32),
    })
    .strict(),
  z
    .object({
      kind: z.literal('desktop'),
      appId: z.string().min(1).max(512),
      windowRef: z.string().min(1).max(256).optional(),
    })
    .strict(),
])

export const grantSchema = z
  .object({
    grantId: z.string().min(1).max(128),
    subject: z.string().min(1).max(256),
    ownerSessionId: z.string().min(1).max(256).optional(),
    driver: z.enum(['embedded-browser', 'external-browser', 'desktop']),
    targetScope: targetScopeSchema,
    allowedActions: z
      .array(z.enum(UI_ACTION_CLASSES as [UiActionClass, ...UiActionClass[]]))
      .min(1),
    scope: z.enum(['once', 'task', 'session', 'timed']),
    createdAt: iso,
    expiresAt: iso.optional(),
    taskId: z.string().min(1).max(512).optional(),
    callId: z.string().min(1).max(256).optional(),
    backgroundAllowed: z.boolean(),
    delegatedFrom: z
      .object({
        grantId: z.string().min(1).max(128),
        revision: z.number().int().positive(),
      })
      .strict()
      .optional(),
    revision: z.number().int().positive(),
  })
  .strict()

const documentSchema = z
  .object({
    schemaVersion: z.literal(GRANTS_SCHEMA_VERSION),
    grants: z.array(z.unknown()),
    /** Retired: read once, never validated, never written. */
    suspended: z.unknown().optional(),
  })
  .strict()

export const GRANTS_CODEC: SnapshotCodec<GrantsDocument> = {
  schemaVersion: GRANTS_SCHEMA_VERSION,
  encode(value) {
    return {
      schemaVersion: GRANTS_SCHEMA_VERSION,
      grants: value.grants.filter(
        (grant) => grant.scope === 'session' || grant.scope === 'timed',
      ),
    }
  },
  decode(input) {
    const document = documentSchema.parse(input)
    const grants: UiGrant[] = []
    for (const raw of document.grants) {
      const parsed = grantSchema.safeParse(raw)
      if (
        parsed.success &&
        (parsed.data.scope === 'session' || parsed.data.scope === 'timed')
      )
        grants.push(parsed.data)
    }
    return {
      value: { grants },
      schemaVersion: GRANTS_SCHEMA_VERSION,
      ...(document.suspended === undefined ? {} : { migrated: true }),
    }
  },
}
