/**
 * Emperor long-term memory on the new kernel.
 *
 * - Baseline: MEMORY.md (shared), USER.md (user profile) and, for Build
 *   sessions, the project's managed memory enter as one durable
 *   `instructions` context message at the first step of a turn whenever
 *   their content changed since the last baseline (cache-stable, never a
 *   hidden system-prompt edit).
 * - `memory_edit`: exact-string edits (or appends) to one memory file, with
 *   the existing version snapshots. Memory is application state, so these
 *   writes are not subject to the workspace file sandbox.
 */

import { createHash } from 'node:crypto'
import { z } from 'zod'
import { contextMessage } from '../../llm/message'
import type { MemoryStore } from '../../memory/store'
import type { ProjectStore } from '../../projects/store'
import type { Session } from '../../session-log/session'
import type { SessionEntry } from '../../sessions/store'
import type { Agent } from '../agent/agent'
import type { PreStepMiddleware } from '../agent/middleware'
import { defineTool, ToolError, type ToolDefinition } from '../tools/definition'

export const MEMORY_PRODUCER = 'memory'
const MAX_SECTION_BYTES = 32 * 1024

declare module '../../session-log/types' {
  interface SessionEventMap {
    /** Log-only digest of the memory baseline last shown to the model. */
    'memory/baseline': { digest: string }
  }
}

export interface MemoryDeps {
  memory: MemoryStore
  projects: ProjectStore
  /** Session index entry for an agent (mode/project binding). */
  sessionEntry(agent: Agent): SessionEntry | null
}

function clip(text: string): string {
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.length <= MAX_SECTION_BYTES) return text
  return `${bytes.subarray(0, MAX_SECTION_BYTES).toString('utf8')}\n\n[… truncated to ${MAX_SECTION_BYTES} bytes]`
}

interface MemorySnapshot {
  memory: string
  user: string
  project?: { id: string; name: string; content: string }
}

function snapshot(deps: MemoryDeps, agent: Agent): MemorySnapshot {
  const entry = deps.sessionEntry(agent)
  const projectId = entry?.mode === 'build' ? entry.project_id : null
  let project: MemorySnapshot['project']
  if (projectId) {
    try {
      const content = deps.projects.readManagedMemory(projectId)
      if (content.trim())
        project = {
          id: projectId,
          name: entry?.project_name ?? projectId,
          content,
        }
    } catch {
      project = undefined
    }
  }
  return {
    memory: deps.memory.readMemory(),
    user: deps.memory.readUser(),
    ...(project === undefined ? {} : { project }),
  }
}

function render(snapshot: MemorySnapshot, replacement: boolean): string {
  const parts: string[] = [
    replacement
      ? 'This memory baseline replaces every earlier memory baseline in this conversation.'
      : 'Long-term memory the user keeps across conversations. Treat it as background facts and preferences; the user may ask you to update it with memory_edit.',
  ]
  if (snapshot.user.trim())
    parts.push(
      `<user_profile path="USER.md">\n${clip(snapshot.user.trim())}\n</user_profile>`,
    )
  if (snapshot.memory.trim())
    parts.push(
      `<memory path="MEMORY.md">\n${clip(snapshot.memory.trim())}\n</memory>`,
    )
  if (snapshot.project)
    parts.push(
      `<project_memory project="${snapshot.project.name}">\n${clip(snapshot.project.content.trim())}\n</project_memory>`,
    )
  return ['<system-reminder>', parts.join('\n\n'), '</system-reminder>'].join(
    '\n',
  )
}

function digestOf(value: MemorySnapshot): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function lastDigest(session: Session): string | undefined {
  return session.lastOf('memory/baseline')?.data.digest
}

/** Pre-step middleware entering the memory baseline when it changed. Root agents only. */
export function memoryMiddleware(deps: MemoryDeps): PreStepMiddleware {
  return ({ agent, messages, step }) => {
    if (step !== 1 || agent.owner !== undefined) return undefined
    const current = snapshot(deps, agent)
    const empty =
      !current.memory.trim() &&
      !current.user.trim() &&
      current.project === undefined
    const digest = digestOf(current)
    const previous = lastDigest(agent.session)
    if (previous === digest) return undefined
    agent.session.append('memory/baseline', { digest })
    if (previous === undefined && empty) return undefined
    return {
      kind: 'enter',
      messages: [
        ...messages,
        contextMessage(
          MEMORY_PRODUCER,
          render(current, previous !== undefined),
          { form: 'instructions' },
        ),
      ],
    }
  }
}

/** `memory_edit`: edit MEMORY.md, USER.md, or the Build project's memory. */
export function createMemoryTool(deps: MemoryDeps): ToolDefinition {
  return defineTool({
    name: 'memory_edit',
    description:
      'Edit the user\'s long-term memory. target "memory" is MEMORY.md (durable facts across conversations), "user" is USER.md (the user\'s profile and preferences), "project" is the current Build project\'s memory (markdown `##` sections). ' +
      'Replace an exact unique old_string with new_string, or omit old_string to append new_string. Only record information the user would want remembered; never store secrets.',
    input: z.object({
      target: z.enum(['memory', 'user', 'project']),
      old_string: z
        .string()
        .optional()
        .describe(
          'Exact text to replace; must occur exactly once. Omit to append.',
        ),
      new_string: z.string().describe('Replacement (or appended) text.'),
    }),
    async execute(args, context) {
      const agent = context.agent
      if (agent === undefined)
        throw new ToolError('memory_edit requires a calling agent')
      if (agent.owner !== undefined)
        throw new ToolError(
          'delegated subagents cannot edit long-term memory; report the fact to your parent instead',
        )
      const edit = (current: string): string => {
        if (args.old_string === undefined || args.old_string === '') {
          return current.trim() === ''
            ? args.new_string
            : `${current.trimEnd()}\n\n${args.new_string}`
        }
        const count = current.split(args.old_string).length - 1
        if (count === 0)
          throw new ToolError(
            `old_string was not found in ${args.target} memory`,
          )
        if (count > 1)
          throw new ToolError(
            `old_string occurs ${count} times in ${args.target} memory; include more context to make it unique`,
          )
        return current.replace(args.old_string, args.new_string)
      }
      if (args.target === 'memory') {
        deps.memory.writeMemory(edit(deps.memory.readMemory()))
      } else if (args.target === 'user') {
        deps.memory.writeUser(edit(deps.memory.readUser()))
      } else {
        const entry = deps.sessionEntry(agent)
        const projectId = entry?.mode === 'build' ? entry.project_id : null
        if (!projectId)
          throw new ToolError(
            'project memory is only available in a Build session bound to a project',
          )
        deps.projects.updateMemory(
          projectId,
          edit(deps.projects.readManagedMemory(projectId)),
        )
      }
      return {
        content: `Updated ${args.target} memory. The new memory reaches you from the next turn.`,
        meta: { target: args.target },
      }
    },
  })
}
