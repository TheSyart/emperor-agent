import type { ContentBlock } from '@emperor/core/runtime-contract'
import type { ChatSnapshot } from '../../conversation/types'
import type { WorkspaceSource } from '../workspace/workspaceTypes'

/**
 * Attachments and tool-result images of the loaded conversation window,
 * deduplicated, for the Environment tab.
 */
export function workspaceSourcesFromSnapshot(
  snapshot: ChatSnapshot | null | undefined,
): WorkspaceSource[] {
  if (!snapshot) return []
  const seen = new Set<string>()
  const sources: WorkspaceSource[] = []
  const remember = (id: string) => {
    if (!id || seen.has(id)) return false
    seen.add(id)
    return true
  }
  const images = (blocks: readonly ContentBlock[] | undefined) => {
    for (const block of blocks ?? []) {
      if (block.type !== 'image') continue
      const id = block.attachment.attachmentId
      if (remember(id)) sources.push({ id, name: id, kind: 'media' })
    }
  }
  for (const key of snapshot.order) {
    const node = snapshot.nodes.get(key)
    if (node?.kind === 'user') {
      for (const attachment of node.data.attachments) {
        const id = typeof attachment.id === 'string' ? attachment.id : ''
        if (!remember(id)) continue
        const name = typeof attachment.name === 'string' ? attachment.name : id
        sources.push({ id, name, kind: 'attachment' })
      }
      continue
    }
    if (node?.kind === 'tool') images(node.data.result?.content)
  }
  return sources
}
