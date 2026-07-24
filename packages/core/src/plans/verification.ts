/**
 * Plan 验证模型 (MIG-CTRL-008/013)。对齐 Python `agent/plans/verification.py`。
 * VerificationRequirement / Command / Result + requirements_for_step + 证据应用。
 */
import { nowTs } from '../util/time'

const TOOL_ERROR_HINT =
  '[Analyze the error above and try a different approach.]'
const VALID_REQUIREMENT_STATUSES = new Set([
  'pending',
  'passed',
  'failed',
  'skipped',
])

export interface VerificationRequirement {
  id: string
  kind: string
  required: boolean
  humanRequired?: boolean
  command: string
  description: string
  status: string
  evidenceRefs: string[]
  reason: string
}

export function makeRequirement(
  p: Partial<VerificationRequirement> & { id: string },
): VerificationRequirement {
  return {
    id: p.id,
    kind: p.kind ?? 'command',
    required: p.required ?? true,
    humanRequired: p.humanRequired ?? false,
    command: p.command ?? '',
    description: p.description ?? '',
    status: p.status ?? 'pending',
    evidenceRefs: p.evidenceRefs ?? [],
    reason: p.reason ?? '',
  }
}

export function requirementToDict(
  r: VerificationRequirement,
): Record<string, unknown> {
  return {
    id: r.id,
    kind: r.kind,
    required: r.required,
    human_required: Boolean(r.humanRequired),
    command: r.command,
    description: r.description,
    status: r.status,
    evidence_refs: r.evidenceRefs,
    reason: r.reason,
  }
}

export function requirementFromDict(
  raw: Record<string, unknown>,
): VerificationRequirement {
  let status = String(raw.status ?? 'pending').trim()
  if (!VALID_REQUIREMENT_STATUSES.has(status)) status = 'pending'
  const kind = String(raw.kind ?? 'command').trim() || 'command'
  const humanRequired = Boolean(
    raw.human_required ?? raw.humanRequired ?? false,
  )
  const requestedRequired =
    raw.required === undefined ? true : Boolean(raw.required)
  return {
    id: String(raw.id ?? raw.requirement_id ?? '').trim(),
    kind,
    required:
      kind === 'manual'
        ? requestedRequired && humanRequired
        : requestedRequired,
    humanRequired,
    command: String(raw.command ?? '').trim(),
    description: String(raw.description ?? '').trim(),
    status,
    evidenceRefs: asStringList(raw.evidence_refs ?? raw.evidenceRefs),
    reason: String(raw.reason ?? '').trim(),
  }
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map((v) => String(v))
}

/** step 的 verification list（含 dict / VerificationRequirement），dict 转模型。 */
function explicitRequirements(step: PlanStepLike): VerificationRequirement[] {
  const items = step.verification ?? []
  const out: VerificationRequirement[] = []
  for (const item of items) {
    if (
      item &&
      typeof item === 'object' &&
      'id' in item &&
      'kind' in item &&
      'evidenceRefs' in item
    ) {
      out.push(item as VerificationRequirement)
    } else if (item && typeof item === 'object') {
      out.push(requirementFromDict(item as Record<string, unknown>))
    }
  }
  return out
}

interface PlanStepLike {
  verification?: Array<VerificationRequirement | Record<string, unknown>>
  commands?: string[]
  evidence?: Array<Record<string, unknown>>
}

export function requirementsForStep(
  step: PlanStepLike,
): VerificationRequirement[] {
  const explicit = explicitRequirements(step)
  const commands = (step.commands ?? [])
    .map((c) => String(c))
    .filter((c) => c.trim())
  const existingCommands = new Set(
    explicit.filter((r) => r.command).map((r) => normalizeCommand(r.command)),
  )
  const legacy: VerificationRequirement[] = []
  commands.forEach((command, index) => {
    if (!existingCommands.has(normalizeCommand(command))) {
      legacy.push(
        makeRequirement({
          id: `cmd_${index + 1}`,
          kind: 'command',
          required: true,
          command,
          description: `Run \`${command}\``,
        }),
      )
    }
  })
  const evidence = (step.evidence ?? []).filter(
    (e) => e && typeof e === 'object',
  )
  return [...explicit, ...legacy].map((requirement) =>
    applyEvidence(requirement, evidence),
  )
}

