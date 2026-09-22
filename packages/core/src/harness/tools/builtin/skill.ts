/**
 * Skills (ported from dsh tool-skill, over Emperor's FileSkillsLoader roots).
 *
 * - The catalog (names + descriptions) enters as a durable context message
 *   (`form: 'catalog'`) at pre-step, and a replacement catalog enters only
 *   when the set changes — never a hidden system-prompt edit.
 * - `skill {name}` loads one skill's full instructions as the tool result.
 * - A user message containing `/skill-name` injects that skill's
 *   instructions directly for the step.
 */

import { createHash } from 'node:crypto'
import { z } from 'zod'
import { contextMessage, type UserMessage } from '../../../llm/message'
import type { Session } from '../../../session-log/session'
import type {
  FileSkillsLoader,
  ResolvedSkill,
} from '../../../skills/file-loader'
import { isSkillName, skillGesturePattern } from '../../../skills/name'
import type { Agent } from '../../agent/agent'
import type { PreStepMiddleware } from '../../agent/middleware'
import { defineTool, ToolError, type ToolDefinition } from '../definition'

export const SKILL_CATALOG_PRODUCER = 'skill-catalog'
export const SKILL_INVOCATION_PRODUCER = 'skill-invocation'
const DESCRIPTION_MAX = 500

export interface SkillCatalogEntry {
  name: string
  description: string
}

/** Skills resolution for one agent (the loader of the agent's project root). */
export interface SkillSource {
  loaderFor(agent: Agent | undefined): FileSkillsLoader
}

