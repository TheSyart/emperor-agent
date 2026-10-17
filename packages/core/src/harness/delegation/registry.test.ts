import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  chmodSync,
  mkdirSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultExecutorConfig } from './config'
import { ExecutorRegistry } from './registry'

const roots: string[] = []
afterEach(() =>
  roots
    .splice(0)
    .forEach((root) => rmSync(root, { recursive: true, force: true })),
)
function fixture(version = '0.153.4') {
  const root = mkdtempSync(join(tmpdir(), 'emperor-registry-'))
  roots.push(root)
  const executablePath = join(root, 'codex with spaces')
  writeFileSync(
    executablePath,
    '#!/bin/sh\nprintf "codex-cli ' + version + '\\n"\n',
  )
  chmodSync(executablePath, 0o700)
  const profile = {
    ...defaultExecutorConfig().profiles[1]!,
    enabled: true,
    executablePath,
  }
  return { root, executablePath, profile }
}
describe('executor registry', () => {
  it('discovers local user executables when launched with a GUI-only PATH', async () => {
    const { root, profile } = fixture()
    const bin = join(root, '.local', 'bin')
    mkdirSync(bin, { recursive: true })
    const name = 'emperor-fixture-cli'
    writeFileSync(
      join(bin, name),
      '#!/bin/sh\nprintf "codex-cli 0.153.4\\n"\n',
      { mode: 0o700 },
    )
    const registry = new ExecutorRegistry({
      home: root,
      environment: { PATH: '/usr/bin:/bin' },
    })
    expect(
      (await registry.probe({ ...profile, executablePath: name })).status,
    ).toBe('available')
    expect(
      (
        await registry.probe({
          ...profile,
          executablePath: join(root, 'missing', name),
        })
      ).status,
    ).toBe('missing')
  })
  it('cannot opt into an unsupported protocol by changing expectedVersion to match the binary', async () => {
    const { profile } = fixture('0.999.0')
    expect(
      (
        await new ExecutorRegistry().probe({
          ...profile,
          expectedVersion: '0.999.0',
        })
      ).status,
    ).toBe('incompatible')
  })
  it('pins the exact checked-in schema bytes in the protocol manifest', () => {
    const root = join(__dirname, 'protocol/codex-0.153.4')
    const manifest = JSON.parse(
      readFileSync(join(root, 'manifest.json'), 'utf8'),
    )
    for (const [name, digest] of Object.entries(manifest.sha256))
      expect(
        createHash('sha256')
          .update(readFileSync(join(root, name)))
          .digest('hex'),
      ).toBe(digest)
  })
  it('reports an exact version without claiming authenticated inference', async () => {
    const { profile } = fixture()
    const result = await new ExecutorRegistry().probe(profile)
    expect(result).toMatchObject({
      status: 'available',
      executableVersion: '0.153.4',
      authVerified: false,
    })
  })
  it('declares capabilities by backend instead of assuming identical control', async () => {
    const { profile } = fixture()
    const registry = new ExecutorRegistry()
    expect((await registry.probe(profile)).capabilities.steer).toBe(true)
    expect(registry.capabilities('claude-code').steer).toBe(false)
  })
  it('never spawns a disabled profile', async () => {
    const { profile } = fixture()
    const registry = new ExecutorRegistry()
    await expect(
      registry.requireAvailable({ ...profile, enabled: false }),
    ).rejects.toThrow(/EXECUTOR_DISABLED/)
  })
  it('passes a spaced executable as one argv path', async () => {
    const { profile } = fixture()
    expect((await new ExecutorRegistry().probe(profile)).status).toBe(
      'available',
    )
  })
  it('does not reuse a cached available result after binary replacement', async () => {
    const { profile, executablePath } = fixture()
    const registry = new ExecutorRegistry()
    expect((await registry.probe(profile)).status).toBe('available')
    writeFileSync(executablePath, '#!/bin/sh\nprintf "codex-cli 0.999.0\\n"\n')
    expect((await registry.probe(profile)).status).toBe('incompatible')
  })
  it('reports a missing executable without starting a model', async () => {
    const { profile } = fixture()
    const result = await new ExecutorRegistry().probe({
      ...profile,
      executablePath: '/no/such/executor',
    })
    expect(result).toMatchObject({ status: 'missing', authVerified: false })
  })
})
