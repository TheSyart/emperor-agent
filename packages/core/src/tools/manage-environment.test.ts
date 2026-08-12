import { describe, expect, it, vi } from 'vitest'
import type {
  ManagedEnvironmentInstallPreview,
  ManagedEnvironmentInstallResult,
} from '../environment/managed'
import { ManageEnvironmentTool } from './manage-environment'

describe('ManageEnvironmentTool', () => {
  it('uses Runner-issued authority and never accepts target paths, argv, shell, or permission booleans from the model', async () => {
    const preview: ManagedEnvironmentInstallPreview = {
      planId: 'managed_plan_aaaaaaaaaaaaaaaa',
      createdAt: '2026-08-10T06:00:00.000Z',
      expiresAt: '2026-08-10T06:10:00.000Z',
      digest: 'a'.repeat(64),
      placement: 'managed',
      recipeTrust: 'installed_skill_source',
      source: {
        kind: 'skill',
        value: 'agent-reach',
        resolvedUrl: 'https://example.com/archive.zip',
        digest: 'b'.repeat(64),
        repository: 'Panniantong/agent-reach',
        ref: 'c'.repeat(40),
      },
      estimatedBytes: 100,
      candidates: [
        {
          candidateId: 'candidate_aaaaaaaaaaaaaaaaaaaa',
          relativeRoot: 'repo',
          recipeKind: 'python_venv',
          toolId: 'agent-reach',
          version: '1.2.3',
          publisher: 'Panniantong/agent-reach',
          license: 'MIT',
          entrypoints: ['agent-reach'],
          potentialInstallScripts: [],
          dataRootMode: 'external_disclosed',
          dataRootEnvironmentVariable: null,
          commandEntries: { 'agent-reach': 'agent-reach' },
          placement: 'managed',
          externalCommandAvailable: false,
        },
      ],
    }
    const result: ManagedEnvironmentInstallResult = {
      jobId: 'managed_job_aaaaaaaaaaaaaaaa',
      planId: preview.planId,
      toolId: 'agent-reach',
      version: '1.2.3',
      placement: 'managed',
      status: 'active',
      commands: ['agent-reach'],
      dataRootMode: 'external_disclosed',
      verification: {
        command: 'agent-reach doctor --json',
        exitCode: 0,
        output: '{"status":"ok"}',
      },
      receipt: 'environment/receipts/managed/managed_job_aaaaaaaaaaaaaaaa.json',
    }
    const host = {
      status: vi.fn(async () => ({ schemaVersion: 1, tools: {}, jobs: [] })),
      previewInstall: vi.fn(async () => preview),
      confirmInstall: vi.fn(async () => result),
      cancel: vi.fn(async () => ({ cancelled: true })),
    }
    const tool = new ManageEnvironmentTool('/Users/tester/.emperor', host)
    const previewArgs = {
      action: 'preview_install',
      source: { kind: 'skill', value: 'agent-reach' },
    }

    const unauthorized = await tool.execute(previewArgs)
    expect(
      typeof unauthorized === 'string' ? unauthorized : unauthorized.isError,
    ).toBe(true)

    const previewResult = await tool.execute(previewArgs, {
      root: '/workspace',
      arguments: previewArgs,
      sessionId: 'session-01',
      managedPathCapability: tool.issueManagedPathCapability(previewArgs),
    })
    expect(
      typeof previewResult === 'string' ? previewResult : previewResult.isError,
    ).toBe(false)
    expect(host.previewInstall).toHaveBeenCalledWith({
      source: { kind: 'skill', value: 'agent-reach' },
      sessionId: 'session-01',
      signal: undefined,
      executionEnvironment: undefined,
    })

    const confirmArgs = {
      action: 'confirm_install',
      planId: preview.planId,
      digest: preview.digest,
    }
    const noRuntime = await tool.execute(confirmArgs, {
      root: '/workspace',
      arguments: confirmArgs,
      sessionId: 'session-01',
      managedPathCapability: tool.issueManagedPathCapability(confirmArgs),
    })
    expect(typeof noRuntime === 'string' ? noRuntime : noRuntime.isError).toBe(
      true,
    )
    expect(host.confirmInstall).not.toHaveBeenCalled()

    expect(tool.parameters.properties).not.toHaveProperty('scope')
    expect(tool.parameters.properties).not.toHaveProperty('target')
    expect(tool.parameters.properties).not.toHaveProperty('executable')
    expect(tool.parameters.properties).not.toHaveProperty('args')
    expect(tool.parameters.properties).not.toHaveProperty('shell')
    expect(tool.parameters.properties).not.toHaveProperty('permissionConfirmed')
  })
})
