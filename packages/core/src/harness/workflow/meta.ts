/**
 * Meta validation (ported from dsh-workflow-worker-thread `meta.ts`): checks
 * caller-provided DATA against the {@link WorkflowMeta} contract and rejects
 * every violation by name. Meta is never evaluated script text.
 */

import { WorkflowError } from './errors'
import type { WorkflowMeta, WorkflowPhase } from './types'

const META_KEYS = new Set(['name', 'description', 'whenToUse', 'phases'])
const PHASE_KEYS = new Set(['title', 'detail', 'provider', 'model'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validateMetaShape(meta: unknown): {
  meta?: WorkflowMeta
  violations: string[]
} {
  const violations: string[] = []
  if (!isRecord(meta)) return { violations: ['meta must be an object'] }
  for (const key of Object.keys(meta)) {
    if (!META_KEYS.has(key))
      violations.push(
        `meta.${key} is not a recognized field (name/description/whenToUse/phases)`,
      )
  }
  if (typeof meta.name !== 'string' || meta.name.length === 0)
    violations.push('meta.name must be a non-empty string')
  if (typeof meta.description !== 'string' || meta.description.length === 0)
    violations.push('meta.description must be a non-empty string')
  if (meta.whenToUse !== undefined && typeof meta.whenToUse !== 'string')
    violations.push('meta.whenToUse must be a string')
  const phases: WorkflowPhase[] = []
  if (meta.phases !== undefined) {
    if (!Array.isArray(meta.phases)) {
      violations.push('meta.phases must be an array')
    } else {
      meta.phases.forEach((phase: unknown, index) => {
        if (!isRecord(phase)) {
          violations.push(`meta.phases[${index}] must be an object`)
          return
        }
        for (const key of Object.keys(phase)) {
          if (!PHASE_KEYS.has(key))
            violations.push(
              `meta.phases[${index}].${key} is not a recognized field`,
            )
        }
        if (typeof phase.title !== 'string' || phase.title.length === 0)
          violations.push(
            `meta.phases[${index}].title must be a non-empty string`,
          )
        for (const key of ['detail', 'provider', 'model'] as const) {
          if (phase[key] !== undefined && typeof phase[key] !== 'string')
            violations.push(`meta.phases[${index}].${key} must be a string`)
        }
        if (violations.length === 0) {
          phases.push({
            title: phase.title as string,
            ...(phase.detail === undefined
              ? {}
              : { detail: phase.detail as string }),
            ...(phase.provider === undefined
              ? {}
              : { provider: phase.provider as string }),
            ...(phase.model === undefined
              ? {}
              : { model: phase.model as string }),
          })
        }
      })
    }
  }
  if (violations.length > 0) return { violations }
  return {
    violations,
    meta: {
      name: meta.name as string,
      description: meta.description as string,
      ...(meta.whenToUse === undefined
        ? {}
        : { whenToUse: meta.whenToUse as string }),
      ...(meta.phases === undefined ? {} : { phases }),
    },
  }
}

/**
 * Validate a caller-provided meta value. Throws `META_INVALID` naming every
 * violation; returns a NORMALIZED copy (never aliases the caller's object).
 */
export function validateMeta(value: unknown): WorkflowMeta {
  const { meta, violations } = validateMetaShape(value)
  if (meta === undefined)
    throw new WorkflowError(
      `invalid meta: ${violations.join('; ')}`,
      'META_INVALID',
    )
  return meta
}
