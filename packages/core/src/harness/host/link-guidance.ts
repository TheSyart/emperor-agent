/**
 * Static system-prompt section on linking local files (E-track contract §4).
 * Replies render `[name](path)` as a typed document link the user can click
 * open; paths in code formatting are not clickable. Static on purpose: it
 * sits right after the persona and never changes, so the prefix cache holds.
 */

import type { SystemPromptAssembler } from '../prompt/assembler'

export const LINK_GUIDANCE_PROMPT =
  'Linking local files: when you mention a file or folder the user may want to open, write it as a markdown link [readable name](path). ' +
  'Use a path relative to the working directory or an absolute path, and add #L<line> to point at a line, for example [config.ts](src/config.ts#L12). ' +
  'Emperor shows such links with a file-type icon and opens them in its Files pane. ' +
  'Do not put a path the user should open in code formatting (backticks or code blocks): code is not clickable. Code identifiers and commands stay in code formatting as usual.'

export function installLinkGuidancePromptSection(
  prompt: SystemPromptAssembler,
): () => void {
  return prompt.section({
    name: 'links',
    order: 10,
    text: LINK_GUIDANCE_PROMPT,
  })
}
