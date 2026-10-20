import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ManagedEnvironmentService } from './managed'
import { SkillManager } from '../skills/manager'

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'emperor-managed-service-'))
}

describe('ManagedEnvironmentService', () => {
  it('repairs managed command activation from the registry after an interrupted switch', async () => {
    const stateRoot = tempRoot()
    const runtimeRoot = join(stateRoot, 'runtime')
    mkdirSync(runtimeRoot)
    const skillManager = new SkillManager({ stateRoot, runtimeRoot })
    const executable = join(
      stateRoot,
      'environment',
      'tools',
      'agent-reach',
      '1.2.3-aaaaaaaaaaaa',
      'bin',
      'agent-reach',
    )
    mkdirSync(join(executable, '..'), { recursive: true })
    writeFileSync(executable, '#!/bin/sh\n', { mode: 0o700 })
    const binRoot = join(stateRoot, 'environment', 'bin')
    mkdirSync(binRoot, { recursive: true })
    symlinkSync('/missing/previous-version', join(binRoot, 'agent-reach'))
    writeFileSync(
      join(stateRoot, 'environment', 'registry.v1.json'),
      `${JSON.stringify({
        schemaVersion: 1,
        tools: {
          'agent-reach': {
            toolId: 'agent-reach',
            placement: 'managed',
            activeVersion: '1.2.3',
            activeKey: '1.2.3-aaaaaaaaaaaa',
            sourceDigest: 'a'.repeat(64),
            recipeTrust: 'installed_skill_source',
            dataRootMode: 'external_disclosed',
            dataRootEnvironmentVariable: null,
            commands: { 'agent-reach': 'agent-reach' },
            commandTargets: {
              'agent-reach':
                'tools/agent-reach/1.2.3-aaaaaaaaaaaa/bin/agent-reach',
            },
            versions: {},
            updatedAt: '2026-08-10T06:00:00.000Z',
          },
        },
      })}\n`,
    )
    const service = new ManagedEnvironmentService({
      stateRoot,
      skillManager,
    })

    await service.initialize()

    expect(readlinkSync(join(binRoot, 'agent-reach'))).toBe(executable)
    expect(existsSync(executable)).toBe(true)
  })
})
