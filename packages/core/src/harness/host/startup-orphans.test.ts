// KRN-13 (finding CORE-42): a process group a crashed Emperor left behind is
// cleaned up when the host starts — only when the live process is provably
// the one the receipt names (same boot, same start identity); a reused PID
// is never killed.
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LlmClient } from '../../llm/client'
import type { OwnedProcessReceipt } from '../../processes/runtime'
import {
  pidIsAlive,
  stableProcessStartIdentity,
  systemBootMarker,
} from '../../util/stable-process-identity'
import type { SandboxBackend } from '../sandbox/backend'
import { ScriptedAdapter, testRoute } from '../testing'
import { HarnessHost } from './host'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

const passthrough: SandboxBackend = {
  confine: (argv) => ({
    argv: [...argv],
    enforcement: 'full',
    denialSignatures: [],
    runnerFailureRules: [],
  }),
}

/** A detached process group that outlives its parent, like a crashed run's child. */
function leftover(): number {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
  const pid = child.pid!
  cleanups.push(() => {
    if (!pidIsAlive(pid)) return
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      // Already gone.
    }
  })
  return pid
}

function receipt(
  id: string,
  pid: number,
  identity: OwnedProcessReceipt['processStartIdentity'],
): OwnedProcessReceipt {
  return {
    schemaVersion: 1,
    id,
    owner: { kind: 'session', id: 'session-a', sessionId: 'session-a' },
    lease: {
      id: `${id}_lease`,
      revision: 1,
      acquiredAt: '2026-10-20T00:00:00.000Z',
    },
    commandDigest: 'a'.repeat(64),
    cwdCapability: {
      access: 'execute',
      cwdDigest: 'b'.repeat(64),
      workspaceRootDigest: 'c'.repeat(64),
      withinWorkspace: true,
    },
    containment: {
      decision: 'contained',
      backend: 'seatbelt',
      policyHash: 'd'.repeat(64),
      reason: '',
    },
    outputQuota: {
      maxBytes: 1_024,
      strategy: 'terminate',
      scope: 'combined',
      observedBytes: 0,
      capturedBytes: 0,
      exceeded: false,
    },
    status: 'running',
    pid,
    bootMarker: systemBootMarker(),
    processStartIdentity: identity,
    startedAt: '2026-10-20T00:00:00.000Z',
    finishedAt: null,
    exitCode: null,
    signal: null,
    terminalReason: null,
  } as OwnedProcessReceipt
}

async function startHost(home: string): Promise<HarnessHost> {
  const llm = new LlmClient({ adapterFor: () => new ScriptedAdapter([]) })
  llm.setRoutes([testRoute()], 'test-route')
  const host = await HarnessHost.create({
    root: home,
    stateRoot: join(home, 'home'),
    stateRootSource: 'explicit',
    emperorHomePrepared: false,
    llm,
    sandboxBackend: passthrough,
    initializeMcp: false,
    startScheduler: false,
    watchSkills: false,
  })
  cleanups.push(() => host.close())
  return host
}

/** The start identity of some other process that once had this PID. */
function anotherProcess(
  identity: NonNullable<OwnedProcessReceipt['processStartIdentity']>,
): OwnedProcessReceipt['processStartIdentity'] {
  return identity.kind === 'darwin_boot_relative_interval'
    ? {
        ...identity,
        minSeconds: identity.minSeconds - 86_400,
        maxSeconds: identity.maxSeconds - 86_400,
      }
    : { ...identity, value: `${identity.value}0` }
}

describe.skipIf(process.platform === 'win32')(
  'leftover processes at startup (KRN-13)',
  () => {
    it('4 · a process group a crashed run left is cleaned up when the host starts', async () => {
      const root = mkdtempSync(join(tmpdir(), 'emperor-krn13-orphan-'))
      const pid = leftover()
      const identity = stableProcessStartIdentity(pid, systemBootMarker())
      expect(identity).toBeTruthy()
      mkdirSync(join(root, 'home', 'processes'), { recursive: true })
      writeFileSync(
        join(root, 'home', 'processes', 'receipts.v1.json'),
        JSON.stringify([receipt('process_left', pid, identity)]),
      )
      const host = await startHost(root)
      expect(pidIsAlive(pid)).toBe(false)
      expect(host.kept.processRuntime.get('process_left')).toMatchObject({
        status: 'orphan_reaped',
      })
    }, 30_000)

    it('5 · a reused PID whose start identity differs is left alone', async () => {
      const root = mkdtempSync(join(tmpdir(), 'emperor-krn13-reused-'))
      const pid = leftover()
      const identity = stableProcessStartIdentity(pid, systemBootMarker())!
      mkdirSync(join(root, 'home', 'processes'), { recursive: true })
      writeFileSync(
        join(root, 'home', 'processes', 'receipts.v1.json'),
        JSON.stringify([
          receipt('process_reused', pid, anotherProcess(identity)),
        ]),
      )
      const host = await startHost(root)
      expect(pidIsAlive(pid)).toBe(true)
      expect(host.kept.processRuntime.get('process_reused')).toMatchObject({
        status: 'interrupted',
      })
    }, 30_000)
  },
)
