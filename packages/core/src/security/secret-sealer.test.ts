import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { LocalSecretStore } from './local-secret-store'
import {
  createLocalKeySealer,
  isSealedSecret,
  localSecretKeyPath,
  SEALED_SECRET_PREFIX,
  SecretSealError,
  sealerFromSecretStore,
  vaultHasSealedData,
} from './secret-sealer'

function stateRoot(): string {
  return mkdtempSync(join(tmpdir(), 'emperor-sealer-'))
}

function reasonOf(action: () => unknown): string {
  try {
    action()
  } catch (error) {
    expect(error).toBeInstanceOf(SecretSealError)
    return (error as SecretSealError).reason
  }
  throw new Error('expected a seal error')
}

describe('SecretSealer (SEC-06)', () => {
  it('seals with the local key file in Core alone, as ACP runs without main', () => {
    const root = stateRoot()
    const sealer = createLocalKeySealer(root)
    expect(sealer.available).toBe(true)
    const sealed = sealer.seal('sk-live-0123456789', 'model:a')
    expect(sealed.startsWith(SEALED_SECRET_PREFIX)).toBe(true)
    expect(isSealedSecret(sealed)).toBe(true)
    expect(sealed).not.toContain('sk-live')
    expect(sealer.open(sealed, 'model:a')).toBe('sk-live-0123456789')
    // The key is the one main uses: same file, same checks.
    const key = localSecretKeyPath(root)
    expect(key).toBe(join(root, 'computer-use', 'secrets', 'local.key'))
    expect(statSync(key).mode & 0o777).toBe(0o600)
    expect(statSync(dirname(key)).mode & 0o777).toBe(0o700)
  })

  it('opens what main sealed and the other way round', () => {
    const root = stateRoot()
    const main = sealerFromSecretStore(
      new LocalSecretStore({ keyPath: localSecretKeyPath(root) }),
    )
    const node = createLocalKeySealer(root)
    expect(node.open(main.seal('from-main', 'ctx'), 'ctx')).toBe('from-main')
    expect(main.open(node.seal('from-node', 'ctx'), 'ctx')).toBe('from-node')
  })

  it('binds a value to its context: moved to another field it does not open', () => {
    const sealer = createLocalKeySealer(stateRoot())
    const sealed = sealer.seal('token', 'mcp:a/headers/Authorization')
    expect(reasonOf(() => sealer.open(sealed, 'model:b'))).toBe('unreadable')
    expect(reasonOf(() => sealer.open('el1:not-base64!!', 'x'))).toBe(
      'unreadable',
    )
    expect(reasonOf(() => sealer.open('plain', 'x'))).toBe('not-sealed')
  })

  it('a lost key makes old values unreadable; a new key is made only when no vault data needs the old one', () => {
    const root = stateRoot()
    const first = createLocalKeySealer(root)
    const sealed = first.seal('old-secret', 'ctx')
    rmSync(dirname(localSecretKeyPath(root)), { recursive: true })

    // Vault entries still need the lost key: no new key over them.
    const vault = join(root, 'computer-use', 'vault.json')
    writeFileSync(
      vault,
      JSON.stringify({ version: 2, entries: [{ fields: { password: 'x' } }] }),
    )
    const guarded = createLocalKeySealer(root)
    expect(guarded.available).toBe(false)
    expect(reasonOf(() => guarded.seal('new', 'ctx'))).toBe('unavailable')
    expect(reasonOf(() => guarded.open(sealed, 'ctx'))).toBe('unreadable')

    // Nothing in the vault: the next seal makes a new key; the old value
    // stays unreadable (it needs re-entering).
    writeFileSync(vault, JSON.stringify({ version: 2, entries: [] }))
    const fresh = createLocalKeySealer(root)
    expect(fresh.available).toBe(true)
    expect(fresh.open(fresh.seal('new', 'ctx'), 'ctx')).toBe('new')
    expect(reasonOf(() => fresh.open(sealed, 'ctx'))).toBe('unreadable')
  })

  it('reads the vault guard conservatively', () => {
    const root = stateRoot()
    const vault = join(root, 'computer-use', 'vault.json')
    expect(vaultHasSealedData(vault)).toBe(false)
    mkdirSync(dirname(vault), { recursive: true })
    writeFileSync(vault, '{not json')
    expect(vaultHasSealedData(vault)).toBe(true)
    writeFileSync(
      vault,
      JSON.stringify({ version: 2, entries: [{ fields: {} }] }),
    )
    expect(vaultHasSealedData(vault)).toBe(false)
  })
})
