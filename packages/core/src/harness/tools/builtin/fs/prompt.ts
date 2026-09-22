/**
 * Per-tool system-prompt guidance for the fs tools (verbatim dsh-tool-fs
 * texts, orders 100–102).
 */

import type { SystemPromptAssembler } from '../../../prompt/assembler'

export const FS_PROMPT_SECTIONS = [
  {
    name: 'tool:read',
    order: 100,
    text: 'Use the read tool — not shell commands like cat — to inspect text files. Results include line numbers. Use offset and limit to continue reading large files.',
  },
  {
    name: 'tool:write',
    order: 101,
    text: 'Use the write tool to create files or completely replace file contents. Existing files are overwritten, so read an existing file first (the default fs-observation-policy requires it) and prefer edit for targeted changes.',
  },
  {
    name: 'tool:edit',
    order: 102,
    text: 'Use the edit tool for targeted changes to existing UTF-8 text files. It replaces literal old_string with new_string; by default old_string must appear exactly once. If old_string appears multiple times, provide a more specific old_string or set replace_all to true. Read the file first (the default fs-observation-policy requires it), unless you just created or edited it in this session.',
  },
] as const

/** Register the three guidance sections; returns one disposer for all of them. */
export function installFsPromptSections(
  prompt: SystemPromptAssembler,
): () => void {
  const disposers = FS_PROMPT_SECTIONS.map((section) => prompt.section(section))
  return () => {
    for (const dispose of disposers) dispose()
  }
}
