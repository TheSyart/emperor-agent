// SEC-08 test 10: every contained start — run, refused or run outside the
// sandbox with the user's consent — leaves a ContainmentReceipt in
// processes/receipts.v1.json, and the diagnostics payload lists the recent
// ones (owner, decision, backend, policy hash).
import { mkdtempSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CoreDiagnosticsService } from '../api/services/diagnostics-service'
import { OsSandboxController } from '../environment/sandbox'
import { ContainmentBackend } from '../sandbox/policy'
import { processContainmentPolicy } from '../sandbox/presets'
import { OwnedProcessRuntime } from './runtime'

function tmp(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)))
}

function policy(root: string, fallback: 'refuse' | 'ask-user' = 'refuse') {
  return processContainmentPolicy({
    workspace: { root, access: 'write' },
    stateRoot: null,
    tempDir: root,
    network: 'deny',
    fallback,
    executables: [process.execPath],
  })
}

describe('containment receipts (SEC-08 test 10)', () => {
  it('records contained, refused and user-allowed starts and shows them in diagnostics', async () => {
    const root = tmp('emperor-sec08-receipts-')
    const contained = new OwnedProcessRuntime(root)
    const available = contained.capability().status === 'available'
    if (available) {
      const ran = await contained.run({
        executable: process.execPath,
        args: ['-e', 'process.stdout.write("inside")'],
        cwd: root,
        env: {},
        owner: { kind: 'mcp', id: 'files', sessionId: null },
        execution: { kind: 'sandbox', policy: policy(root) },
      })
      expect(ran).toMatchObject({ status: 'completed', stdout: 'inside' })
    }
    const broken = new OwnedProcessRuntime(root, {
      sandbox: new OsSandboxController({
        backend: new ContainmentBackend({
          platform: 'darwin',
          probe: () => ({ ok: false, detail: 'mock: unavailable' }),
        }),
      }),
    })
    const refused = await broken.run({
      executable: process.execPath,
      args: ['-e', '0'],
      cwd: root,
      env: {},
      owner: { kind: 'hook', id: 'kit', sessionId: 's1' },
      execution: { kind: 'sandbox', policy: policy(root) },
    })
    expect(refused).toMatchObject({
      status: 'containment_unavailable',
      containment: { decision: 'refused', backend: 'none' },
    })
    expect(refused.error).toContain('mock: unavailable')
    const allowed = await broken.run({
      executable: process.execPath,
      args: ['-e', 'process.stdout.write("outside")'],
      cwd: root,
      env: {},
      owner: { kind: 'mcp', id: 'notes', sessionId: null },
      execution: { kind: 'sandbox', policy: policy(root, 'ask-user') },
      consent: { decide: async () => true },
    })
    expect(allowed).toMatchObject({
      status: 'completed',
      stdout: 'outside',
      containment: { decision: 'user-allowed-unsandboxed', backend: 'none' },
    })

    const file = JSON.parse(
      readFileSync(join(root, 'processes', 'receipts.v1.json'), 'utf8'),
    ) as Array<{
      owner: { kind: string; id: string }
      status: string
      containment: Record<string, string>
    }>
    const byId = (id: string) => file.find((item) => item.owner.id === id)
    if (available)
      expect(byId('files')).toMatchObject({
        status: 'completed',
        containment: { backend: 'seatbelt', decision: 'contained' },
      })
    expect(byId('kit')).toMatchObject({
      status: 'refused',
      containment: { decision: 'refused' },
    })
    expect(byId('notes')?.containment).toMatchObject({
      decision: 'user-allowed-unsandboxed',
      policyHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    })

    const diagnostics = await new CoreDiagnosticsService(root, {
      processRuntime: () => broken.capabilityReport(),
    }).payload({ sessionId: null })
    const recent = (
      diagnostics.processRuntime as {
        containment: { recent: Array<Record<string, unknown>> }
      }
    ).containment.recent
    expect(recent[0]).toMatchObject({
      owner: 'mcp',
      id: 'notes',
      decision: 'user-allowed-unsandboxed',
      backend: 'none',
    })
    expect(recent.map((item) => item.id)).toEqual(
      available ? ['notes', 'kit', 'files'] : ['notes', 'kit'],
    )
    expect(String(recent[1]!.policyHash)).toMatch(/^[a-f0-9]{12}$/)
    expect(recent[1]!.reason).toContain('mock: unavailable')
  })
})
