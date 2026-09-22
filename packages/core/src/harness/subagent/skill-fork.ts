/**
 * `context: fork` skill commands: run a user-invoked skill as a forked
 * subagent of the session's root agent. The child sees the parent's
 * completed turns, receives the rendered skill instructions plus the task
 * as its first prompt, and is optionally narrowed by the skill's
 * `allowed_tools` (tool visibility) and `effort` (reasoning effort).
 */

import type { LlmCallConfig } from '../../llm/call-config'
import type { LlmClient } from '../../llm/client'
import { deepseekEffort, type RouteSpec } from '../../llm/route'
import type { ResolvedSkill } from '../../skills/file-loader'
import type { Agent } from '../agent/agent'
import { renderSkillContent } from '../tools/builtin/skill'
import type { ToolRegistry } from '../tools/registry'
import type { SubagentManager } from './manager'

export interface SkillForkInput {
  skill: ResolvedSkill
  task: string
  allowedTools: readonly string[]
  effort: string | null
}

export interface SkillForkDeps {
  subagents: SubagentManager
  llm: LlmClient
  tools: ToolRegistry
}

export class SkillForkError extends Error {
  constructor(
    message: string,
    readonly code: 'skill_fork_tool_scope_invalid',
  ) {
    super(message)
    this.name = 'SkillForkError'
  }
}

/** Map a skill `effort` onto the route's vocabulary; undefined → inherit. */
export function routeEffort(
  route: RouteSpec,
  effort: string,
): string | undefined {
  if (route.reasoningEfforts.length === 0) return undefined
  const normalized = effort.trim().toLowerCase()
  const candidate =
    route.adapter === 'deepseek'
      ? deepseekEffort(normalized)
      : normalized === 'none'
        ? 'off'
        : normalized
  return candidate !== undefined && route.reasoningEfforts.includes(candidate)
    ? candidate
    : undefined
}

export function skillForkPrompt(skill: ResolvedSkill, task: string): string {
  return [
    renderSkillContent(skill),
    '',
    task ? `Task: ${task}` : 'Task: follow the skill instructions above.',
  ].join('\n')
}

/** Start the forked child (background: its settlement notifies the parent). */
export function startSkillFork(
  deps: SkillForkDeps,
  parent: Agent,
  input: SkillForkInput,
): Agent {
  const allow = [
    ...new Set(input.allowedTools.map((name) => name.trim())),
  ].filter(Boolean)
  const unknown = allow.filter((name) => deps.tools.get(name) === undefined)
  if (unknown.length > 0)
    throw new SkillForkError(
      `Skill 请求了不存在的工具：${unknown.join('、')}`,
      'skill_fork_tool_scope_invalid',
    )
  const effort = input.effort
  const callConfig =
    effort === null || !effort.trim()
      ? undefined
      : (): LlmCallConfig => {
          const base = deps.llm.defaultCallConfig()
          const route = deps.llm.route(base.provider)
          const mapped = routeEffort(route, effort)
          return mapped === undefined
            ? base
            : { ...base, reasoningEffort: mapped }
        }
  return deps.subagents.start(parent, {
    description: `skill: ${input.skill.name}`,
    prompt: skillForkPrompt(input.skill, input.task),
    mode: 'fork',
    background: true,
    agentOptions: {
      ...(allow.length === 0 ? {} : { toolFilter: { allow } }),
      ...(callConfig === undefined ? {} : { callConfig }),
    },
  })
}
