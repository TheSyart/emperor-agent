import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EffectiveCodeIntelligenceCapability } from './capability'
import { CodeIntelligenceService } from './service'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

async function fixture(): Promise<{
  workspaceRoot: string
  stateRoot: string
  filePath: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'emperor-ci-service-'))
  roots.push(root)
  const workspaceRoot = join(root, 'workspace')
  const stateRoot = join(root, 'state')
  const filePath = join(workspaceRoot, 'src', 'a.ts')
  await mkdir(dirname(filePath), { recursive: true })
  await mkdir(stateRoot, { recursive: true })
  await writeFile(
    filePath,
    'export function alpha() { return 1 }\nexport const caller = alpha()\n',
  )
  return { workspaceRoot, stateRoot, filePath }
}

describe('CodeIntelligenceService', () => {
  it('keeps off mode inert and blocks user queries without creating graph state', async () => {
    const { workspaceRoot, stateRoot } = await fixture()
    const service = new CodeIntelligenceService({
      stateRoot,
      capability: capability('off', false),
      processRuntime: null,
      lspDescriptors: [],
    })

    await expect(
      service.query(
        { operation: 'find_definitions', symbol: 'alpha' },
        { workspaceRoot, sessionId: 'session-a' },
      ),
    ).rejects.toThrow(/disabled/i)
    expect(service.diagnostics()).toMatchObject({
      capability: { effectiveMode: 'off', toolAllowed: false },
      graphManagers: 0,
      queries: 0,
    })
  })

  it('returns bounded real graph definitions/references and refreshes external edits', async () => {
    const { workspaceRoot, stateRoot, filePath } = await fixture()
    const service = new CodeIntelligenceService({
      stateRoot,
      capability: capability('on', true),
      processRuntime: null,
      lspDescriptors: [],
    })
    const context = { workspaceRoot, sessionId: 'session-a' }

    await expect(
      service.query(
        { operation: 'find_definitions', symbol: 'alpha' },
        context,
      ),
    ).resolves.toMatchObject({
      strategy: 'graph',
      symbol: 'alpha',
      locations: [{ path: 'src/a.ts', line: 1, kind: 'function' }],
    })
    await expect(
      service.query({ operation: 'find_references', symbol: 'alpha' }, context),
    ).resolves.toMatchObject({
      strategy: 'graph',
      locations: [{ path: 'src/a.ts', line: 2, kind: 'reference' }],
    })

    await new Promise((resolve) => setTimeout(resolve, 2))
    await writeFile(
      filePath,
      'export function beta() { return 2 }\nexport const caller = beta()\n',
    )
    await expect(
      service.query({ operation: 'find_definitions', symbol: 'beta' }, context),
    ).resolves.toMatchObject({
      strategy: 'graph',
      symbol: 'beta',
      locations: [{ path: 'src/a.ts', line: 1 }],
    })
    expect(service.diagnostics()).toMatchObject({
      graphManagers: 1,
      queries: 3,
      graph: { indexedFiles: 1, parserLoads: 1 },
    })
    await service.close()
  })

  it('applies managed file events only to an existing workspace actor', async () => {
    const { workspaceRoot, stateRoot, filePath } = await fixture()
    const service = new CodeIntelligenceService({
      stateRoot,
      capability: capability('on', true),
      processRuntime: null,
      lspDescriptors: [],
    })
    const context = { workspaceRoot, sessionId: 'session-a' }
    await service.notify([{ kind: 'modified', path: filePath }], context)
    expect(service.diagnostics().graphManagers).toBe(0)

    await service.query(
      { operation: 'find_definitions', symbol: 'alpha' },
      context,
    )
    await writeFile(filePath, 'export const gamma = 3\n')
    await service.notify([{ kind: 'modified', path: filePath }], context)
    await expect(
      service.query(
        { operation: 'find_definitions', symbol: 'gamma' },
        context,
      ),
    ).resolves.toMatchObject({ locations: [{ path: 'src/a.ts' }] })
  })

  it('prefers LSP for position queries and safely normalizes workspace locations', async () => {
    const { workspaceRoot, stateRoot, filePath } = await fixture()
    const lsp = fakeLsp({
      requestResult: [
        {
          uri: new URL(`file://${filePath}`).href,
          range: {
            start: { line: 0, character: 16 },
            end: { line: 0, character: 21 },
          },
        },
        {
          uri: 'file:///outside/secret.ts',
          range: { start: { line: 0, character: 0 } },
        },
      ],
    })
    const service = new CodeIntelligenceService({
      stateRoot,
      capability: capability('on', true),
      processRuntime: null,
      lspDescriptors: [],
      lspSupervisor: lsp,
    })

    await expect(
      service.query(
        {
          operation: 'go_to_definition',
          path: 'src/a.ts',
          line: 2,
          column: 23,
        },
        { workspaceRoot, sessionId: 'session-a' },
      ),
    ).resolves.toMatchObject({
      strategy: 'lsp',
      locations: [{ path: 'src/a.ts', line: 1, column: 17, kind: 'reference' }],
    })
    expect(lsp.syncDocument).toHaveBeenCalledOnce()
    expect(lsp.request).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'textDocument/definition' }),
    )
  })

  it('falls back to the graph with a stable reason when optional LSP fails', async () => {
    const { workspaceRoot, stateRoot } = await fixture()
    const lsp = fakeLsp({ requestError: new Error('/secret/server crashed') })
    const service = new CodeIntelligenceService({
      stateRoot,
      capability: capability('on', true),
      processRuntime: null,
      lspDescriptors: [],
      lspSupervisor: lsp,
    })

    const result = await service.query(
      {
        operation: 'go_to_definition',
        path: 'src/a.ts',
        line: 2,
        column: 24,
      },
      { workspaceRoot, sessionId: 'session-a' },
    )
    expect(result).toMatchObject({
      strategy: 'graph_fallback',
      fallbackReason: 'lsp_failed',
      symbol: 'alpha',
      locations: [{ path: 'src/a.ts', line: 1 }],
    })
    expect(JSON.stringify(result)).not.toContain('/secret')
  })

  it('closes session LSP ownership separately from shared graph actors', async () => {
    const { workspaceRoot, stateRoot } = await fixture()
    const lsp = fakeLsp({ requestResult: [] })
    const service = new CodeIntelligenceService({
      stateRoot,
      capability: capability('on', true),
      processRuntime: null,
      lspDescriptors: [],
      lspSupervisor: lsp,
    })
    await service.query(
      {
        operation: 'go_to_definition',
        path: 'src/a.ts',
        line: 2,
        column: 24,
      },
      { workspaceRoot, sessionId: 'session-a' },
    )

    await service.closeSession('session-a')
    expect(lsp.stopSession).toHaveBeenCalledWith('session-a')
    expect(service.diagnostics().graphManagers).toBe(1)
    await service.close()
    expect(lsp.close).toHaveBeenCalledOnce()
  })
})

function capability(
  effectiveMode: 'off' | 'eval' | 'on',
  toolAllowed: boolean,
): EffectiveCodeIntelligenceCapability {
  return {
    requestedMode: effectiveMode,
    effectiveMode,
    toolAllowed,
    reason:
      effectiveMode === 'off'
        ? 'config_off'
        : effectiveMode === 'eval'
          ? 'evaluation_only'
          : 'enabled',
    evaluationDatasetSha256: toolAllowed ? 'a'.repeat(64) : null,
    parserRevision: 'typescript-5.9-code-graph-v1',
  }
}

function fakeLsp(opts: { requestResult?: unknown; requestError?: Error }) {
  return {
    syncDocument: vi.fn(async () => undefined),
    request: vi.fn(async () => {
      if (opts.requestError) throw opts.requestError
      return opts.requestResult
    }),
    diagnostics: vi.fn(() => []),
    stopSession: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  }
}
