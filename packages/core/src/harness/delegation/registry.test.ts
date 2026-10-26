import {
  cpSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
  chmodSync,
  mkdirSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultExecutorConfig } from './config'
import { ExecutorRegistry } from './registry'
import {
  CLAUDE_SDK_VERSION,
  KNOWN_CODEX_PROTOCOLS,
  codexProtocolDigest,
} from './compatibility'

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
  it('cannot opt into an unsupported protocol through configuration', async () => {
    const { profile } = fixture('0.999.0')
    expect(
      (
        await new ExecutorRegistry().probe({
          ...profile,
          expectedVersion: '0.999.0',
        } as typeof profile)
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

// AGT-01: compatibility comes from a capability handshake, not a pinned
// version string in the user's configuration.
describe('compatibility handshake (AGT-01)', () => {
  const protocolRoot = join(__dirname, 'protocol', 'codex-0.153.4')
  const protocolRoot0163 = join(__dirname, 'protocol', 'codex-0.163.0')
  const protocolRoot0164 = join(__dirname, 'protocol', 'codex-0.164.0')
  function tempRoot() {
    const root = mkdtempSync(join(tmpdir(), 'emperor-handshake-'))
    roots.push(root)
    return root
  }
  function versionScript(root: string, name: string, output: string) {
    const path = join(root, name)
    writeFileSync(path, `#!/bin/sh\nprintf "${output}\\n"\n`, { mode: 0o700 })
    return path
  }
  /** A Codex stand-in: prints its version and writes a schema bundle. */
  function codexScript(root: string, version: string, schema: string) {
    const path = join(root, 'codex-' + version)
    writeFileSync(
      path,
      [
        '#!/bin/sh',
        `if [ "$1" = "--version" ]; then printf "codex-cli ${version}\\n"; exit 0; fi`,
        'if [ "$1" = "app-server" ] && [ "$2" = "generate-json-schema" ] && [ "$3" = "--out" ]; then',
        `  cp -R '${schema}/.' "$4"; exit 0`,
        'fi',
        'exit 2',
        '',
      ].join('\n'),
      { mode: 0o700 },
    )
    return path
  }
  const claudeProfile = () => ({
    ...defaultExecutorConfig().profiles[0]!,
    enabled: true,
  })
  const codexProfile = (executablePath: string) => ({
    ...defaultExecutorConfig().profiles[1]!,
    enabled: true,
    executablePath,
  })

  it('1. runs the installed claude found on PATH or the usual install folders (AGT-12)', async () => {
    const root = tempRoot()
    // A Dock launch: PATH has none of the user's folders; the usual install
    // folders (here ~/.volta/bin, which comes first) are searched too. The
    // login shell's PATH is the last resort (executable.test.ts).
    const bin = join(root, '.volta', 'bin')
    mkdirSync(bin, { recursive: true })
    versionScript(bin, 'claude', '2.1.300 (Claude Code)')
    const registry = new ExecutorRegistry({
      home: root,
      environment: { PATH: '/usr/bin:/bin' },
    })
    expect(await registry.locate(claudeProfile())).toBe(join(bin, 'claude'))
    expect(await registry.probe(claudeProfile())).toMatchObject({
      status: 'available',
      executableVersion: '2.1.300',
    })
  })
  it('2. says claude is not installed when nothing is found, and keeps a named path', async () => {
    const root = tempRoot()
    const missing = await new ExecutorRegistry({
      home: root,
      environment: { PATH: root },
      loginShell: { read: async () => ({}) },
    }).probe({ ...claudeProfile(), executablePath: join(root, 'no-claude') })
    expect(missing).toMatchObject({
      status: 'missing',
      diagnostic: 'claude is not installed',
    })
    const installed = versionScript(root, 'my-claude', '2.1.290 (Claude Code)')
    expect(
      await new ExecutorRegistry({ home: root }).probe({
        ...claudeProfile(),
        executablePath: installed,
      }),
    ).toMatchObject({ status: 'available', executableVersion: '2.1.290' })
  })
  it('3. names the version it needs when the installed claude is too old', async () => {
    const root = tempRoot()
    const installed = versionScript(root, 'claude', '2.1.40 (Claude Code)')
    const probe = await new ExecutorRegistry({ home: root }).probe({
      ...claudeProfile(),
      executablePath: installed,
    })
    expect(probe).toMatchObject({
      status: 'incompatible',
      executableVersion: '2.1.40',
      requiredVersion: '>= 2.1.79',
    })
    expect(probe.diagnostic).toContain('>= 2.1.79')
  })
  it('4. treats a Codex whose protocol digest is known as compatible', async () => {
    const root = tempRoot()
    const codex = codexScript(root, '0.153.4', protocolRoot)
    const probe = await new ExecutorRegistry({ home: root }).probe(
      codexProfile(codex),
    )
    expect(probe).toMatchObject({
      status: 'available',
      executableVersion: '0.153.4',
      compatibility: 'verified',
      protocolVersion: '0.153.4',
      protocolCheck: 'matched',
    })
    expect(probe.diagnostic).toBeUndefined()
  })
  it('5. warns but still runs a same-minor Codex whose protocol changed', async () => {
    const root = tempRoot()
    const schema = join(root, 'schema')
    cpSync(protocolRoot, schema, { recursive: true })
    const changed = join(schema, 'v2', 'TurnStartParams.json')
    const params = JSON.parse(readFileSync(changed, 'utf8'))
    params.properties.newlyRequiredField = { type: 'string' }
    writeFileSync(changed, JSON.stringify(params))
    const codex = codexScript(root, '0.153.9', schema)
    const registry = new ExecutorRegistry({ home: root })
    const probe = await registry.probe(codexProfile(codex))
    expect(probe).toMatchObject({
      status: 'available',
      executableVersion: '0.153.9',
      compatibility: 'unverified',
      protocolVersion: '0.153.4',
      // VER-04: the schema differs (the self-check refuses this one).
      protocolCheck: 'differs',
    })
    expect(probe.diagnostic).toMatch(/may be incompatible/i)
    await expect(
      registry.requireAvailable(codexProfile(codex)),
    ).resolves.toMatchObject({ compatibility: 'unverified' })
  })
  it('VER-04 · a schema it cannot generate is told apart from one that differs', async () => {
    const root = tempRoot()
    const codex = versionScript(root, 'codex-broken', 'codex-cli 0.163.0')
    const probe = await new ExecutorRegistry({ home: root }).probe(
      codexProfile(codex),
    )
    expect(probe).toMatchObject({
      status: 'available',
      compatibility: 'unverified',
      protocolCheck: 'unreadable',
    })
  })
  it('6. refuses a Codex of another minor and names the supported range', async () => {
    const root = tempRoot()
    for (const version of ['0.154.0', '0.162.9', '0.165.0']) {
      const codex = codexScript(root, version, protocolRoot0163)
      const registry = new ExecutorRegistry({ home: root })
      const probe = await registry.probe(codexProfile(codex))
      expect(probe).toMatchObject({
        status: 'incompatible',
        executableVersion: version,
        requiredVersion: '0.153.x / 0.163.x / 0.164.x',
      })
      expect(probe.diagnostic).toContain('0.153.x / 0.163.x / 0.164.x')
      await expect(
        registry.requireAvailable(codexProfile(codex)),
      ).rejects.toThrow(
        /EXECUTOR_INCOMPATIBLE.*0\.153\.x \/ 0\.163\.x \/ 0\.164\.x/,
      )
    }
  })
  it('AGT-13 · treats Codex 0.163 whose protocol digest is known as compatible', async () => {
    const root = tempRoot()
    for (const version of ['0.163.0', '0.163.3']) {
      const codex = codexScript(root, version, protocolRoot0163)
      const probe = await new ExecutorRegistry({ home: root }).probe(
        codexProfile(codex),
      )
      expect(probe).toMatchObject({
        status: 'available',
        executableVersion: version,
        requiredVersion: '0.153.x / 0.163.x / 0.164.x',
        compatibility: 'verified',
        protocolVersion: '0.163.0',
      })
      expect(probe.diagnostic).toBeUndefined()
    }
  })
  it('VER-07 · Codex 0.164 with its recorded protocol is verified; with the 0.163 one it is not', async () => {
    const root = tempRoot()
    for (const version of ['0.164.0', '0.164.2']) {
      const codex = codexScript(root, version, protocolRoot0164)
      expect(
        await new ExecutorRegistry({ home: root }).probe(codexProfile(codex)),
      ).toMatchObject({
        status: 'available',
        executableVersion: version,
        compatibility: 'verified',
        protocolVersion: '0.164.0',
      })
    }
    const changed = codexScript(root, '0.164.1', protocolRoot0163)
    expect(
      await new ExecutorRegistry({ home: root }).probe(codexProfile(changed)),
    ).toMatchObject({ compatibility: 'unverified', protocolVersion: '0.164.0' })
  })
  it('AGT-13 · a 0.163 Codex is checked against the 0.163 protocol, never the 0.153 one', async () => {
    const root = tempRoot()
    // A 0.163 binary that generates the 0.153 schema has changed protocol.
    const codex = codexScript(root, '0.163.1', protocolRoot)
    const probe = await new ExecutorRegistry({ home: root }).probe(
      codexProfile(codex),
    )
    expect(probe).toMatchObject({
      status: 'available',
      executableVersion: '0.163.1',
      compatibility: 'unverified',
      protocolVersion: '0.163.0',
    })
    expect(probe.diagnostic).toMatch(/0\.163\.0; it may be incompatible/)
    // And 0.153 is still verified against its own.
    const older = codexScript(root, '0.153.4', protocolRoot)
    expect(
      await new ExecutorRegistry({ home: root }).probe(codexProfile(older)),
    ).toMatchObject({ compatibility: 'verified', protocolVersion: '0.153.4' })
  })
  it('records each known Codex protocol as a digest of its checked-in schema', () => {
    const folders = readdirSync(join(__dirname, 'protocol')).filter((name) =>
      name.startsWith('codex-'),
    )
    expect(
      KNOWN_CODEX_PROTOCOLS.map((p) => 'codex-' + p.version).sort(),
    ).toEqual(folders.sort())
    for (const protocol of KNOWN_CODEX_PROTOCOLS) {
      const folder = join(__dirname, 'protocol', 'codex-' + protocol.version)
      const digest = codexProtocolDigest(
        (file) => readFileSync(join(folder, file), 'utf8'),
        protocol.files,
      )
      expect(protocol.digests).toContain(digest)
    }
  })
  it('names the Agent SDK it drives the installed claude with', () => {
    const sdk = dirname(
      createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk'),
    )
    expect(
      JSON.parse(readFileSync(join(sdk, 'package.json'), 'utf8')).version,
    ).toBe(CLAUDE_SDK_VERSION)
  })
})
