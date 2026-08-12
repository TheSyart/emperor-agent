import type { SubagentSpec } from '../subagents/spec'
import {
  Tool,
  type ToolExecutionContext,
  type ToolExecutionResult,
  type ToolResult,
} from './base'
import { ToolRegistry } from './registry'
import type { ToolParamsSchema } from './schema'

export type AgentPolicyCaller =
  'dispatch' | 'team' | 'goal_reviewer' | 'scheduler'

export interface AgentToolPolicyReceipt {
  version: 1
  caller: AgentPolicyCaller
  agentName: string
  definitionRevision: string
  toolNames: string[]
  skills: string[]
  mcpServers: string[]
  sandbox: SubagentSpec['definition']['sandbox']
}

/** Materializes one AgentDefinition into an isolated, policy-enforcing registry. */
export class AgentToolPolicyFactory {
  constructor(private readonly parentRegistry: ToolRegistry) {}

  create(
    spec: SubagentSpec,
    caller: AgentPolicyCaller,
  ): { registry: ToolRegistry; receipt: AgentToolPolicyReceipt } {
    const names = new Set(spec.definition.tools.allow)
    for (const definition of this.parentRegistry.getDefinitions()) {
      const tool = this.parentRegistry.get(definition.name)
      if (tool && allowedMcpTool(spec, definition.name, tool))
        names.add(definition.name)
    }
    const registry = new ToolRegistry()
    for (const name of names) {
      const tool = this.parentRegistry.get(name)
      if (tool) registry.register(new AgentPolicyTool(tool, spec))
    }
    const receipt: AgentToolPolicyReceipt = Object.freeze({
      version: 1,
      caller,
      agentName: spec.name,
      definitionRevision: spec.revision,
      toolNames: Object.freeze(
        registry.getDefinitions().map((definition) => definition.name),
      ) as unknown as string[],
      skills: Object.freeze([
        ...spec.definition.skills.allow,
      ]) as unknown as string[],
      mcpServers: Object.freeze([
        ...spec.definition.mcp.servers,
      ]) as unknown as string[],
      sandbox: Object.freeze({ ...spec.definition.sandbox }),
    })
    return { registry, receipt }
  }
}

class AgentPolicyTool extends Tool {
  override readonly name: string
  override readonly description: string
  override readonly parameters: ToolParamsSchema

  constructor(
    private readonly delegate: Tool,
    private readonly spec: SubagentSpec,
  ) {
    super()
    this.name = delegate.name
    this.description = delegate.description
    this.parameters = delegate.parameters
    this.readOnly = delegate.readOnly
    this.exclusive = delegate.exclusive
    this.requiresRuntimeContext = delegate.requiresRuntimeContext
    this.maxResultChars = delegate.maxResultChars
    this.concurrencySafe = delegate.concurrencySafe
    this.workspaceMutation = delegate.workspaceMutation
    this.domainStateMutation = delegate.domainStateMutation
    this.evidencePolicy = delegate.evidencePolicy
    this.classifiesStringErrors = delegate.classifiesStringErrors
    this.externalContent = delegate.externalContent
    this.capabilityProvenance = structuredClone(delegate.capabilityProvenance)
  }

  override isReadOnly(args: Record<string, unknown>): boolean {
    return this.delegate.isReadOnly(args)
  }

  override isDestructive(args?: Record<string, unknown>): boolean {
    return this.delegate.isDestructive(args)
  }

  override isConcurrencySafe(args?: Record<string, unknown>): boolean {
    return this.delegate.isConcurrencySafe(args)
  }

  override mutatesWorkspace(args: Record<string, unknown>): boolean {
    return this.delegate.mutatesWorkspace(args)
  }

  override getPath(args: Record<string, unknown>): string | null {
    return this.delegate.getPath?.(args) ?? null
  }

  override getPaths(args: Record<string, unknown>): string[] {
    if (this.delegate.getPaths) return this.delegate.getPaths(args)
    const path = this.delegate.getPath?.(args)
    return path ? [path] : []
  }

  override execute(
    args: Record<string, unknown>,
    ctx?: ToolExecutionContext,
  ): Promise<ToolExecutionResult> | ToolExecutionResult {
    return (
      agentPolicyDenial(this.delegate, this.spec, args) ??
      this.delegate.execute(args, ctx)
    )
  }

  override mapResult(raw: string, ctx: ToolExecutionContext): ToolResult {
    return this.delegate.mapResult(raw, ctx)
  }
}

function agentPolicyDenial(
  tool: Tool,
  spec: SubagentSpec,
  args: Record<string, unknown>,
): string | null {
  const definition = spec.definition
  if (tool.name === 'Skill') {
    const name = String(args.skill ?? '').trim()
    const allowed = definition.skills.allow
    if (!allowed.includes('*') && !allowed.includes(name))
      return `[ERR] AgentDefinition denied Skill: ${safePolicyLabel(name)}`
  }
  if (isMcpTool(tool.name) && !allowedMcpTool(spec, tool.name, tool))
    return `[ERR] AgentDefinition denied MCP tool: ${safePolicyLabel(tool.name)}`
  if (definition.sandbox.process === 'deny' && tool.name === 'run_command')
    return '[ERR] AgentDefinition sandbox denied process execution'
  if (
    definition.sandbox.network === 'deny' &&
    (tool.name === 'web_fetch' || isMcpTool(tool.name))
  )
    return `[ERR] AgentDefinition sandbox denied network tool: ${safePolicyLabel(tool.name)}`
  if (definition.sandbox.filesystem === 'read-only' && tool.isDestructive(args))
    return `[ERR] AgentDefinition read-only sandbox denied destructive tool: ${safePolicyLabel(tool.name)}`
  return null
}

function allowedMcpTool(
  spec: SubagentSpec,
  toolName: string,
  tool?: Tool,
): boolean {
  if (!isMcpTool(toolName)) return false
  const exactServer = String(
    (tool as { mcpServerName?: unknown } | undefined)?.mcpServerName ?? '',
  ).trim()
  if (exactServer) return spec.definition.mcp.servers.includes(exactServer)
  return spec.definition.mcp.servers.some((server) =>
    toolName.startsWith(`mcp_${server}_`),
  )
}

function isMcpTool(toolName: string): boolean {
  return toolName.startsWith('mcp_')
}

function safePolicyLabel(value: string): string {
  const cleaned = String(value ?? '')
    .replace(/[^A-Za-z0-9_.:-]/g, '_')
    .slice(0, 128)
  return cleaned || 'unknown'
}
