import { join } from 'node:path'
import {
  applyMemoryPatchToFile,
  memoryContentHash,
  type MemoryPatchApplyResult,
  type MemoryPatchOperation,
} from './patch'
import type { MemoryVersionStore } from './versions'

export interface UserProfilePatchTarget {
  targetPath: string
  memoryDir?: string | null
  versions: MemoryVersionStore
  currentContent: string
}

export function applyUserProfileMarkdownPatch(
  markdown: string,
  target: UserProfilePatchTarget,
  opts: { rationale: string; explicitReplace?: boolean },
): MemoryPatchApplyResult {
  const operations = userProfileSectionReplacementOps(markdown)
  if (!operations.length) {
    return {
      ok: false,
      content: target.currentContent,
      errors: ['missing_profile_sections'],
      appliedOperations: 0,
    }
  }
  return applyMemoryPatchToFile(
    {
      target: { kind: 'user_profile' },
      baseVersion: target.versions.nextVersionForPath(target.targetPath, {
        target: 'user',
      }),
      baseHash: memoryContentHash(target.currentContent),
      operations,
      rationale: opts.rationale,
    },
    {
      targetPath: target.targetPath,
      versions: target.versions,
      versionTarget: 'user',
      ledgerPath: target.memoryDir
        ? join(target.memoryDir, 'patch-ledger.jsonl')
        : null,
      explicitReplace: opts.explicitReplace ?? false,
    },
  )
}

export function userProfileSectionReplacementOps(
  markdown: string,
): MemoryPatchOperation[] {
  const lines = String(markdown ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n')
  const ops: MemoryPatchOperation[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^##\s+(.+?)\s*$/.exec(lines[index] ?? '')
    if (!match) continue
    const section = match[1]!.trim()
    let end = lines.length
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      if (/^##\s+\S/.test(lines[cursor] ?? '')) {
        end = cursor
        break
      }
    }
    ops.push({
      op: 'replace_section',
      section,
      content: lines
        .slice(index + 1, end)
        .join('\n')
        .trimEnd(),
    })
  }
  return ops
}
