// HarnessHost Skill wiring: per-session loaders (one per project root, no
// cross-project leakage) and the Skill folder watcher that emits
// `skill_catalog_changed`.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LlmClient } from '../../llm/client'
import { ScriptedAdapter, testRoute } from '../testing'
import { HarnessHost } from './host'

const hosts: HarnessHost[] = []

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close()
})

async function makeHost(opts: { watchSkills?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'harness-host-skills-'))
  const llm = new LlmClient({ adapterFor: () => new ScriptedAdapter([]) })
  llm.setRoutes([testRoute()], 'test-route')
  const events: Array<Record<string, unknown>> = []
  const host = await HarnessHost.create({
    root,
    stateRoot: join(root, 'home'),
    stateRootSource: 'explicit',
    emperorHomePrepared: false,
    llm,
    initializeMcp: false,
    ...(opts.watchSkills === undefined
      ? {}
      : { watchSkills: opts.watchSkills }),
    eventSink: (event) => {
      events.push(event)
    },
  })
  hosts.push(host)
  return { host, root, events }
}

function writeSkill(dir: string, name: string): void {
  mkdirSync(join(dir, name), { recursive: true })
  writeFileSync(
    join(dir, name, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name} skill\n---\n`,
  )
}

async function waitFor(
  check: () => boolean,
  timeoutMs = 10_000,
): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('HarnessHost skills', () => {
  it('resolves each session against its own project loader', async () => {
    const { host, root } = await makeHost({ watchSkills: false })
    const alpha = join(root, 'alpha')
    const beta = join(root, 'beta')
    writeSkill(join(alpha, '.emperor', 'skills'), 'alpha-skill')
    writeSkill(join(beta, '.emperor', 'skills'), 'beta-skill')
    const store = host.kept.sessionStore
    const a = store.create('a', {
      mode: 'build',
      project: { project_path: alpha },
    })
    const b = store.create('b', {
      mode: 'build',
      project: { project_path: beta },
    })
    const chat = store.create('c', { mode: 'chat' })
    const names = (sessionId: string) =>
      host
        .skillsForSession(sessionId)
        .resolvedSkills()
        .map((skill) => skill.name)

    expect(names(a.id)).toEqual(['alpha-skill'])
    expect(names(b.id)).toEqual(['beta-skill'])
    // Interleaved lookups never re-point another session's loader.
    expect(names(a.id)).toEqual(['alpha-skill'])
    expect(names(chat.id)).toEqual([])
    expect(names('unknown-session')).toEqual([])
    const agentA = host.agentFor(a.id)
    const agentB = host.agentFor(b.id)
    expect(host.skillsLoaderFor(agentA).resolve('beta-skill')).toBeNull()
    expect(host.skillsLoaderFor(agentB).resolve('beta-skill')?.source).toBe(
      'project',
    )
    expect(host.projectRootForSession(chat.id)).toBeNull()
  })

  it('emits skill_catalog_changed for user and project Skill folder changes', async () => {
    const { host, root, events } = await makeHost()
    const changes = () =>
      events.filter((event) => event.event === 'skill_catalog_changed')
    // fs.watch (FSEvents on macOS) can miss changes made right after it attaches.
    await new Promise((resolve) => setTimeout(resolve, 500))
    writeSkill(join(root, 'home', 'skills'), 'watched')
    await waitFor(() => changes().length >= 1)
    expect(changes()[0]).toMatchObject({ catalog_version: 1 })

    const project = join(root, 'project')
    mkdirSync(join(project, '.emperor', 'skills'), { recursive: true })
    const session = host.kept.sessionStore.create('p', {
      mode: 'build',
      project: { project_path: project },
    })
    host.skillsForSession(session.id)
    await waitFor(() =>
      host.kept.skillChangeDetector
        .watchedRoots()
        .includes(join(project, '.emperor', 'skills')),
    )
    // chokidar needs a moment to attach to a newly added root.
    await new Promise((resolve) => setTimeout(resolve, 500))
    const before = changes().length
    writeSkill(join(project, '.emperor', 'skills'), 'project-watched')
    await waitFor(() => changes().length > before)

    const viaLibrary = changes().length
    host.kept.skillLibrary.write(null, {
      content: '---\nname: from-tool\ndescription: via library\n---\n',
      scope: 'user',
      mode: 'create',
    })
    await waitFor(() => changes().length > viaLibrary)
  }, 40_000)
})
