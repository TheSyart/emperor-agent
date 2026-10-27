import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** The persona when the shipped `templates/agent/persona.md` is missing. */
export const FALLBACK_PERSONA =
  'You are Emperor Agent, a coding agent. The runtime context names the model you run on and your working directory.'

/**
 * Emperor's persona: the first prompt section of every session, and the
 * role card of the builtin Emperor contact (GRP-02).
 */
export function readPersonaText(templatesDir: string): string {
  const path = join(templatesDir, 'agent', 'persona.md')
  if (existsSync(path)) return readFileSync(path, 'utf8').trim()
  return FALLBACK_PERSONA
}
