/**
 * `skill_manage`: model-facing management of Emperor Skills.
 *
 * - `list` / `validate` are read-only.
 * - `create` / `update` / `delete` / `import` write the personal Skills
 *   folder (`~/.emperor/skills`) or, in Build sessions, the project Skills
 *   folder (`<project>/.emperor/skills`). Unless the calling agent runs
 *   under `danger-full-access`, each write asks the user first through the
 *   approval service (the same permission card as sandbox escalation);
 *   a denied approval is a tool error.
 * - Builtin and Plugin Skills are read-only.
 */

import { homedir } from 'node:os'
import { z } from 'zod'
import { SkillError } from '../../../skills/errors'
import type { InvalidSkill, ResolvedSkill } from '../../../skills/file-loader'
import type { SkillImportSource } from '../../../skills/import'
import type { SkillLibrary, SkillScope } from '../../../skills/library'
import { checkSkillContent, checkSkillFolder } from '../../../skills/validate'
import type { Agent } from '../../agent/agent'
import type { ApprovalService } from '../../approval/service'
import type { SystemPromptAssembler } from '../../prompt/assembler'
import type { SandboxPolicyService } from '../../sandbox/policy'
import { defineTool, ToolError, type ToolDefinition } from '../definition'

export interface SkillManageToolDeps {
  library: SkillLibrary
  sandbox: SandboxPolicyService
  approval: ApprovalService | undefined
  /** Project root of the calling agent's Build session (null for chat). */
  projectRootOf(agent: Agent | undefined): string | null
}

const DESCRIPTION =
  'Manage Emperor Skills. Read-only: list (Skills available in this session, plus invalid ones with reasons), validate (check SKILL.md text or an installed Skill). ' +
  'Writes: create / update (full SKILL.md in `content`, optional extra files in `files`), delete, import (from a local folder, a local .zip, pasted SKILL.md, or an https link — GitHub repository/folder links or direct .zip links). ' +
  'Writes need user approval unless the session runs with full access. Built-in and Plugin Skills are read-only. ' +
  'Use this tool instead of file or shell tools for anything under the Skills folders.'

const sourceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('folder'),
    path: z.string().min(1).describe('Absolute path of a local folder.'),
  }),
  z.object({
    kind: z.literal('zip'),
    path: z.string().min(1).describe('Absolute path of a local .zip file.'),
  }),
  z.object({
    kind: z.literal('url'),
    url: z
      .string()
      .min(1)
      .describe(
        'https link: https://github.com/<owner>/<repo>[/tree/<ref>/<folder>] or a direct .zip link.',
      ),
  }),
  z.object({
    kind: z.literal('content'),
    content: z.string().min(1).describe('Full SKILL.md text.'),
    name: z
      .string()
      .optional()
      .describe('Skill name; overrides the frontmatter name.'),
  }),
])

const skillManageInput = z.object({
  action: z
    .enum(['list', 'validate', 'create', 'update', 'delete', 'import'])
    .describe('What to do.'),
  name: z
    .string()
    .optional()
    .describe(
      'Skill name (lowercase letters, digits, ".", "_", "-"). Required for delete; for create/update it must equal the frontmatter name.',
    ),
  content: z
    .string()
    .optional()
    .describe(
      'Full SKILL.md text starting with YAML frontmatter (`name`, `description`). Required for create/update; optional for validate.',
    ),
  files: z
    .record(z.string(), z.string())
    .optional()
    .describe(
      'Extra text files for create/update, keyed by path relative to the Skill folder, e.g. {"scripts/run.py": "..."}.',
    ),
  scope: z
    .enum(['user', 'project'])
    .optional()
    .describe(
      'user (default) = personal Skills; project = this Build project (Build sessions only).',
    ),
  source: sourceSchema
    .optional()
    .describe('import only: where the Skill comes from.'),
  overwrite: z
    .boolean()
    .optional()
    .describe('import only: replace existing Skills with the same name.'),
})

type SkillManageArgs = z.output<typeof skillManageInput>

/** `~/…` display form of a path under the home folder. */
export function skillDisplayPath(path: string): string {
  const home = homedir()
  return path === home || path.startsWith(`${home}/`)
    ? `~${path.slice(home.length)}`
    : path
}

