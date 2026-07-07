import { existsSync, mkdtempSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultStateRoot, ensureRuntimeStateDirs, resolveRuntimePaths } from './paths'

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

const ENV_KEY = 'EMPEROR_CONFIG_DIR'

describe('RuntimePaths', () => {
  afterEach(() => {
    delete process.env[ENV_KEY]
  })

  it('defaultStateRoot() resolves under the real home directory (string only, no disk access)', () => {
    expect(defaultStateRoot()).toBe(join(homedir(), '.emperor-agent'))
  })

  it('falls back to defaultStateRoot() when neither explicit stateRoot nor EMPEROR_CONFIG_DIR is set', () => {
    delete process.env[ENV_KEY]
    const root = tmp('emperor-runtime-paths-')
    const paths = resolveRuntimePaths(root)

    expect(paths.runtimeRoot).toBe(root)
    expect(paths.stateRoot).toBe(defaultStateRoot())
    expect(paths.stateRootSource).toBe('default')
    expect(paths.templatesDir).toBe(join(root, 'templates'))
    expect(paths.skillsDir).toBe(join(root, 'skills'))
    expect(paths.assetsDir).toBe(join(root, 'assets'))
    // Only assert the derived strings here — never call ensureRuntimeStateDirs() on a
    // paths object resolved against the real home directory, or this test would create
    // real directories under the machine's actual ~/.emperor-agent.
    expect(paths.memoryRoot).toBe(join(defaultStateRoot(), 'memory'))
    expect(paths.sessionsRoot).toBe(join(defaultStateRoot(), 'sessions'))
  })

  it('EMPEROR_CONFIG_DIR overrides the default when no explicit stateRoot is passed', () => {
    const envStateRoot = tmp('emperor-env-state-root-')
    process.env[ENV_KEY] = envStateRoot
    const root = tmp('emperor-runtime-paths-')
    const paths = resolveRuntimePaths(root)

    expect(paths.stateRoot).toBe(envStateRoot)
    expect(paths.stateRootSource).toBe('env')
    expect(paths.memoryRoot).toBe(join(envStateRoot, 'memory'))
  })

  it('explicit stateRoot overrides EMPEROR_CONFIG_DIR', () => {
    process.env[ENV_KEY] = tmp('emperor-env-state-root-')
    const root = tmp('emperor-runtime-paths-')
    const explicitStateRoot = tmp('emperor-explicit-state-root-')
    const paths = resolveRuntimePaths(root, { stateRoot: explicitStateRoot })

    expect(paths.stateRoot).toBe(explicitStateRoot)
    expect(paths.stateRootSource).toBe('explicit')
  })

  it('runtimeRoot and stateRoot can differ, and resource dirs stay under runtimeRoot', () => {
    const root = tmp('emperor-runtime-root-')
    const stateRoot = tmp('emperor-state-root-')
    const paths = resolveRuntimePaths(root, { stateRoot })

    expect(paths.runtimeRoot).toBe(root)
    expect(paths.stateRoot).toBe(stateRoot)
    expect(paths.stateRootSource).toBe('explicit')
    expect(paths.templatesDir).toBe(join(root, 'templates'))
    expect(paths.skillsDir).toBe(join(root, 'skills'))
    expect(paths.assetsDir).toBe(join(root, 'assets'))
    expect(paths.memoryRoot).toBe(join(stateRoot, 'memory'))
    expect(paths.sessionsRoot).toBe(join(stateRoot, 'sessions'))
    expect(paths.projectsRoot).toBe(join(stateRoot, 'projects'))
    expect(paths.attachmentsRoot).toBe(join(stateRoot, 'memory', 'attachments'))
    expect(paths.mediaRoot).toBe(join(stateRoot, 'memory', 'media'))
  })

  it('creates only state directories when ensuring runtime state, never runtime resource dirs', () => {
    const root = tmp('emperor-runtime-paths-')
    const stateRoot = tmp('emperor-state-root-')
    const paths = resolveRuntimePaths(root, { stateRoot })

    ensureRuntimeStateDirs(paths)

    expect(existsSync(paths.stateRoot)).toBe(true)
    expect(existsSync(paths.memoryRoot)).toBe(true)
    expect(existsSync(paths.sessionsRoot)).toBe(true)
    expect(existsSync(paths.projectsRoot)).toBe(true)
    expect(existsSync(paths.attachmentsRoot)).toBe(true)
    expect(existsSync(paths.mediaRoot)).toBe(true)
    expect(existsSync(paths.schedulerRoot)).toBe(true)
    expect(existsSync(paths.teamRoot)).toBe(true)
    expect(existsSync(paths.tasksRoot)).toBe(true)
    expect(existsSync(paths.controlRoot)).toBe(true)
    expect(existsSync(paths.externalRoot)).toBe(true)
    expect(existsSync(paths.templatesDir)).toBe(false)
    expect(existsSync(paths.skillsDir)).toBe(false)
    expect(existsSync(paths.assetsDir)).toBe(false)
  })
})
