/**
 * System prompt assembly (ported from dsh-system-prompt, without scoped
 * layers). Two channels:
 *
 * - **Sections** form the static system prompt, sorted by `order` and
 *   joined by blank lines. It should change rarely: every change breaks the
 *   provider's prefix cache and is logged as a new `request/header`.
 * - **Contexts** form the dynamic runtime-context snapshot, which the loop
 *   enters as a durable `user/message` only when its text changed.
 *
 * `{{name}}` references are strict: an unknown or valueless variable throws.
 */

import type { Agent } from '../agent/agent'
import type { ToolSchema } from '../../llm/types'

export interface AssembleContext {
  agent?: Agent
  signal?: AbortSignal
}

export type PromptText = string | ((context: AssembleContext) => string)

export interface PromptSection {
  readonly name: string
  readonly order: number
  readonly text: PromptText
}

export interface PromptContext {
  readonly name: string
  readonly order: number
  readonly text: PromptText
}

export interface ContextSnapshotSection {
  readonly name: string
  readonly text: string
}

export interface PromptAssembly {
  sections: Array<{ name: string; text: string }>
  contexts: Array<{ name: string; text: string }>
  tools: ToolSchema[]
  variables: Record<string, string | undefined>
}

const VARIABLE_NAME = /^[a-z][a-z0-9_]*$/
const GROUP_AT = /^\{\{([^{}]*)\}\}/

/** Render the static system prompt from an assembly. */
export function renderPrompt(assembly: PromptAssembly): string {
  return assembly.sections
    .map((section) => interpolate(section, assembly.variables, 'section'))
    .filter((text) => text.length > 0)
    .join('\n\n')
}

/** Render each non-empty runtime context in order. */
export function renderContextSections(
  assembly: PromptAssembly,
): ContextSnapshotSection[] {
  return assembly.contexts
    .map((context) => ({
      name: context.name,
      text: interpolate(context, assembly.variables, 'context'),
    }))
    .filter((section) => section.text.length > 0)
}

/** Join rendered contexts into the snapshot text ('' when none). */
export function joinContextSections(
  sections: readonly ContextSnapshotSection[],
): string {
  const body = sections.map((section) => section.text).join('\n\n')
  if (body.length === 0) return ''
  return `Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\n${body}`
}

function interpolate(
  input: { name: string; text: string },
  variables: Record<string, string | undefined>,
  kind: 'section' | 'context',
): string {
  const text = input.text
  let result = ''
  let last = 0
  for (
    let open = text.indexOf('{{');
    open >= 0;
    open = text.indexOf('{{', last)
  ) {
    const group = GROUP_AT.exec(text.slice(open))
    if (group === null) {
      if (text.indexOf('}}', open + 2) >= 0) {
        throw new Error(
          `malformed prompt variable reference at "${text.slice(open, open + 16)}…" in ${kind} "${input.name}"`,
        )
      }
      result += text.slice(last, open + 2)
      last = open + 2
      continue
    }
    const name = group[0].slice(2, -2)
    if (!VARIABLE_NAME.test(name)) {
      throw new Error(
        `malformed prompt variable reference "{{${name}}}" in ${kind} "${input.name}"`,
      )
    }
    if (!Object.hasOwn(variables, name)) {
      const known = Object.keys(variables)
      throw new Error(
        `unknown prompt variable "{{${name}}}" in ${kind} "${input.name}"; registered variables: ${known.length > 0 ? known.join(', ') : '(none)'}`,
      )
    }
    const value = variables[name]
    if (value === undefined)
      throw new Error(
        `prompt variable "{{${name}}}" has no value for this assembly (${kind} "${input.name}")`,
      )
    result += text.slice(last, open) + value
    last = open + group[0].length
  }
  return result + text.slice(last)
}

export type ToolProvider = (context: AssembleContext) => ToolSchema[]
export type VariableProvider = (context: AssembleContext) => string | undefined

/**
 * Registry of sections, contexts, variables, and tool providers. Each
 * registration returns its disposer. Names are unique per assembler.
 */
export class SystemPromptAssembler {
  private readonly sections = new Map<string, PromptSection>()
  private readonly contexts = new Map<string, PromptContext>()
  private readonly variables = new Map<string, VariableProvider>()
  private readonly toolProviders = new Set<ToolProvider>()

  section(section: PromptSection): () => void {
    return this.insert(this.sections, section.name, section, 'prompt section')
  }

  context(context: PromptContext): () => void {
    return this.insert(this.contexts, context.name, context, 'prompt context')
  }

  variable(name: string, provider: VariableProvider): () => void {
    if (!VARIABLE_NAME.test(name))
      throw new Error(`invalid prompt variable name "${name}"`)
    return this.insert(this.variables, name, provider, 'prompt variable')
  }

  tools(provider: ToolProvider): () => void {
    this.toolProviders.add(provider)
    return () => {
      this.toolProviders.delete(provider)
    }
  }

  private insert<T>(
    map: Map<string, T>,
    name: string,
    value: T,
    label: string,
  ): () => void {
    if (map.has(name))
      throw new Error(`${label} "${name}" is already registered`)
    map.set(name, value)
    return () => {
      if (map.get(name) === value) map.delete(name)
    }
  }

  /** Assemble one request's prompt: sections/contexts ordered, tools sorted by name. */
  assemble(context: AssembleContext = {}): PromptAssembly {
    const resolve = (text: PromptText): string =>
      typeof text === 'function' ? text(context) : text
    const byOrder = <T extends { order: number; name: string }>(
      a: T,
      b: T,
    ): number =>
      a.order - b.order || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    const variables: Record<string, string | undefined> = {}
    for (const [name, provider] of this.variables)
      variables[name] = provider(context)
    const tools = new Map<string, ToolSchema>()
    for (const provider of this.toolProviders) {
      for (const schema of provider(context)) {
        if (tools.has(schema.name))
          throw new Error(`tool "${schema.name}" is provided twice`)
        tools.set(schema.name, schema)
      }
    }
    return {
      sections: [...this.sections.values()]
        .sort(byOrder)
        .map((s) => ({ name: s.name, text: resolve(s.text) })),
      contexts: [...this.contexts.values()]
        .sort(byOrder)
        .map((c) => ({ name: c.name, text: resolve(c.text) })),
      tools: [...tools.values()].sort((a, b) =>
        a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
      ),
      variables,
    }
  }
}