export function createSkillManageTool(
  deps: SkillManageToolDeps,
): ToolDefinition<SkillManageArgs> {
  const { library } = deps

  const authorize = async (
    context: { agent?: Agent; callId: string; signal: AbortSignal },
    reason: string,
  ): Promise<void> => {
    const mode = deps.sandbox.resolve(
      context.agent === undefined ? {} : { session: context.agent.session },
    ).mode
    if (mode === 'danger-full-access') return
    if (deps.approval === undefined || context.agent === undefined)
      throw new ToolError(
        `changing Skills requires approval under ${mode}, but no approval channel is available`,
        'APPROVAL_UNAVAILABLE',
      )
    const outcome = await deps.approval.request({
      agent: context.agent,
      toolName: 'skill_manage',
      callId: context.callId,
      reason,
      signal: context.signal,
    })
    switch (outcome) {
      case 'allowed-once':
        return
      case 'rejected':
        throw new ToolError(
          'the user rejected this Skill change',
          'APPROVAL_REJECTED',
        )
      case 'cancelled':
        throw new ToolError(
          'approval for this Skill change was cancelled',
          'APPROVAL_CANCELLED',
        )
      case 'unavailable':
        throw new ToolError(
          'changing Skills requires approval, but no approval channel is available',
          'APPROVAL_UNAVAILABLE',
        )
    }
  }

  return defineTool({
    name: 'skill_manage',
    description: DESCRIPTION,
    input: skillManageInput,
    isConcurrencySafe: (args) =>
      args.action === 'list' || args.action === 'validate',
    timeoutMs: 10 * 60_000,
    async execute(args, context) {
      const projectRoot = deps.projectRootOf(context.agent)
      const scope: SkillScope = args.scope ?? 'user'
      try {
        switch (args.action) {
          case 'list':
            return listResult(library.list(projectRoot))
          case 'validate':
            return validateResult(library, projectRoot, args)
          case 'create':
          case 'update': {
            const content = requireString(args.content, 'content', args.action)
            const check = checkSkillContent(content)
            if (check.errors.length)
              throw new ToolError(
                `SKILL.md is invalid: ${check.errors.join('; ')}`,
              )
            if (args.name && args.name.trim() !== check.name)
              throw new ToolError(
                `frontmatter name "${check.name}" does not match name "${args.name}"`,
              )
            const dir = library.scopeDir(scope, projectRoot)
            const fileCount = Object.keys(args.files ?? {}).length
            await authorize(
              context,
              `${args.action} ${scope} Skill "${check.name}" in ${skillDisplayPath(dir)}/${check.name}${fileCount ? ` (+${fileCount} file${fileCount === 1 ? '' : 's'})` : ''}`,
            )
            const result = library.write(projectRoot, {
              name: check.name,
              content,
              files: args.files ?? null,
              scope,
              mode: args.action,
            })
            return {
              content: [
                `${result.created ? 'Created' : 'Updated'} ${scope} Skill "${result.name}" at ${result.path}.`,
                ...issues(result.errors, result.warnings),
              ].join('\n'),
              meta: {
                action: args.action,
                name: result.name,
                scope,
                path: result.path,
              },
            }
          }
          case 'delete': {
            const name = requireString(args.name, 'name', 'delete').trim()
            const target =
              args.scope === undefined
                ? library.require(projectRoot, name)
                : null
            if (target?.readOnly)
              throw new ToolError(
                `${target.source} Skill "${name}" is read-only and cannot be deleted`,
              )
            const where =
              target !== null
                ? target.flat
                  ? target.skillFile
                  : target.root
                : `${library.scopeDir(scope, projectRoot)}/${name}`
            await authorize(
              context,
              `delete Skill "${name}" (${skillDisplayPath(where)})`,
            )
            const result = library.delete(projectRoot, name, args.scope ?? null)
            return {
              content: `Deleted ${result.scope} Skill "${name}" (${result.path}).`,
              meta: { action: 'delete', name, scope: result.scope },
            }
          }
          case 'import': {
            if (args.source === undefined)
              throw new ToolError('import needs "source"')
            const source = args.source as SkillImportSource
            const dir = library.scopeDir(scope, projectRoot)
            await authorize(
              context,
              `import Skills from ${describeSource(source)} into ${skillDisplayPath(dir)}${args.overwrite ? ' (overwrite existing)' : ''}`,
            )
            const result = await library.import(projectRoot, {
              source,
              scope,
              overwrite: args.overwrite === true,
              signal: context.signal,
            })
            const lines = [
              ...result.imported.map(
                (skill) =>
                  `Imported ${scope} Skill "${skill.name}" at ${skill.path}${skill.replaced ? ' (replaced)' : ''}.${skill.warnings.length ? ` Warnings: ${skill.warnings.join('; ')}` : ''}`,
              ),
              ...result.errors.map(
                (error) =>
                  `Not imported ${error.name ? `"${error.name}" ` : ''}(${error.path}): ${error.reason}`,
              ),
            ]
            return {
              content: lines.join('\n') || 'Nothing was imported.',
              isError: result.imported.length === 0,
              meta: {
                action: 'import',
                imported: result.imported.map((skill) => skill.name),
                failed: result.errors.length,
              },
            }
          }
        }
      } catch (error) {
        if (error instanceof SkillError) throw new ToolError(error.message)
        throw error
      }
    },
  })
}