function applyEvidence(
  requirement: VerificationRequirement,
  evidence: Array<Record<string, unknown>>,
): VerificationRequirement {
  if (
    requirement.status === 'passed' ||
    requirement.status === 'failed' ||
    requirement.status === 'skipped'
  ) {
    return requirement
  }
  const matched = matchingEvidence(requirement, evidence)
  if (matched === null) return requirement
  const passed = matched.passed
  if (matched.waived === true) {
    return {
      ...requirement,
      status: 'skipped',
      evidenceRefs: evidenceRefs(matched),
      reason: String(
        matched.reason ?? 'user explicitly waived verification',
      ).trim(),
    }
  }
  if (passed === true) {
    return {
      ...requirement,
      status: 'passed',
      evidenceRefs: evidenceRefs(matched),
    }
  }
  if (passed === false) {
    return {
      ...requirement,
      status: 'failed',
      evidenceRefs: evidenceRefs(matched),
      reason: String(
        matched.summary ?? matched.error ?? requirement.reason,
      ).trim(),
    }
  }
  return requirement
}

function matchingEvidence(
  requirement: VerificationRequirement,
  evidence: Array<Record<string, unknown>>,
): Record<string, unknown> | null {
  for (let i = evidence.length - 1; i >= 0; i--) {
    const item = evidence[i]!
    const reqId = String(
      item.requirement_id ?? item.verification_id ?? '',
    ).trim()
    if (reqId && reqId === requirement.id) return item
    if (requirement.kind === 'command' && requirement.command) {
      if (
        normalizeCommand(String(item.command ?? '')) ===
        normalizeCommand(requirement.command)
      )
        return item
    }
  }
  return null
}

function evidenceRefs(evidence: Record<string, unknown>): string[] {
  const refs: string[] = []
  for (const key of ['tool_call_id', 'task_id', 'path', 'command']) {
    const value = String(evidence[key] ?? '').trim()
    if (value) refs.push(key !== 'command' ? `${key}:${value}` : value)
  }
  return refs
}

function normalizeCommand(command: string): string {
  return String(command ?? '')
}

// ── VerificationCommand / Result ──

export interface VerificationCommand {
  command: string
  cwd: string | null
  timeoutSeconds: number
}

export interface VerificationResult {
  command: string
  exitCode: number
  passed: boolean
  summary: string
  stdoutTail: string
  stderrTail: string
  checkedAt: number
}

export function resultFromCompleted(
  command: VerificationCommand,
  opts: { exitCode: number; stdout: string; stderr: string },
): VerificationResult {
  const output = (
    opts.stdout ||
    opts.stderr ||
    `exit_code=${opts.exitCode}`
  ).trim()
  const lines = output ? output.split('\n') : []
  const summary = output
    ? lines[lines.length - 1]!.slice(0, 500)
    : `exit_code=${opts.exitCode}`
  return {
    command: command.command,
    exitCode: opts.exitCode,
    passed: opts.exitCode === 0,
    summary,
    stdoutTail: opts.stdout.slice(-4000),
    stderrTail: opts.stderr.slice(-4000),
    checkedAt: nowTs(),
  }
}

export function resultFromToolOutput(
  command: VerificationCommand,
  content: string,
): VerificationResult {
  const text = stripToolErrorHint(String(content ?? '').trim())
  const failed =
    /^Error: command exited with code (\d+)\n?([\s\S]*)$/.exec(text) ??
    /^Error \(exit (\d+)\):\n?([\s\S]*)$/.exec(text)
  if (failed) {
    return resultFromCompleted(command, {
      exitCode: Number.parseInt(failed[1]!, 10),
      stdout: '',
      stderr: failed[2]!.trim(),
    })
  }
  if (text.startsWith('Error: command timed out')) {
    return resultFromCompleted(command, {
      exitCode: 124,
      stdout: '',
      stderr: text,
    })
  }
  if (text.startsWith('Error:')) {
    return resultFromCompleted(command, {
      exitCode: 1,
      stdout: '',
      stderr: text,
    })
  }
  return resultFromCompleted(command, { exitCode: 0, stdout: text, stderr: '' })
}

function stripToolErrorHint(text: string): string {
  const lines = text.split('\n')
  if (lines.length && lines[lines.length - 1]!.trim() === TOOL_ERROR_HINT) {
    return lines.slice(0, -1).join('\n').trim()
  }
  return text
}

export interface VerificationReviewRequest {
  planId: string
  changedFiles: string[]
  commands: string[]
  riskSignals: string[]
  createdAt: number
  reason: string
}