function escapeText(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

function escapeAttr(value: string): string {
  return escapeText(value).replaceAll('"', '&quot;')
}

function catalogDescription(value: string): string {
  const normalized = value.replaceAll(/\s+/g, ' ').trim()
  return normalized.length <= DESCRIPTION_MAX
    ? normalized
    : `${normalized.slice(0, DESCRIPTION_MAX - 3)}...`
}

function isModelInvocable(skill: ResolvedSkill): boolean {
  return skill.frontmatter['disable-model-invocation'] !== true
}

export function catalogEntries(loader: FileSkillsLoader): SkillCatalogEntry[] {
  return loader
    .resolvedSkills()
    .filter((skill) => skill.status === 'active' && isModelInvocable(skill))
    .map((skill) => ({
      name: skill.name,
      description: catalogDescription(skill.description),
    }))
}

function digestEntries(entries: readonly SkillCatalogEntry[]): string {
  return createHash('sha256')
    .update(
      entries
        .map((entry) => JSON.stringify([entry.name, entry.description]))
        .join('\n'),
    )
    .digest('hex')
}

export function renderSkillContent(skill: ResolvedSkill): string {
  const content = skill.content
    .replaceAll('{{skill_dir}}', skill.root)
    .replaceAll('${EMPEROR_SKILL_DIR}', skill.root)
    .replaceAll('${CLAUDE_SKILL_DIR}', skill.root)
  return [
    `<skill_content name="${escapeAttr(skill.name)}">`,
    '<skill_resources>',
    `Resources for this skill live under ${escapeText(skill.root)}. Load referenced files only as needed (relative paths resolve against that directory).`,
    '</skill_resources>',
    '',
    '<skill_instructions>',
    content,
    '</skill_instructions>',
    '</skill_content>',
  ].join('\n')
}

function renderCatalog(
  entries: readonly SkillCatalogEntry[],
  update: boolean,
): string {
  const list = entries.map(
    (entry) => `- \`${entry.name}\`: ${escapeText(entry.description)}`,
  )
  if (!update) {
    return [
      '<system-reminder>',
      'A skill is a reusable set of task-specific instructions. The following skills are available in this session:',
      '',
      '<available_skills>',
      ...list,
      '</available_skills>',
      '',
      "If the user names a skill, or the task clearly matches a skill's description, call the `skill` tool with the exact skill name before taking task actions. Load all applicable skills, then follow their full instructions. This catalog contains summaries only; do not infer or follow a skill's instructions until it has been loaded.",
      'A user may also invoke a skill directly; its <skill_content> block then appears in this conversation. Follow it, and do not call the `skill` tool again for that skill.',
      '</system-reminder>',
    ].join('\n')
  }
  const availability =
    entries.length === 0
      ? [
          'No skills are currently available through the `skill` tool. Do not use names from earlier skill catalogs.',
          'A user may still invoke a skill directly; its <skill_content> block then appears in this conversation. Follow it, and do not call the `skill` tool for it.',
        ]
      : [
          'Use only names in this replacement catalog. If the user names a listed skill, or the task clearly matches its description, call the `skill` tool with the exact name before acting.',
          'A user may also invoke a skill directly; its <skill_content> block then appears in this conversation. Follow it, and do not call the `skill` tool again for that skill.',
        ]
  return [
    '<system-reminder>',
    'The available skill catalog changed. This complete catalog replaces every earlier available-skills list in this session:',
    '',
    '<available_skills>',
    ...list,
    '</available_skills>',
    '',
    ...availability,
    '</system-reminder>',
  ].join('\n')
}

/** Digest of the catalog still visible on the surface, and whether any was ever published. */
function catalogHistory(session: Session): {
  visibleDigest?: string
  published: boolean
} {
  const visible = new Set(session.surface.nodes)
  let published = false
  for (let index = session.events.length - 1; index >= 0; index -= 1) {
    const event = session.events[index]!
    if (
      event.type !== 'user/message' ||
      event.data.source.kind !== 'context' ||
      event.data.source.producer !== SKILL_CATALOG_PRODUCER
    )
      continue
    const digest = event.data.source.summary?.replace(/^catalog:/, '')
    published = true
    if (visible.has(event.seq))
      return {
        ...(digest === undefined ? {} : { visibleDigest: digest }),
        published,
      }
  }
  return { published }
}

export function createSkillTool(source: SkillSource): ToolDefinition {
  return defineTool({
    name: 'skill',
    description:
      'Load the full instructions for an available skill. Call this with the exact skill name from the session skill catalog before acting on a task that names or clearly matches that skill.',
    input: z.object({
      name: z
        .string()
        .describe('The exact skill name from the available skills list.'),
    }),
    isConcurrencySafe: () => true,
    async execute({ name }, context) {
      if (!isSkillName(name))
        throw new ToolError(`invalid skill name "${name}"`)
      const skill = source.loaderFor(context.agent).resolve(name)
      if (skill === null || skill.status !== 'active')
        throw new ToolError(`skill "${name}" is unknown or no longer available`)
      if (!isModelInvocable(skill))
        throw new ToolError(
          `skill "${name}" is not available for model invocation`,
        )
      return {
        content: renderSkillContent(skill),
        meta: { name: skill.name, source: skill.source, root: skill.root },
      }
    },
  })
}

/** Pre-step: user `/skill` gestures inject instructions; the catalog enters when it changes. */
export function skillMiddleware(
  source: SkillSource,
  isToolVisible: (agent: Agent) => boolean,
): PreStepMiddleware {
  return ({ agent, messages }) => {
    const loader = source.loaderFor(agent)
    const injections: UserMessage[] = []
    let resolved: Map<string, ResolvedSkill> | undefined
    const lookup = (name: string): ResolvedSkill | undefined => {
      resolved ??= new Map(
        loader.resolvedSkills().map((skill) => [skill.name, skill]),
      )
      return resolved.get(name)
    }
    for (const message of messages) {
      if (message.source.kind !== 'user') continue
      for (const block of message.content) {
        if (block.type !== 'text') continue
        for (const match of block.text.matchAll(skillGesturePattern())) {
          const name = match[2]
          if (
            name === undefined ||
            injections.some(
              (entry) =>
                entry.source.kind === 'context' &&
                entry.source.summary === `skill:${name}`,
            )
          )
            continue
          const skill = lookup(name)
          if (skill === undefined || skill.status !== 'active') continue
          injections.push(
            contextMessage(
              SKILL_INVOCATION_PRODUCER,
              renderSkillContent(skill),
              { form: 'instructions', summary: `skill:${name}` },
            ),
          )
        }
      }
    }
    let next = injections.length === 0 ? messages : [...messages, ...injections]
    if (isToolVisible(agent)) {
      const entries = catalogEntries(loader)
      const digest = digestEntries(entries)
      const history = catalogHistory(agent.session)
      if (
        history.visibleDigest !== digest &&
        (history.published || entries.length > 0)
      ) {
        next = [
          ...next,
          contextMessage(
            SKILL_CATALOG_PRODUCER,
            renderCatalog(entries, history.published),
            { form: 'catalog', summary: `catalog:${digest}` },
          ),
        ]
      }
    }
    return next === messages ? undefined : { kind: 'enter', messages: next }
  }
}
