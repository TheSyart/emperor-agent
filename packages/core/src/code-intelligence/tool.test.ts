import { describe, expect, it, vi } from 'vitest'
import type { ToolExecutionContext } from '../tools/base'
import { CodeIntelligenceTool } from './tool'

describe('CodeIntelligenceTool', () => {
  it('takes workspace/session scope only from trusted runtime context', async () => {
    const query = vi.fn(async () => ({
      operation: 'find_definitions' as const,
      strategy: 'graph' as const,
      symbol: 'alpha',
      locations: [],
      fallbackReason: null,
      truncated: false,
      complete: true,
      limitations: [],
    }))
    const tool = new CodeIntelligenceTool({ query }, (ctx) =>
      ctx.sessionId === 'build-a'
        ? { workspaceRoot: '/trusted/project', sessionId: 'build-a' }
        : null,
    )
    const ctx = context({
      sessionId: 'build-a',
      workspaceRoot: '/untrusted/argument',
    })
    const result = await tool.execute(
      {
        operation: 'find_definitions',
        symbol: 'alpha',
        workspaceRoot: '/attacker/project',
      },
      ctx,
    )

    expect(query).toHaveBeenCalledWith(
      { operation: 'find_definitions', symbol: 'alpha' },
      {
        workspaceRoot: '/trusted/project',
        sessionId: 'build-a',
        signal: null,
      },
    )
    expect(JSON.parse(String(result))).toMatchObject({ strategy: 'graph' })
  })

  it('rejects chat/unbound sessions and invalid operation-specific arguments', async () => {
    const tool = new CodeIntelligenceTool({ query: vi.fn() }, () => null)
    await expect(
      tool.execute(
        { operation: 'find_definitions', symbol: 'alpha' },
        context({ sessionId: 'chat-a' }),
      ),
    ).resolves.toMatch(/Build session/i)

    const buildTool = new CodeIntelligenceTool({ query: vi.fn() }, () => ({
      workspaceRoot: '/project',
      sessionId: 'build-a',
    }))
    await expect(
      buildTool.execute(
        { operation: 'go_to_definition', path: '../escape.ts', line: 0 },
        context({ sessionId: 'build-a' }),
      ),
    ).resolves.toMatch(/^\[ERR\]/)
  })
})

function context(
  overrides: Partial<ToolExecutionContext> = {},
): ToolExecutionContext {
  return {
    root: '/runtime',
    workspaceRoot: '/project',
    arguments: {},
    sessionId: 'build-a',
    signal: null,
    ...overrides,
  }
}
