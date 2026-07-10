import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  appendSectionItem,
  canonicalSections,
  replaceSection,
  sectionBody,
  type MemoryMarkdownKind,
} from './markdown-schema'
import { MemoryVersionStore, type MemoryVersionTarget } from './versions'

export type MemoryScope =
  | { kind: 'user_profile' }
  | { kind: 'global' }
  | { kind: 'project'; projectId: string }
  | { kind: 'episode'; date: string }
  | { kind: 'session'; sessionId: string }

export type MemoryPatchOperation =
  | { op: 'append_section_item'; section: string; item: string }
  | { op: 'replace_section'; section: string; content: string }
  | { op: 'mark_deprecated'; itemId: string; reason: string }
  | { op: 'update_item'; itemId: string; content: string }

export interface MemoryPatch {
  target: MemoryScope
  baseVersion: number
  baseHash: string
  operations: MemoryPatchOperation[]
  rationale: string
}

export interface MemoryPatchApplyOptions {
  mode?: 'chat' | 'build'
  allowBuildGlobalWrite?: boolean
  explicitReplace?: boolean
  currentVersion?: number
}

export interface MemoryPatchApplyResult {
  ok: boolean
  content: string
  errors: string[]
  appliedOperations: number
}

export interface MemoryPatchFileApplyOptions extends MemoryPatchApplyOptions {
  targetPath: string
  versions: MemoryVersionStore
  versionTarget?: MemoryVersionTarget | null
  ledgerPath?: string | null
}

const SECRET_PATTERNS = [
  /\bapi[_-]?key\s*[:=]\s*[A-Za-z0-9_.:/+=-]{8,}/i,
  /\b(?:sk|ak)-[A-Za-z0-9_-]{12,}\b/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
]

const PROMPT_INJECTION_PATTERNS = [
  /ignore (?:all )?(?:previous|above) instructions/i,
  /disregard (?:all )?(?:previous|above) instructions/i,
  /reveal (?:the )?(?:system prompt|secrets?)/i,
]

export function memoryContentHash(content: string): string {
  return createHash('sha256')
    .update(String(content ?? ''), 'utf8')
    .digest('hex')
}

export function applyMemoryPatch(
  patch: MemoryPatch,
  currentContent: string,
  opts: MemoryPatchApplyOptions = {},
): MemoryPatchApplyResult {
  const current = String(currentContent ?? '')
  const errors = validateMemoryPatch(patch, current, opts)
  if (errors.length)
    return { ok: false, content: current, errors, appliedOperations: 0 }

  let next = current
  let appliedOperations = 0
  for (const op of patch.operations) {
    if (op.op === 'append_section_item') {
      if (sectionContainsItem(next, op.section, op.item)) continue
      next = appendSectionItem(next, op.section, op.item)
      appliedOperations += 1
    } else if (op.op === 'replace_section') {
      next = replaceSection(next, op.section, op.content)
      appliedOperations += 1
    } else if (op.op === 'mark_deprecated') {
      next = appendSectionItem(
        next,
        'Deprecated',
        `- id: ${op.itemId}\n  reason: ${op.reason}`,
      )
      appliedOperations += 1
    } else if (op.op === 'update_item') {
      next = updateItemText(next, op.itemId, op.content)
      appliedOperations += 1
    }
  }
  return { ok: true, content: next, errors: [], appliedOperations }
}

export function applyMemoryPatchToFile(
  patch: MemoryPatch,
  opts: MemoryPatchFileApplyOptions,
): MemoryPatchApplyResult {
  const current = existsSync(opts.targetPath)
    ? readFileSync(opts.targetPath, 'utf8')
    : ''
  const currentVersion = opts.versions.nextVersionForPath(opts.targetPath, {
    target: opts.versionTarget ?? undefined,
  })
  const result = applyMemoryPatch(patch, current, { ...opts, currentVersion })
  if (!result.ok) return result

  opts.versions.snapshotPath(opts.targetPath, {
    target: opts.versionTarget ?? null,
    reason: `memory_patch:${patch.rationale || 'patch'}`,
  })
  MemoryVersionStore.atomicWriteText(opts.targetPath, result.content)
  if (opts.ledgerPath)
    appendPatchLedger(opts.ledgerPath, patch, current, result)
  return result
}

