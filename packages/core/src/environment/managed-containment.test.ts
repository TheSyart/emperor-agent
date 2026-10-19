// SEC-08 test 9: the managed environment installer downloads and unpacks in
// process, then runs the recipe's commands through the same containment as
// the Shell: the install target, the plan folder and the tool's data folder
// are writable, nothing else is. Without a sandbox nothing runs.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { OwnedProcessRuntime } from '../processes/runtime'
import { ContainmentBackend } from '../sandbox/policy'
import { SkillManager } from '../skills/manager'
import { ManagedEnvironmentService } from './managed'
import { OsSandboxController } from './sandbox'
import { ExecutionEnvironment } from './snapshot'

function tmp(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)))
}

/** A portable tool whose `--version` also tries to escape. */
function portableArchive(home: string, workspace: string): Buffer {
  return zip([
    {
      name: 'portable/emperor-environment.json',
      data: JSON.stringify({
        schemaVersion: 1,
        toolId: 'portable-tool',
        version: '7.0.0',
        publisher: 'Acme',
        license: 'MIT',
        commands: { portable: 'bin/portable' },
        dataRoot: { mode: 'managed', env: 'PORTABLE_HOME' },
      }),
    },
    {
      name: 'portable/bin/portable',
      data: [
        '#!/bin/sh',
        `echo escaped > "${home}/escaped.txt" 2>/dev/null`,
        `echo escaped > "${workspace}/escaped.txt" 2>/dev/null`,
        'echo ok > "$PORTABLE_HOME/data.txt"',
        'echo "$TMPDIR" > "$PORTABLE_HOME/tmpdir.txt"',
        'echo "portable 7.0.0"',
        '',
      ].join('\n'),
    },
  ])
}

function setup(backend?: ContainmentBackend) {
  const root = tmp('emperor-sec08-installer-')
  const home = join(root, 'home')
  const workspace = join(root, 'ws')
  const stateRoot = join(home, '.emperor')
  const runtimeRoot = join(root, 'runtime')
  for (const dir of [home, workspace, stateRoot, runtimeRoot])
    mkdirSync(dir, { recursive: true })
  const runtime = new OwnedProcessRuntime(stateRoot, {
    sandbox: new OsSandboxController(backend ? { backend } : {}),
  })
  const service = new ManagedEnvironmentService({
    stateRoot,
    skillManager: new SkillManager({ stateRoot, runtimeRoot }),
    downloader: {
      async download(request) {
        writeFileSync(request.destination, portableArchive(home, workspace))
      },
    },
    processRunner: runtime,
    idFactory: () => 'managed_plan_eeeeeeeeeeeeeeee',
  })
  const env = { PATH: '/usr/bin:/bin', HOME: home }
  const environment = new ExecutionEnvironment(
    {
      revision: 'a'.repeat(64),
      catalogRevision: 'b'.repeat(64),
      projectFingerprint: 'c'.repeat(64),
      createdAt: '2026-10-19T06:00:00.000Z',
      platform: 'darwin',
      pathEntries: ['/usr/bin', '/bin'],
      env,
      toolPaths: {},
    },
    env,
  )
  return { root, home, workspace, stateRoot, service, environment }
}

async function install(f: ReturnType<typeof setup>) {
  const preview = await f.service.previewInstall({
    source: {
      kind: 'url',
      value: 'https://example.com/portable-tool-7.0.0.zip',
    },
    sessionId: 'session-01',
  })
  return await f.service.confirmInstall({
    planId: preview.planId,
    digest: preview.digest,
    sessionId: 'session-01',
    permissionConfirmed: true,
    executionEnvironment: f.environment,
  })
}

function receipts(stateRoot: string): Array<Record<string, any>> {
  const file = join(stateRoot, 'processes', 'receipts.v1.json')
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : []
}

describe('the environment installer in the process sandbox (SEC-08 test 9)', () => {
  it.runIf(process.platform === 'darwin')(
    'downloads, unpacks and verifies a tool with its commands contained',
    async () => {
      const f = setup()
      await expect(install(f)).resolves.toMatchObject({
        toolId: 'portable-tool',
        version: '7.0.0',
        placement: 'managed',
        status: 'active',
      })
      const runs = receipts(f.stateRoot).filter(
        (item) => item.owner.kind === 'environment',
      )
      expect(runs.length).toBeGreaterThan(0)
      for (const run of runs)
        expect(run.containment).toMatchObject({
          backend: 'seatbelt',
          decision: 'contained',
        })
      expect(runs[0]!.executionBoundary).toMatchObject({
        kind: 'sandbox',
        authorization: { kind: 'managed_environment_install' },
      })
      const dataRoot = join(f.stateRoot, 'environment', 'data', 'portable-tool')
      expect(readFileSync(join(dataRoot, 'data.txt'), 'utf8')).toBe('ok\n')
      expect(
        readFileSync(join(dataRoot, 'tmpdir.txt'), 'utf8').trim(),
      ).toContain(join(f.stateRoot, 'environment', 'jobs', 'managed'))
      expect(existsSync(join(f.home, 'escaped.txt'))).toBe(false)
      expect(existsSync(join(f.workspace, 'escaped.txt'))).toBe(false)
    },
    30_000,
  )

  it('runs nothing when the sandbox is unavailable', async () => {
    const f = setup(
      new ContainmentBackend({
        platform: 'darwin',
        probe: () => ({ ok: false, detail: 'mock: unavailable' }),
      }),
    )
    await expect(install(f)).rejects.toThrow(/managed install process failed/)
    expect(
      receipts(f.stateRoot)
        .filter((item) => item.owner.kind === 'environment')
        .map((item) => item.containment.decision),
    ).toEqual(['refused'])
    expect(
      existsSync(
        join(f.stateRoot, 'environment', 'data', 'portable-tool', 'data.txt'),
      ),
    ).toBe(false)
  })
})

function zip(entries: Array<{ name: string; data: string | Buffer }>): Buffer {
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let localOffset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const data = Buffer.from(entry.data)
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.byteLength, 18)
    local.writeUInt32LE(data.byteLength, 22)
    local.writeUInt16LE(name.byteLength, 26)
    localParts.push(local, name, data)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(0x031e, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.byteLength, 20)
    central.writeUInt32LE(data.byteLength, 24)
    central.writeUInt16LE(name.byteLength, 28)
    central.writeUInt32LE((0o100755 << 16) >>> 0, 38)
    central.writeUInt32LE(localOffset, 42)
    centralParts.push(central, name)
    localOffset += local.byteLength + name.byteLength + data.byteLength
  }
  const centralSize = centralParts.reduce(
    (total, part) => total + part.byteLength,
    0,
  )
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(localOffset, 16)
  return Buffer.concat([...localParts, ...centralParts, end])
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff
  for (const byte of data) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1)
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}
