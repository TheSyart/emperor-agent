import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { SkillInstallPreview, SkillInstallResult } from '../skills/install'
import { SkillManager } from '../skills/manager'
import { InstallSkillTool, type NativeSkillInstallHost } from './install-skill'

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

describe('InstallSkillTool', () => {
  it('binds preview and confirm to Runner-issued capabilities and the current user Skill root', async () => {
    const stateRoot = tmp('emperor-install-skill-tool-')
    const runtimeRoot = join(stateRoot, 'runtime')
    mkdirSync(runtimeRoot)
    const manager = new SkillManager({ stateRoot, runtimeRoot })
    const preview: SkillInstallPreview = {
      previewId: 'preview_aaaaaaaaaaaaaaaaaaaaaaaa',
      createdAt: '2026-08-10T00:00:00.000Z',
      expiresAt: '2026-08-10T00:10:00.000Z',
      source: {
        kind: 'github_repo',
        path: null,
        resolvedUrl: `https://codeload.github.com/acme/repo/zip/${'a'.repeat(40)}`,
        repository: 'acme/repo',
        ref: 'a'.repeat(40),
        requestedPath: null,
      },
      digest: 'b'.repeat(64),
      archiveBytes: 100,
      unpackedBytes: 200,
      fileCount: 1,
      candidates: [],
    }
    const result: SkillInstallResult = {
      name: 'native-skill',
      status: 'active',
      digest: preview.digest,
      source: preview.source,
      missing: { bins: [], runtimes: [], env: [] },
      installedAt: '2026-08-10T00:01:00.000Z',
    }
    const host: NativeSkillInstallHost = {
      previewInstall: vi.fn(async () => preview),
      confirmInstall: vi.fn(async () => {
        const target = join(stateRoot, 'skills', result.name)
        mkdirSync(target, { recursive: true })
        writeFileSync(
          join(target, 'SKILL.md'),
          '---\nname: native-skill\ndescription: Native install\n---\n',
        )
        return result
      }),
    }
    let refreshes = 0
    const tool = new InstallSkillTool(host, manager, () => {
      refreshes += 1
    })
    const previewArgs = {
      action: 'preview',
      source: {
        kind: 'url',
        value: 'https://github.com/acme/repo',
      },
    }

    const unauthorized = await tool.execute(previewArgs)
    expect(
      typeof unauthorized === 'string' ? unauthorized : unauthorized.isError,
    ).toBeTruthy()

    const previewOutput = await tool.execute(previewArgs, {
      root: stateRoot,
      arguments: previewArgs,
      managedPathCapability: tool.issueManagedPathCapability(previewArgs),
    })
    expect(
      typeof previewOutput === 'string' ? previewOutput : previewOutput.isError,
    ).toBe(false)
    expect(host.previewInstall).toHaveBeenCalledWith({
      source: { kind: 'url', url: 'https://github.com/acme/repo' },
    })

    const confirmArgs = {
      action: 'confirm',
      previewId: preview.previewId,
      digest: preview.digest,
    }
    const changedArgs = { ...confirmArgs, digest: 'c'.repeat(64) }
    const staleCapability = tool.issueManagedPathCapability(confirmArgs)
    const stale = await tool.execute(changedArgs, {
      root: stateRoot,
      arguments: changedArgs,
      managedPathCapability: staleCapability,
    })
    expect(typeof stale === 'string' ? stale : stale.isError).toBeTruthy()

    const installed = await tool.execute(confirmArgs, {
      root: stateRoot,
      arguments: confirmArgs,
      managedPathCapability: tool.issueManagedPathCapability(confirmArgs),
    })
    expect(typeof installed === 'string' ? installed : installed.isError).toBe(
      false,
    )
    const payload = JSON.parse(
      typeof installed === 'string' ? installed : installed.modelContent,
    )
    expect(payload).toMatchObject({
      name: 'native-skill',
      status: 'active',
      sourceScope: 'user',
      target: 'skills/native-skill',
      readOnly: false,
    })
    expect(host.confirmInstall).toHaveBeenCalledWith({
      previewId: preview.previewId,
      digest: preview.digest,
      permissionConfirmed: true,
    })
    expect(refreshes).toBe(1)
    expect(tool.parameters.properties).not.toHaveProperty('scope')
    expect(tool.parameters.properties).not.toHaveProperty('target')
    expect(tool.parameters.properties).not.toHaveProperty('permissionConfirmed')
  })
})
