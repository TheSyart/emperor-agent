/**
 * `edit` tool (ported from dsh-tool-fs edit.ts + the dsh-fs-local edit
 * critical section): literal old_string → new_string replacement, unique
 * match unless `replace_all`. Requires a prior observation by this session
 * and fails stale when the file changed since.
 */

import { z } from 'zod'
import { escalationFields } from '../../../sandbox/escalation'
import { defineTool, type ToolDefinition } from '../../definition'
import { unifiedDiff } from './diff'
import {
  applyLiteralEdit,
  FsError,
  probe,
  readForEdit,
  resolveTarget,
  restoreLineEndings,
  writeFileAtomic,
} from './fsio'
import {
  fenceTarget,
  remediate,
  resolveMutationPolicy,
  sessionIdOf,
  type FsToolState,
} from './shared'

export function formatEditOutput(
  displayPath: string,
  replaceAll: boolean,
): string {
  return replaceAll
    ? `The file ${displayPath} has been updated. All occurrences were successfully replaced.`
    : `The file ${displayPath} has been updated successfully.`
}

/** Validate what the schema cannot express. */
export function parseEditArgs(args: {
  file_path: string
  old_string: string
  new_string: string
  replace_all?: boolean | undefined
}): {
  filePath: string
  oldString: string
  newString: string
  replaceAll: boolean
} {
  if (args.file_path.trim().length === 0)
    throw new Error('file_path must be a non-empty string')
  if (args.old_string.length === 0)
    throw new Error('old_string must be a non-empty string')
  if (args.old_string === args.new_string)
    throw new Error('old_string and new_string must differ')
  return {
    filePath: args.file_path,
    oldString: args.old_string,
    newString: args.new_string,
    replaceAll: args.replace_all ?? false,
  }
}

const editInput = z.object({
  file_path: z
    .string()
    .describe(
      'Path to edit: absolute, or relative to the session working directory.',
    ),
  old_string: z
    .string()
    .describe('Literal text to replace. Must match exactly.'),
  new_string: z
    .string()
    .describe(
      'Literal replacement text. Use an empty string to delete the match.',
    ),
  replace_all: z
    .boolean()
    .optional()
    .describe(
      'Replace all matches. Defaults to false; when false, old_string must appear exactly once.',
    ),
  ...escalationFields,
})

export type EditArgs = z.output<typeof editInput>

export function createEditTool(state: FsToolState): ToolDefinition<EditArgs> {
  return defineTool({
    name: 'edit',
    description: 'Edit an existing UTF-8 text file by replacing literal text.',
    input: editInput,
    async execute(args, context) {
      const input = parseEditArgs(args)
      const policy = await resolveMutationPolicy(state, 'edit', args, context)
      const resolved = await resolveTarget(policy.workspaceRoot, input.filePath)
      const sessionId = sessionIdOf(context)
      try {
        const expected = state.observations.editIntent(sessionId, resolved)
        const target = await fenceTarget(resolved, policy, 'edit')
        const outcome = await state.locks.with(target.targetKey, async () => {
          const existing = await probe(target.targetKey)
          // Stale before matching: an edit based on an old read never reports
          // not-found/ambiguous against newer content.
          if (existing === null)
            throw new FsError(
              `cannot edit "${target.displayPath}": file changed since it was read`,
              'FS_STALE_VERSION',
            )
          if (existing.type !== 'file')
            throw new FsError(
              `cannot edit "${target.displayPath}": not a regular file`,
              'FS_NOT_REGULAR_FILE',
            )
          if (existing.version !== expected.version) {
            throw new FsError(
              `cannot edit "${target.displayPath}": file changed since it was read`,
              'FS_STALE_VERSION',
            )
          }
          const original = await readForEdit(target, context.signal)
          const edited = applyLiteralEdit(
            original.content,
            input.oldString,
            input.newString,
            input.replaceAll,
            target.displayPath,
          )
          await writeFileAtomic(
            target.targetKey,
            restoreLineEndings(edited.content, original.lineEndings),
            existing.mode,
            context.signal,
            { stagingRoot: state.services.writeStagingRoot },
          )
          const after = await probe(target.targetKey)
          return {
            version: after?.version ?? `missing:${target.targetKey}`,
            before: original.content,
            after: edited.content,
            replacements: edited.replacements,
          }
        })
        state.observations.observe(sessionId, target, {
          kind: 'present',
          version: outcome.version,
        })
        return {
          content: formatEditOutput(target.displayPath, input.replaceAll),
          meta: {
            path: target.displayPath,
            kind: 'edit',
            replacements: outcome.replacements,
            ...unifiedDiff(target.displayPath, outcome.before, outcome.after),
          },
        }
      } catch (error: unknown) {
        throw remediate(error)
      }
    },
  })
}