function listResult(scan: {
  skills: ResolvedSkill[]
  invalid: InvalidSkill[]
}): { content: string; meta: unknown } {
  const lines = [
    `Skills available in this session (${scan.skills.length}):`,
    ...scan.skills.map(
      (skill) =>
        `- ${skill.name} [${skill.source}${skill.readOnly ? ', read-only' : ''}] ${skill.flat ? skill.skillFile : skill.root} — ${oneLine(skill.description, 160)}`,
    ),
  ]
  if (scan.invalid.length)
    lines.push(
      '',
      `Invalid Skills (${scan.invalid.length}):`,
      ...scan.invalid.map(
        (skill) => `- ${skill.path} [${skill.source}]: ${skill.reason}`,
      ),
    )
  return {
    content: lines.join('\n'),
    meta: {
      skills: scan.skills.map((skill) => ({
        name: skill.name,
        source: skill.source,
        readOnly: skill.readOnly,
      })),
      invalid: scan.invalid.length,
    },
  }
}

function validateResult(
  library: SkillLibrary,
  projectRoot: string | null,
  args: SkillManageArgs,
): { content: string; meta: unknown } {
  let errors: string[]
  let warnings: string[]
  let label: string
  if (args.content !== undefined) {
    const check = checkSkillContent(args.content, {
      folderName: args.name ?? null,
    })
    errors = check.errors
    warnings = check.warnings
    label = `SKILL.md${check.name ? ` "${check.name}"` : ''}`
  } else {
    const name = requireString(args.name, 'name or content', 'validate').trim()
    const skill = library.find(projectRoot, name)
    if (skill !== null) {
      const check = skill.flat
        ? checkSkillContent(skill.content)
        : checkSkillFolder(skill.root, { folderName: null })
      errors = check.errors
      warnings = skill.flat ? check.warnings : skill.warnings
      label = `${skill.source} Skill "${name}"`
    } else {
      const invalid = library
        .list(projectRoot)
        .invalid.filter((entry) => entry.name === name)
      if (!invalid.length) throw new ToolError(`Skill not found: ${name}`)
      errors = invalid.flatMap((entry) => entry.errors)
      warnings = invalid.flatMap((entry) => entry.warnings)
      label = `Skill "${name}" (${invalid.map((entry) => entry.path).join(', ')})`
    }
  }
  return {
    content: [
      `${label}: ${errors.length ? 'invalid' : 'valid'}`,
      ...issues(errors, warnings),
    ].join('\n'),
    meta: { valid: errors.length === 0, errors, warnings },
  }
}

function issues(errors: string[], warnings: string[]): string[] {
  return [
    ...errors.map((error) => `error: ${error}`),
    ...warnings.map((warning) => `warning: ${warning}`),
  ]
}

function describeSource(source: SkillImportSource): string {
  switch (source.kind) {
    case 'folder':
      return `folder ${source.path}`
    case 'zip':
      return `zip ${source.path}`
    case 'url':
      return source.url
    case 'content':
      return 'pasted SKILL.md'
  }
}

function requireString(
  value: string | undefined,
  field: string,
  action: string,
): string {
  if (typeof value !== 'string' || !value.trim())
    throw new ToolError(`${action} needs "${field}"`)
  return value
}

function oneLine(value: string, max: number): string {
  const text = value.replace(/\s+/g, ' ').trim()
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

/** Tell the model where Skills live and that only `skill_manage` changes them. */
export function installSkillManagePromptSection(
  prompt: SystemPromptAssembler,
  opts: { userSkillsDir: string },
): () => void {
  const userDir = skillDisplayPath(opts.userSkillsDir)
  return prompt.section({
    name: 'tool:skill_manage',
    order: 107,
    text:
      `Skills live in ${userDir}/<name>/SKILL.md (personal) and, in Build sessions, <project>/.emperor/skills/<name>/SKILL.md (project). ` +
      'A Skill is a folder with SKILL.md (YAML frontmatter `name` + `description`, then instructions) and optional scripts/, references/, assets/. ' +
      'Create, update, delete, or import Skills only with the `skill_manage` tool — never with file or shell tools, and never by editing other agents’ skill folders. ' +
      'Built-in and Plugin Skills are read-only.',
  })
}
