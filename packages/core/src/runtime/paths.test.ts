import { existsSync, mkdtempSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createEmperorPathCatalog,
  defaultEmperorHome,
  defaultStateRoot,
  ensureRuntimeStateDirs,
  resolveRuntimePaths,
  resolveWriteStagingRoot,
} from './paths'

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

const ENV_KEY = 'EMPEROR_CONFIG_DIR'

describe('RuntimePaths', () => {
  afterEach(() => {
    delete process.env[ENV_KEY]
  })

  it('uses ~/.emperor as the canonical default Emperor Home without touching disk', () => {
    expect(defaultEmperorHome()).toBe(join(homedir(), '.emperor'))
    expect(defaultStateRoot()).toBe(defaultEmperorHome())
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
    // real directories under the machine's actual ~/.emperor.
    expect(paths.memoryRoot).toBe(join(defaultStateRoot(), 'memory'))
    expect(paths.sessionsRoot).toBe(join(defaultStateRoot(), 'sessions'))
  })

  it('resolves the write-staging root from Emperor Home, never from the project', () => {
    const envStateRoot = tmp('emperor-env-state-root-')
    process.env[ENV_KEY] = envStateRoot
    const explicitStateRoot = tmp('emperor-explicit-state-root-')

    expect(resolveWriteStagingRoot()).toBe(join(envStateRoot, 'write-staging'))
    expect(resolveWriteStagingRoot({ stateRoot: explicitStateRoot })).toBe(
      join(explicitStateRoot, 'write-staging'),
    )
    // Staged writes are created on demand, so bootstrap leaves the dir absent.
    const paths = resolveRuntimePaths(tmp('emperor-runtime-paths-'), {
      stateRoot: explicitStateRoot,
    })
    ensureRuntimeStateDirs(paths)
    expect(paths.writeStagingRoot).toBe(
      join(explicitStateRoot, 'write-staging'),
    )
    expect(existsSync(paths.writeStagingRoot)).toBe(false)
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
    expect(existsSync(paths.mediaRoot)).toBe(false)
    expect(existsSync(paths.schedulerRoot)).toBe(true)
    expect(existsSync(paths.teamRoot)).toBe(false)
    expect(existsSync(paths.tasksRoot)).toBe(false)
    expect(existsSync(paths.processesRoot)).toBe(true)
    expect(existsSync(paths.controlRoot)).toBe(false)
    expect(existsSync(join(paths.stateRoot, 'external'))).toBe(false)
    expect(existsSync(paths.templatesDir)).toBe(false)
    expect(existsSync(paths.skillsDir)).toBe(false)
    expect(existsSync(paths.assetsDir)).toBe(false)
  })

  it('publishes one path catalog for writable user state and read-only runtime resources', () => {
    const runtimeRoot = tmp('emperor-catalog-runtime-')
    const emperorHome = tmp('emperor-catalog-home-')
    const catalog = createEmperorPathCatalog(runtimeRoot, {
      stateRoot: emperorHome,
    })

    expect(catalog.get('emperorHome')).toMatchObject({
      path: emperorHome,
      scope: 'user',
      source: 'explicit',
      writable: true,
      sensitive: true,
      createPolicy: 'bootstrap',
    })
    expect(catalog.get('userSkills')).toMatchObject({
      path: join(emperorHome, 'skills'),
      scope: 'user',
      writable: true,
      createPolicy: 'bootstrap',
    })
    expect(catalog.get('managedEnvironmentBin')).toMatchObject({
      path: join(emperorHome, 'environment', 'bin'),
      scope: 'user',
      writable: true,
      createPolicy: 'bootstrap',
    })
    expect(catalog.get('pluginCache')).toMatchObject({
      path: join(emperorHome, 'plugins', 'cache'),
      scope: 'user',
      writable: true,
      createPolicy: 'bootstrap',
    })
    expect(catalog.get('pluginInstalled')).toMatchObject({
      path: join(emperorHome, 'plugins', 'installed_plugins.json'),
      sensitive: true,
      createPolicy: 'bootstrap',
    })
    expect(catalog.get('writeStaging')).toMatchObject({
      path: join(emperorHome, 'write-staging'),
      scope: 'user',
      writable: true,
      sensitive: true,
      createPolicy: 'lazy',
    })
    expect(catalog.get('builtinSkills')).toMatchObject({
      path: join(runtimeRoot, 'skills'),
      scope: 'builtin',
      writable: false,
      createPolicy: 'derived',
    })
    expect(catalog.toRuntimePaths()).toMatchObject({
      stateRoot: emperorHome,
      userSkillsRoot: join(emperorHome, 'skills'),
      environmentRoot: join(emperorHome, 'environment'),
      environmentBinRoot: join(emperorHome, 'environment', 'bin'),
      installationFile: join(emperorHome, 'installation.json'),
      settingsFile: join(emperorHome, 'settings.json'),
      modelConfigFile: join(emperorHome, 'model_config.json'),
      mcpConfigFile: join(emperorHome, 'mcp_config.json'),
      hooksConfigFile: join(emperorHome, 'hooks_config.json'),
      onboardingFile: join(emperorHome, 'onboarding.json'),
      userAgentsRoot: join(emperorHome, 'agents'),
      pluginsRoot: join(emperorHome, 'plugins'),
      pluginCacheRoot: join(emperorHome, 'plugins', 'cache'),
      pluginInstalledFile: join(
        emperorHome,
        'plugins',
        'installed_plugins.json',
      ),
    })
  })
})
