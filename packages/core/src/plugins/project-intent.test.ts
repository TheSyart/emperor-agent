// SEC-07 tests 6–8: a project's plugin choices live in Emperor's own state
// (`<stateRoot>/projects/<project-id>/plugins.json`), never in the
// repository. The repository's `.emperor/settings.json` `enabledPlugins` is
// only a suggestion the user confirms on the capabilities page; choices made
// before 0.2 move over once, at the first start, and stay enabled.
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { PluginScope } from './models'
import { PluginApplicationService } from './service'
import {
  portablePackage,
  skillMarkdown,
  tempDirectory,
  writePackage,
} from './testing'

const KIT = portablePackage(
  'repo-kit',
  {
    'skills/repo/SKILL.md': skillMarkdown('repo', 'Repo helper'),
    'hooks/hooks.json': {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: 'echo checked' }],
          },
        ],
      },
    },
  },
  { version: '1.0.0' },
)

/**
 * Where a project's choices are kept: `<stateRoot>/projects/<id>/plugins.json`,
 * the id of the project's real path.
 */
function intentsFile(home: string, workspace: string): string {
  const id = createHash('sha256')
    .update(realpathSync(workspace), 'utf8')
    .digest('hex')
    .slice(0, 16)
  return join(home, 'projects', id, 'plugins.json')
}

function readIntents(home: string, workspace: string) {
  return JSON.parse(readFileSync(intentsFile(home, workspace), 'utf8')) as {
    schemaVersion: number
    workspace: string
    enabledPlugins: Record<string, Record<string, boolean>>
  }
}

/** What an Agent (or a cloned repository) can put in the workspace. */
function writeRepoSettings(
  workspace: string,
  enabledPlugins: Record<string, boolean>,
  file = 'settings.json',
): string {
  mkdirSync(join(workspace, '.emperor'), { recursive: true })
  const path = join(workspace, '.emperor', file)
  writeFileSync(path, JSON.stringify({ enabledPlugins }, null, 2))
  return path
}

async function install(
  service: PluginApplicationService,
  scope: PluginScope,
  workspace: string | null,
): Promise<void> {
  const source = writePackage(join(tempDirectory(), 'repo-kit'), KIT)
  const preview = await service.inspect({ kind: 'local', path: source })
  await service.install(
    { previewId: preview.previewId, digest: preview.digest, scope },
    workspace,
  )
}

function row(
  service: PluginApplicationService,
  workspace: string,
  scope: PluginScope = 'project',
) {
  return service
    .list(workspace)
    .find((item) => item.pluginId === 'repo-kit' && item.scope === scope)!
}

