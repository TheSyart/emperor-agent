import { describe, expect, it } from 'vitest'
import { Tool } from './base'
import { ToolRegistry } from './registry'
import { toolParamsSchema } from './schema'

class CapabilityProbeTool extends Tool {
  readonly name: string
  readonly description = 'Capability conformance probe.'
  readonly parameters = toolParamsSchema({})

  constructor(name: string) {
    super()
    this.name = name
  }

  execute(): string {
    return 'ok'
  }
}

describe('ToolCapabilityDescriptor registration conformance', () => {
  it('derives a stable descriptor from the existing Tool API', () => {
    const tool = new CapabilityProbeTool('probe')
    tool.readOnly = true
    tool.evidencePolicy = 'eligible'
    const registry = new ToolRegistry()

    registry.register(tool)

    expect(registry.getCapabilityDescriptor('probe')).toEqual({
      version: 1,
      toolName: 'probe',
      readMode: 'static_read_only',
      mutationScope: 'none',
      concurrency: 'serialized',
      requiresRuntimeContext: false,
      pathAccess: 'none',
      evidencePolicy: 'eligible',
      externalContent: false,
      provenance: { kind: 'core_builtin' },
    })
  })

  it('reports Core-owned state mutation independently from model-facing read-only semantics', () => {
    const tool = new CapabilityProbeTool('complete_state_transition')
    tool.readOnly = true
    tool.domainStateMutation = true
    const registry = new ToolRegistry()

    registry.register(tool)

    expect(
      registry.getCapabilityDescriptor('complete_state_transition'),
    ).toMatchObject({
      readMode: 'static_read_only',
      mutationScope: 'domain',
    })
  })

  it.each([
    {
      name: 'exclusive and concurrency-safe',
      configure(tool: CapabilityProbeTool) {
        tool.exclusive = true
        tool.concurrencySafe = true
      },
      message: /exclusive.*concurrencySafe/i,
    },
    {
      name: 'read-only workspace mutation',
      configure(tool: CapabilityProbeTool) {
        tool.readOnly = true
        tool.workspaceMutation = true
      },
      message: /readOnly.*workspaceMutation/i,
    },
    {
      name: 'workspace and domain mutation',
      configure(tool: CapabilityProbeTool) {
        tool.workspaceMutation = true
        tool.domainStateMutation = true
      },
      message: /workspaceMutation.*domainStateMutation/i,
    },
    {
      name: 'concurrent workspace mutation',
      configure(tool: CapabilityProbeTool) {
        tool.workspaceMutation = true
        tool.concurrencySafe = true
      },
      message: /workspaceMutation.*concurrencySafe/i,
    },
    {
      name: 'eligible external content',
      configure(tool: CapabilityProbeTool) {
        tool.readOnly = true
        tool.externalContent = true
        tool.evidencePolicy = 'eligible'
        tool.capabilityProvenance = {
          kind: 'external_transport',
          transport: 'test',
          source: 'test-fixture',
        }
      },
      message: /external content.*context_only/i,
    },
  ])(
    'rejects $name before the tool becomes visible',
    ({ configure, message }) => {
      const tool = new CapabilityProbeTool('contradiction')
      configure(tool)
      const registry = new ToolRegistry()

      expect(() => registry.register(tool)).toThrow(message)
      expect(registry.has(tool.name)).toBe(false)
    },
  )

  it('requires explicit MCP declaration provenance and keeps unknown read-only false', () => {
    const missing = new CapabilityProbeTool('mcp_alpha_search')
    missing.externalContent = true
    const registry = new ToolRegistry()

    expect(() => registry.register(missing)).toThrow(/MCP.*provenance/i)

    const declared = new CapabilityProbeTool('mcp_alpha_search')
    declared.externalContent = true
    declared.evidencePolicy = 'context_only'
    declared.capabilityProvenance = {
      kind: 'mcp_declaration',
      serverName: 'alpha',
      toolName: 'search',
      transport: 'stdio',
      readOnlySource: 'fallback_write',
      exclusiveSource: 'fallback_serialized',
      generation: null,
      clientId: null,
    }
    registry.register(declared)

    expect(registry.getCapabilityDescriptor(declared.name)).toMatchObject({
      readMode: 'mutating',
      provenance: {
        kind: 'mcp_declaration',
        readOnlySource: 'fallback_write',
        generation: null,
      },
    })
  })
})
