/**
 * Tool definition vocabulary (ported from dsh-tools, with zod as the
 * argument schema language: one zod schema is both the JSON Schema sent to
 * the model and the validator applied to every call).
 */

import { z } from 'zod'
import { HarnessError } from '../../llm/error'
import type { UserMessage } from '../../llm/message'
import type { ContentBlock } from '../../llm/types'
import type { JsonValue } from '../../session-log/json'
import type { Agent } from '../agent/agent'

/** Per-call context handed to a tool body. */
export interface ToolRunContext {
  readonly callId: string
  readonly name: string
  /** Validated, frozen arguments. */
  readonly arguments: unknown
  /** Calling agent (absent for host-initiated calls). */
  readonly agent?: Agent
  /** Aborts on turn cancellation or tool timeout. */
  readonly signal: AbortSignal
  /** Queue a context message to enter the very next step. */
  deferContext(context: UserMessage): void
  /** End the turn after this step's tool results are committed. */
  concludeTurn(): void
}

/** What a tool body returns: plain text, blocks, or a full result. */
export type ToolReturn =
  | string
  | ContentBlock[]
  | {
      content: string | ContentBlock[]
      /** JSON-serializable UI metadata (validated at runtime). */ meta?: unknown
      isError?: boolean
    }

export interface ToolDefinition<A = unknown> {
  readonly name: string
  readonly description: string
  /** JSON Schema object for the arguments, as sent to the model. */
  readonly parameters: Record<string, unknown>
  /**
   * Per-agent argument schema (e.g. a structured child's `structured_output`
   * schema); falls back to {@link parameters} when absent or undefined.
   */
  parametersFor?(agent: Agent | undefined): Record<string, unknown> | undefined
  /** Validate raw arguments; throw {@link ToolArgsError} on mismatch. */
  parse(raw: unknown): A
  execute(args: A, context: ToolRunContext): Promise<ToolReturn>
  /** Whether this call may overlap other parallel-safe calls (default false). */
  isConcurrencySafe?(args: A): boolean
  /** Hard deadline for one call's body, in milliseconds. */
  readonly timeoutMs?: number
  /** Rewrite final model-facing content after post-execute (e.g. spill notes). */
  finalizeContent?(
    context: ToolRunContext,
    result: ToolExecutionResult,
  ): ContentBlock[] | undefined
}

export interface ToolErrorInfo {
  name: string
  code: string
}

export interface ToolFailure {
  message: string
  info?: ToolErrorInfo
}

export interface ToolExecutionResult {
  readonly isError: boolean
  readonly content: ContentBlock[]
  readonly meta?: JsonValue
  readonly error?: ToolFailure
  readonly additionalContexts?: UserMessage[]
  readonly concludesTurn?: true
}

export const TOOL_ABORTED = 'ABORTED'
export const TOOL_ABORTED_BEFORE_DISPATCH = 'ABORTED_BEFORE_DISPATCH'
export const TOOL_TIMEOUT = 'TOOL_TIMEOUT'
export const UNKNOWN_TOOL = 'UNKNOWN_TOOL'
export const INVALID_ARGS = 'INVALID_ARGS'

export class ToolArgsError extends HarnessError {
  constructor(toolName: string, detail: string) {
    super(`invalid arguments for tool "${toolName}": ${detail}`, INVALID_ARGS)
  }
}

export class ToolNotFoundError extends HarnessError {
  constructor(toolName: string) {
    super(`unknown tool "${toolName}"`, UNKNOWN_TOOL)
  }
}

/** A tool failure the model should see verbatim (no "Error:" wrapping beyond the prefix). */
export class ToolError extends HarnessError {
  constructor(message: string, code = 'TOOL_ERROR', options?: ErrorOptions) {
    super(message, code, options)
  }
}

/** Convert a zod schema into the JSON Schema object sent to the model. */
export function zodParameters(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, {
    io: 'input',
    unrepresentable: 'any',
  }) as Record<string, unknown>
  const { $schema: _schema, ...rest } = json
  return rest
}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .map(
      (issue) =>
        `${issue.path.length > 0 ? issue.path.join('.') : '(root)'}: ${issue.message}`,
    )
    .join('; ')
}

export interface DefineToolSpec<S extends z.ZodType> {
  name: string
  description: string
  input: S
  execute(args: z.output<S>, context: ToolRunContext): Promise<ToolReturn>
  isConcurrencySafe?(args: z.output<S>): boolean
  timeoutMs?: number
  finalizeContent?: ToolDefinition<z.output<S>>['finalizeContent']
}

/** Define a tool whose arguments are described and validated by one zod schema. */
export function defineTool<S extends z.ZodType>(
  spec: DefineToolSpec<S>,
): ToolDefinition<z.output<S>> {
  const parameters = zodParameters(spec.input)
  return {
    name: spec.name,
    description: spec.description,
    parameters,
    parse(raw: unknown): z.output<S> {
      if (typeof raw === 'string') {
        throw new ToolArgsError(
          spec.name,
          `arguments are not valid JSON: ${raw.slice(0, 200)}`,
        )
      }
      const parsed = spec.input.safeParse(raw)
      if (!parsed.success)
        throw new ToolArgsError(spec.name, describeIssues(parsed.error))
      return parsed.data
    },
    execute: spec.execute,
    ...(spec.isConcurrencySafe === undefined
      ? {}
      : { isConcurrencySafe: spec.isConcurrencySafe }),
    ...(spec.timeoutMs === undefined ? {} : { timeoutMs: spec.timeoutMs }),
    ...(spec.finalizeContent === undefined
      ? {}
      : { finalizeContent: spec.finalizeContent }),
  }
}

/** Normalize a tool body's return into content + meta. */
export function normalizeToolReturn(value: ToolReturn): {
  content: ContentBlock[]
  meta?: unknown
  isError: boolean
} {
  if (typeof value === 'string')
    return { content: [{ type: 'text', text: value }], isError: false }
  if (Array.isArray(value)) return { content: value, isError: false }
  const content =
    typeof value.content === 'string'
      ? [{ type: 'text' as const, text: value.content }]
      : value.content
  return {
    content,
    isError: value.isError === true,
    ...(value.meta === undefined ? {} : { meta: value.meta }),
  }
}

/** The model-facing result for a thrown error. */
export function toolErrorResult(error: unknown): ToolExecutionResult {
  const message = error instanceof Error ? error.message : String(error)
  const info =
    error instanceof HarnessError
      ? { name: error.name, code: error.code }
      : undefined
  return {
    isError: true,
    content: [{ type: 'text', text: `Error: ${message}` }],
    error: { message, ...(info === undefined ? {} : { info }) },
  }
}

export function toolAbortedResult(
  beforeDispatch: boolean,
): ToolExecutionResult {
  const message = beforeDispatch
    ? 'tool call aborted before dispatch'
    : 'tool call aborted'
  return {
    isError: true,
    content: [{ type: 'text', text: `Error: ${message}` }],
    error: {
      message,
      info: {
        name: 'AbortError',
        code: beforeDispatch ? TOOL_ABORTED_BEFORE_DISPATCH : TOOL_ABORTED,
      },
    },
  }
}

/** Render text content blocks (tool-result helpers). */
export function textOf(content: readonly ContentBlock[]): string {
  return content
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('')
}
