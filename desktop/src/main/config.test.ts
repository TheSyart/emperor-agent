import { describe, it, expect } from 'vitest'
import { resolveConfig } from './config'

const throwingRead = (): string => {
  throw new Error('ENOENT')
}

describe('resolveConfig', () => {
  it('falls back to defaults when emperor.local.json is unreadable', () => {
    const cfg = resolveConfig({ readFile: throwingRead })
    expect(cfg.configSource).toBe('default')
  })

  it('detects a readable emperor.local.json', () => {
    const readFile = () =>
      JSON.stringify({ webui: { host: '0.0.0.0', port: 9100 } })
    const cfg = resolveConfig({ readFile })
    expect(cfg.configSource).toBe('file')
  })

  it('honors --root and EMPEROR_AGENT_ROOT for runtimeRoot only (emperor.local.json now lives under stateRoot)', () => {
    const readFile = throwingRead

    const explicit = resolveConfig({
      argv: ['--root', '/tmp/custom-root'],
      env: { EMPEROR_CONFIG_DIR: '/tmp/custom-state' },
      readFile,
    })
    expect(explicit.runtimeRoot).toBe('/tmp/custom-root')

    const envRoot = resolveConfig({
      env: {
        EMPEROR_AGENT_ROOT: '/tmp/env-root',
        EMPEROR_CONFIG_DIR: '/tmp/custom-state',
      },
      readFile,
    })
    expect(envRoot.runtimeRoot).toBe('/tmp/env-root')
  })

  it('uses packaged default root when no explicit root is provided', () => {
    const cfg = resolveConfig({
      defaultRoot:
        '/Users/me/Library/Application Support/Emperor Agent/runtime',
      env: { EMPEROR_CONFIG_DIR: '/tmp/emperor-config-test-state' },
      readFile: throwingRead,
    })

    expect(cfg.runtimeRoot).toBe(
      '/Users/me/Library/Application Support/Emperor Agent/runtime',
    )
    expect(cfg.runtimeRootSource).toBe('default')
  })

  it('keeps explicit runtime roots ahead of the packaged default root', () => {
    const readFile = throwingRead

    const explicit = resolveConfig({
      argv: ['--root', '/manual'],
      defaultRoot: '/runtime',
      readFile,
    })
    expect(explicit.runtimeRoot).toBe('/manual')
    expect(explicit.runtimeRootSource).toBe('explicit')

    const envRoot = resolveConfig({
      env: { EMPEROR_AGENT_ROOT: '/env' },
      defaultRoot: '/runtime',
      readFile,
    })
    expect(envRoot.runtimeRoot).toBe('/env')
    expect(envRoot.runtimeRootSource).toBe('env')
  })

  it('resolves stateRoot independently of runtimeRoot: EMPEROR_CONFIG_DIR overrides the default', () => {
    const readFile = throwingRead

    const withEnv = resolveConfig({
      argv: ['--root', '/manual-runtime'],
      env: { EMPEROR_CONFIG_DIR: '/manual-state' },
      readFile,
    })
    expect(withEnv.runtimeRoot).toBe('/manual-runtime')
    expect(withEnv.stateRoot).toBe('/manual-state')
    expect(withEnv.stateRootSource).toBe('env')

    // Without EMPEROR_CONFIG_DIR, stateRoot falls back to the real ~/.emperor-agent default —
    // only assert the source tag here, never assert/act on the literal path in a unit test.
    const withoutEnv = resolveConfig({
      argv: ['--root', '/manual-runtime'],
      readFile,
    })
    expect(withoutEnv.stateRootSource).toBe('default')
    expect(withoutEnv.runtimeRoot).toBe('/manual-runtime')
  })

  it('forces packaged runtime resources ahead of argv and environment overrides', () => {
    const cfg = resolveConfig({
      argv: ['--root', '/untrusted-argv'],
      env: {
        EMPEROR_AGENT_ROOT: '/untrusted-env',
        EMPEROR_CONFIG_DIR: '/private-state',
      },
      forcedRuntimeRoot: '/signed/resources/runtime-defaults',
    })

    expect(cfg.runtimeRoot).toBe('/signed/resources/runtime-defaults')
    expect(cfg.runtimeRootSource).toBe('packaged')
    expect(cfg.stateRoot).toBe('/private-state')
  })

  it('reads emperor.local.json from stateRoot, not runtimeRoot', () => {
    const seen: string[] = []
    const readFile = (p: string): string => {
      seen.push(p)
      return JSON.stringify({ webui: { host: '0.0.0.0', port: 9100 } })
    }

    const cfg = resolveConfig({
      argv: ['--root', '/manual-runtime'],
      env: { EMPEROR_CONFIG_DIR: '/manual-state' },
      readFile,
    })

    expect(cfg.configSource).toBe('file')
    expect(seen).toEqual(['/manual-state/emperor.local.json'])
  })
})
