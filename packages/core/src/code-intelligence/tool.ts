import { isAbsolute } from 'node:path'
import {
  Tool,
  errResult,
  okResult,
  type ToolExecutionContext,
  type ToolResult,
} from '../tools/base'
import { I, S, toolParamsSchema } from '../tools/schema'
import type {
  CodeIntelligenceContext,
  CodeIntelligenceQuery,
  CodeIntelligenceResult,
} from './service'

interface CodeIntelligenceQueryPort {
  query(
    input: CodeIntelligenceQuery,
    context: CodeIntelligenceContext,
  ): Promise<CodeIntelligenceResult>
}

export type CodeIntelligenceScopeResolver = (
  context: ToolExecutionContext,
) => { workspaceRoot: string; sessionId: string } | null

export class CodeIntelligenceTool extends Tool {
  override readonly name = 'code_intelligence'
  override readonly description =
    '查询当前 Build 项目的代码符号图：按符号查定义/引用，或按文件位置跳转定义/引用。' +
    '结果来自受界增量 AST 图；可用时位置查询优先受信 LSP，并明确标注 fallback。'
  override readonly parameters = toolParamsSchema(
    {
      operation: S(
        'find_definitions | find_references | go_to_definition | find_position_references',
      ),
      symbol: S('符号名；find_definitions/find_references 必填'),
      path: S('当前 Build 项目内的相对文件路径；位置查询必填'),
      line: I('1-based 行号；位置查询必填'),
      column: I('1-based 列号；位置查询必填'),
    },
    ['operation'],
  )
  override readOnly = true
  override concurrencySafe = true
  override requiresRuntimeContext = true
  override evidencePolicy = 'eligible' as const
  override maxResultChars = 20_000

  constructor(
    private readonly service: CodeIntelligenceQueryPort,
    private readonly resolveScope: CodeIntelligenceScopeResolver,
  ) {
    super()
  }

  async execute(
    args: Record<string, unknown>,
    context?: ToolExecutionContext,
  ): Promise<string> {
    if (!context)
      return '[ERR] code_intelligence requires an active Build session'
    const scope = this.resolveScope(context)
    if (!scope)
      return '[ERR] code_intelligence requires an active Build session with a bound project'
    let query: CodeIntelligenceQuery
    try {
      query = parseQuery(args)
    } catch (error) {
      return `[ERR] ${error instanceof Error ? error.message : 'invalid code intelligence query'}`
    }
    try {
      const result = await this.service.query(query, {
        ...scope,
        signal: context.signal ?? null,
      })
      return JSON.stringify(result)
    } catch {
      return '[ERR] code intelligence query failed'
    }
  }

  override mapResult(raw: string, _context: ToolExecutionContext): ToolResult {
    return raw.startsWith('[ERR]')
      ? errResult(raw, { meta: { tool: this.name } })
      : okResult(raw, { meta: { tool: this.name } })
  }
}

function parseQuery(args: Record<string, unknown>): CodeIntelligenceQuery {
  const operation = String(args.operation ?? '').trim()
  if (operation === 'find_definitions' || operation === 'find_references') {
    const symbol = String(args.symbol ?? '').trim()
    if (!symbol || symbol.length > 256)
      throw new Error(`${operation} requires a valid symbol`)
    return { operation, symbol }
  }
  if (
    operation === 'go_to_definition' ||
    operation === 'find_position_references'
  ) {
    const path = normalizeRelativePath(String(args.path ?? ''))
    const line = positiveInteger(args.line, 'line')
    const column = positiveInteger(args.column, 'column')
    return { operation, path, line, column }
  }
  throw new Error('unsupported code intelligence operation')
}

function normalizeRelativePath(value: string): string {
  const path = value.trim().replaceAll('\\', '/').replace(/^\.\//, '')
  if (
    !path ||
    isAbsolute(path) ||
    path.split('/').some((part) => !part || part === '..')
  )
    throw new Error('path must be workspace-relative')
  return path
}

function positiveInteger(value: unknown, label: string): number {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 1)
    throw new Error(`${label} must be a positive integer`)
  return number
}