describe('project plugin choices live in Emperor’s state (SEC-07)', () => {
  it('records a project-scope install in stateRoot and leaves the repository alone', async () => {
    const home = tempDirectory()
    const projectA = tempDirectory()
    const service = new PluginApplicationService({ emperorHome: home })
    await install(service, 'project', projectA)

    expect(existsSync(join(projectA, '.emperor'))).toBe(false)
    expect(readIntents(home, projectA)).toMatchObject({
      schemaVersion: 1,
      enabledPlugins: { project: { 'repo-kit': true } },
    })
    expect(row(service, projectA)).toMatchObject({
      enabled: true,
      activation: 'active',
      effective: true,
    })
    expect(row(service, projectA).suggested).toBeFalsy()
  })

  it('6: an Agent writing .emperor/settings.json does not enable a plugin; the project gets a suggestion', async () => {
    const home = tempDirectory()
    const projectA = tempDirectory()
    const projectB = tempDirectory()
    const service = new PluginApplicationService({ emperorHome: home })
    await install(service, 'project', projectA)
    await install(service, 'local', projectA)

    writeRepoSettings(projectB, { 'repo-kit': true })
    writeRepoSettings(projectB, { 'repo-kit': true }, 'settings.local.json')

    expect(row(service, projectB)).toMatchObject({
      enabled: false,
      activation: 'disabled',
      suggested: true,
    })
    // The local file is not even a suggestion.
    expect(row(service, projectB, 'local')).toMatchObject({
      enabled: false,
      activation: 'disabled',
    })
    expect(row(service, projectB, 'local').suggested).toBeFalsy()
    expect(service.effectivePackages(projectB)).toEqual([])
    expect(service.enabledSkillRoots(projectB)).toEqual([])
    // Reading the suggestion writes nothing.
    expect(existsSync(intentsFile(home, projectB))).toBe(false)
    // Project A keeps its own choice.
    expect(row(service, projectA).activation).toBe('active')
  })

  it('7: confirming the suggestion enables the plugin there and writes the choice to stateRoot only', async () => {
    const home = tempDirectory()
    const projectA = tempDirectory()
    const projectB = tempDirectory()
    const projectC = tempDirectory()
    const service = new PluginApplicationService({ emperorHome: home })
    await install(service, 'project', projectA)
    const repoFile = writeRepoSettings(projectB, { 'repo-kit': true })
    const before = readFileSync(repoFile, 'utf8')

    const result = service.setEnabled(
      { pluginId: 'repo-kit', scope: 'project', enabled: true },
      projectB,
    )
    expect(result.changed).toBe(true)
    expect(row(service, projectB)).toMatchObject({
      enabled: true,
      activation: 'active',
    })
    expect(row(service, projectB).suggested).toBeFalsy()
    expect(
      service.effectivePackages(projectB).map((item) => item.pluginId),
    ).toEqual(['repo-kit'])
    expect(readIntents(home, projectB).enabledPlugins.project).toEqual({
      'repo-kit': true,
    })
    expect(readFileSync(repoFile, 'utf8')).toBe(before)

    // The repository can no longer turn the choice around.
    writeRepoSettings(projectB, { 'repo-kit': false })
    expect(row(service, projectB).activation).toBe('active')

    // 忽略: kept off, and no longer suggested.
    writeRepoSettings(projectC, { 'repo-kit': true })
    service.setEnabled(
      { pluginId: 'repo-kit', scope: 'project', enabled: false },
      projectC,
    )
    expect(row(service, projectC)).toMatchObject({
      enabled: false,
      activation: 'disabled',
    })
    expect(row(service, projectC).suggested).toBeFalsy()
    expect(readIntents(home, projectC).enabledPlugins.project).toEqual({
      'repo-kit': false,
    })

    // Uninstalling drops the choice from this project's file.
    service.uninstall({ pluginId: 'repo-kit', scope: 'project' }, projectB)
    expect(readIntents(home, projectB).enabledPlugins.project).toEqual({})
  })

  it('shares one folder’s choices across its spellings (a symlink, /var and /private/var)', async () => {
    const home = tempDirectory()
    const projectA = tempDirectory()
    const real = realpathSync(tempDirectory())
    const link = join(tempDirectory(), 'linked-project')
    symlinkSync(real, link)
    const service = new PluginApplicationService({ emperorHome: home })
    await install(service, 'project', projectA)
    service.setEnabled(
      { pluginId: 'repo-kit', scope: 'project', enabled: true },
      link,
    )
    expect(row(service, real).activation).toBe('active')
    expect(readIntents(home, real)).toMatchObject({
      workspace: real,
      enabledPlugins: { project: { 'repo-kit': true } },
    })
  })

  it('8: choices made before 0.2 move to stateRoot once and stay enabled; later repositories only suggest', async () => {
    const home = tempDirectory()
    const known = tempDirectory()
    const later = tempDirectory()
    const setup = new PluginApplicationService({ emperorHome: home })
    await install(setup, 'project', known)
    await install(setup, 'local', known)
    // The pre-0.2 layout: the choices sat in the project's own files.
    rmSync(intentsFile(home, known), { force: true })
    writeRepoSettings(known, { 'repo-kit': true, ghost: true })
    writeRepoSettings(known, { 'repo-kit': true }, 'settings.local.json')
    writeRepoSettings(later, { 'repo-kit': true })

    const upgraded = new PluginApplicationService({
      emperorHome: home,
      knownProjects: () => [known],
    })
    expect(row(upgraded, known)).toMatchObject({
      enabled: true,
      activation: 'active',
    })
    expect(row(upgraded, known).suggested).toBeFalsy()
    expect(row(upgraded, known, 'local')).toMatchObject({
      enabled: true,
      activation: 'active',
    })
    // Only packages registered in that scope move; `ghost` is not installed.
    expect(readIntents(home, known).enabledPlugins).toEqual({
      project: { 'repo-kit': true },
      local: { 'repo-kit': true },
    })
    // A project Emperor did not know before the upgrade only gets a suggestion.
    expect(row(upgraded, later)).toMatchObject({
      enabled: false,
      suggested: true,
    })

    // The move happens once: a project known later is not moved.
    const restarted = new PluginApplicationService({
      emperorHome: home,
      knownProjects: () => [known, later],
    })
    expect(row(restarted, later)).toMatchObject({
      enabled: false,
      suggested: true,
    })
    expect(existsSync(intentsFile(home, later))).toBe(false)
    expect(row(restarted, known).activation).toBe('active')
  })
})
