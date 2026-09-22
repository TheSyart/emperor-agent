/**
 * Standard filesystem tools (ported from the dsh standard preset:
 * dsh-tool-fs + dsh-fs-observation-policy + dsh-fs-sandbox), as plain
 * tool definitions over the local filesystem.
 *
 *     const fs = createFsTools(services)
 *     registry.register(fs.read); registry.register(fs.write); registry.register(fs.edit)
 *     installFsPromptSections(prompt)
 */

import type { ToolDefinition } from '../../definition'
import type { ToolServices } from '../../services'
import { createEditTool, type EditArgs } from './edit'
import { TargetLocks } from './fsio'
import { FsObservations } from './observations'
import { createReadTool, type ReadArgs } from './read'
import type { FsToolState } from './shared'
import { createWriteTool, type WriteArgs } from './write'

export { FsError, type FsErrorCode, type FsTarget } from './fsio'
export {
  FsObservations,
  type FsObservation,
  type FsWriteIntent,
} from './observations'
export { FS_PROMPT_SECTIONS, installFsPromptSections } from './prompt'
export {
  READ_LIMIT,
  READ_MAX_BYTES,
  READ_MAX_LINE_LENGTH,
  STREAM_MIN_SIZE,
} from './read'
export { DIFF_MAX_CHARS, unifiedDiff } from './diff'
export type { EditArgs, ReadArgs, WriteArgs }

export interface FsTools {
  read: ToolDefinition<ReadArgs>
  write: ToolDefinition<WriteArgs>
  edit: ToolDefinition<EditArgs>
  /** Per-session read-before-edit state shared by the three tools. */
  observations: FsObservations
}

export function createFsTools(services: ToolServices): FsTools {
  const state: FsToolState = {
    services,
    observations: new FsObservations(),
    locks: new TargetLocks(),
  }
  return {
    read: createReadTool(state),
    write: createWriteTool(state),
    edit: createEditTool(state),
    observations: state.observations,
  }
}