export function validateMemoryPatch(
  patch: MemoryPatch,
  currentContent: string,
  opts: MemoryPatchApplyOptions = {},
): string[] {
  const errors: string[] = []
  if (patch.baseHash !== memoryContentHash(currentContent))
    errors.push('base_hash_mismatch')
  if (
    typeof opts.currentVersion === 'number' &&
    patch.baseVersion !== opts.currentVersion
  ) {
    errors.push('base_version_mismatch')
  }
  if (
    opts.mode === 'build' &&
    patch.target.kind === 'global' &&
    !opts.allowBuildGlobalWrite
  ) {
    errors.push('build_global_write_not_allowed')
  }

  const schemaKind = schemaKindForScope(patch.target)
  for (const op of patch.operations) {
    const text = operationText(op)
    if (containsSecret(text)) errors.push('suspected_secret')
    if (containsPromptInjection(text)) errors.push('prompt_injection_text')
    if (
      'section' in op &&
      schemaKind &&
      !canonicalSections(schemaKind).includes(op.section)
    ) {
      errors.push(`forbidden_section:${op.section}`)
    }
    if (
      patch.target.kind === 'user_profile' &&
      op.op === 'replace_section' &&
      !opts.explicitReplace &&
      deletesMoreThanFortyPercent(
        sectionBody(currentContent, op.section),
        op.content,
      )
    ) {
      errors.push('destructive_profile_replacement')
    }
  }

  return unique(errors)
}

function schemaKindForScope(scope: MemoryScope): MemoryMarkdownKind | null {
  if (scope.kind === 'user_profile') return 'user_profile'
  if (scope.kind === 'global') return 'global'
  if (scope.kind === 'project') return 'project'
  if (scope.kind === 'episode') return 'episode'
  return null
}

function operationText(op: MemoryPatchOperation): string {
  if (op.op === 'append_section_item') return op.item
  if (op.op === 'replace_section') return op.content
  if (op.op === 'mark_deprecated') return `${op.itemId}\n${op.reason}`
  return `${op.itemId}\n${op.content}`
}

function sectionContainsItem(
  markdown: string,
  section: string,
  item: string,
): boolean {
  const needle = normalizeMemoryItem(item)
  if (!needle) return false
  return sectionBody(markdown, section)
    .split('\n')
    .some((line) => normalizeMemoryItem(line) === needle)
}

function normalizeMemoryItem(value: string): string {
  return String(value ?? '')
    .trim()
    .replace(/^\s*[-*]\s+/, '')
    .replace(/\s+/g, ' ')
    .toLowerCase()
}

function containsSecret(text: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(text))
}

function containsPromptInjection(text: string): boolean {
  return PROMPT_INJECTION_PATTERNS.some((pattern) => pattern.test(text))
}

function deletesMoreThanFortyPercent(before: string, after: string): boolean {
  const beforeLines = nonEmptyLineCount(before)
  if (beforeLines === 0) return false
  const afterLines = nonEmptyLineCount(after)
  return afterLines < beforeLines * 0.6
}

function nonEmptyLineCount(text: string): number {
  return String(text ?? '')
    .split('\n')
    .filter((line) => line.trim()).length
}

function updateItemText(
  markdown: string,
  itemId: string,
  content: string,
): string {
  const lines = String(markdown ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n')
  const index = lines.findIndex((line) => line.includes(itemId))
  if (index < 0)
    return appendSectionItem(
      markdown,
      'Deprecated',
      String(content ?? '').trimEnd(),
    )
  lines[index] = String(content ?? '').trimEnd()
  return `${lines.join('\n').replace(/\s+$/, '')}\n`
}

export function appendPatchLedger(
  path: string,
  patch: MemoryPatch,
  before: string,
  result: MemoryPatchApplyResult,
): void {
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(
    path,
    JSON.stringify({
      ts: new Date().toISOString(),
      event: 'memory_patch_applied',
      target: patch.target,
      operationCount: result.appliedOperations,
      rationale: patch.rationale,
      baseHash: memoryContentHash(before),
      newHash: memoryContentHash(result.content),
    }) + '\n',
    'utf8',
  )
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}
