/**
 * `write` tool (ported from dsh-tool-fs write.ts + the dsh-fs-local write
 * critical section): create or fully replace a UTF-8 text file. The
 * observation policy makes it compare-and-set — replace only if unchanged
 * since this session observed it, create only if absent when unobserved.
 */

import { z } from 'zod'
import { escalationFields } from '../../../sandbox/escalation'
import { defineTool, type ToolDefinition } from '../../definition'
import { unifiedDiff } from './diff'
import {
  FsError,
  normalizeLineEndings,
  probe,
  readTextForDiff,
  resolveTarget,
  writeFileAtomic,
} from './fsio'
import {
  fenceTarget,
  remediate,
  resolveMutationPolicy,
  sessionIdOf,
  type FsToolState,
} from './shared'

/** Exclusive byte limit on each side of the overwrite diff basis. */
const DIFF_BASIS_MAX_BYTES = 10 * 1024 * 1024

export function formatWriteOutput(
  displayPath: string,
  operation: 'create' | 'update',
): string {
  return `<path>${displayPath}</path>
<type>file</type>
<content>
${operation === 'create' ? 'Created' : 'Updated'} file
</content>`
}

const writeInput = z.object({
  file_path: z
    .string()
    .describe(
      'Path to write: absolute, or relative to the session working directory.',
    ),
  content: z.string().describe('Full UTF-8 text content to write.'),
  ...escalationFields,
})

export type WriteArgs = z.output<typeof writeInput>

export function createWriteTool(state: FsToolState): ToolDefinition<WriteArgs> {
  return defineTool({
    name: 'write',
    description: 'Create or fully replace a UTF-8 text file.',
    input: writeInput,
    async execute(args, context) {
      if (args.file_path.trim().length === 0)
        throw new Error('file_path must be a non-empty string')
      const policy = await resolveMutationPolicy(state, 'write', args, context)
      const resolved = await resolveTarget(policy.workspaceRoot, args.file_path)
      const sessionId = sessionIdOf(context)
      const intent = state.observations.writeIntent(sessionId, resolved)
      try {
        const target = await fenceTarget(resolved, policy, 'write')
        const outcome = await state.locks.with(target.targetKey, async () => {
          const existing = await probe(target.targetKey)
          if (existing !== null && existing.type !== 'file') {
            throw new FsError(
              `cannot write "${target.displayPath}": not a regular file`,
              'FS_NOT_REGULAR_FILE',
            )
          }
          if (intent.kind === 'replaceIfVersion') {
            if (existing === null)
              throw new FsError(
                `cannot write "${target.displayPath}": file no longer exists`,
                'FS_STALE_VERSION',
              )
            if (existing.version !== intent.version) {
              throw new FsError(
                `cannot write "${target.displayPath}": file changed since it was read`,
                'FS_STALE_VERSION',
              )
            }
          } else if (existing !== null) {
            throw new FsError(
              `cannot overwrite existing "${target.displayPath}" without reading it first`,
              'FS_NOT_OBSERVED',
            )
          }
          const before =
            existing !== null &&
            Buffer.byteLength(args.content, 'utf8') < DIFF_BASIS_MAX_BYTES
              ? await readTextForDiff(target.targetKey, DIFF_BASIS_MAX_BYTES)
              : null
          await writeFileAtomic(
            target.targetKey,
            args.content,
            existing?.mode,
            context.signal,
            {
              createIfAbsent:
                intent.kind === 'createIfAbsent'
                  ? { displayPath: target.displayPath }
                  : undefined,
              stagingRoot: state.services.writeStagingRoot,
            },
          )
          const after = await probe(target.targetKey)
          return {
            operation:
              existing === null ? ('create' as const) : ('update' as const),
            version: after?.version ?? `missing:${target.targetKey}`,
            before,
          }
        })
        state.observations.observe(sessionId, target, {
          kind: 'present',
          version: outcome.version,
        })
        const after = normalizeLineEndings(args.content)
        // An overwrite whose prior text is not a usable basis (binary, huge) gets no diff.
        const summary =
          outcome.operation === 'create'
            ? unifiedDiff(target.displayPath, null, after)
            : outcome.before === null
              ? { added: 0, removed: 0, diff: '', diffUnavailable: true }
              : unifiedDiff(target.displayPath, outcome.before, after)
        return {
          content: formatWriteOutput(target.displayPath, outcome.operation),
          meta: {
            path: target.displayPath,
            kind: 'write',
            operation: outcome.operation,
            ...summary,
          },
        }
      } catch (error: unknown) {
        throw remediate(error)
      }
    },
  })
}
