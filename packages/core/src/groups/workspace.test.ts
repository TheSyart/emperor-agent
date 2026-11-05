import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { GroupWorkspaceStore } from './workspace'
import { memoryGroups } from './test-fixture'

function fixture() {
  const stateRoot = mkdtempSync(join(tmpdir(), 'emperor-group-workspace-'))
  const store = new GroupWorkspaceStore({ stateRoot })
  return { stateRoot, store }
}

describe('CG-01 group workspaces', () => {
  it('creates independent roots for discussion groups and their members', () => {
    const { store } = fixture()
    const a = store.ensureGroup('grp-a')
    const b = store.ensureGroup('grp-b')
    const member = store.ensureMember('grp-a', 'ct-a')
    expect(a.root).not.toBe(b.root)
    expect(a.shared).toBe(join(a.root, 'shared'))
    expect(member.workspaceRoot).toBe(join(a.root, 'members', 'ct-a'))
    expect(realpathSync(member.workspaceRoot)).toBe(member.workspaceRoot)
  })

  it('allows only the member root and shared reads, and revokes writes after removal', () => {
    const { store } = fixture()
    store.ensureMember('grp-a', 'ct-a')
    store.ensureMember('grp-a', 'ct-b')
    const active = store.access('grp-a', 'ct-a', true)
    expect(active.readOnlyRoots).toEqual([store.ensureGroup('grp-a').shared])
    expect(active.deniedRoots).toEqual([
      join(store.ensureGroup('grp-a').root, 'members', 'ct-b'),
    ])
    const removed = store.access('grp-a', 'ct-a', false)
    expect(removed.readOnlyRoots).toEqual([
      removed.workspaceRoot,
      store.ensureGroup('grp-a').shared,
    ])
  })

  it('publishes an immutable public artifact without exposing its private source path', () => {
    const { store } = fixture()
    const own = store.ensureMember('grp-a', 'ct-a').workspaceRoot
    writeFileSync(join(own, 'result.md'), '# result\n')
    const artifact = store.publish({
      groupId: 'grp-a',
      contactId: 'ct-a',
      sourcePath: join(own, 'result.md'),
      active: true,
      at: 123,
    })
    expect(artifact.artifactRef).toContain('artifact://grp-a/art-')
    expect(artifact.path).toMatch(/^shared\/artifacts\/art-/)
    expect(artifact.mimeType).toBe('text/markdown')
    expect(artifact).not.toHaveProperty('sourcePath')
    expect(
      readFileSync(
        join(store.ensureGroup('grp-a').root, artifact.path),
        'utf8',
      ),
    ).toBe('# result\n')
    expect(
      store.publish({
        groupId: 'grp-a',
        contactId: 'ct-a',
        sourcePath: join(own, 'result.md'),
        active: true,
        at: 456,
      }).artifactRef,
    ).toBe(artifact.artifactRef)
  })

  it('CG-04: gives the same name different immutable content versions and records image MIME', () => {
    const { store } = fixture()
    const own = store.ensureMember('grp-a', 'ct-a').workspaceRoot
    const source = join(own, 'report.md')
    writeFileSync(source, 'version one')
    const first = store.publish({
      groupId: 'grp-a',
      contactId: 'ct-a',
      sourcePath: source,
      active: true,
      taskId: 'gt-one',
      at: 100,
    })
    writeFileSync(source, 'version two')
    const second = store.publish({
      groupId: 'grp-a',
      contactId: 'ct-a',
      sourcePath: source,
      active: true,
      taskId: 'gt-two',
      at: 200,
    })
    expect(second.artifactRef).not.toBe(first.artifactRef)
    expect(second.artifactId).not.toBe(first.artifactId)
    const root = store.ensureGroup('grp-a').root
    expect(readFileSync(join(root, first.path), 'utf8')).toBe('version one')
    expect(readFileSync(join(root, second.path), 'utf8')).toBe('version two')
    expect(second).toMatchObject({
      contactId: 'ct-a',
      taskId: 'gt-two',
      mimeType: 'text/markdown',
      size: 11,
    })
    expect(second.sha256).toMatch(/^[0-9a-f]{64}$/)

    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j98sAAAAASUVORK5CYII=',
      'base64',
    )
    writeFileSync(join(own, 'pixel.png'), png)
    expect(
      store.publish({
        groupId: 'grp-a',
        contactId: 'ct-a',
        sourcePath: join(own, 'pixel.png'),
        active: true,
      }),
    ).toMatchObject({ mimeType: 'image/png', size: png.length })
  })

  it('rejects private paths, removed members and symlink escapes', () => {
    const { store, stateRoot } = fixture()
    const own = store.ensureMember('grp-a', 'ct-a').workspaceRoot
    const other = store.ensureMember('grp-a', 'ct-b').workspaceRoot
    const outside = join(stateRoot, 'outside.md')
    writeFileSync(outside, 'outside')
    writeFileSync(join(other, 'secret.md'), 'secret')
    symlinkSync(outside, join(own, 'escape.md'))
    for (const sourcePath of [
      outside,
      join(other, 'secret.md'),
      join(own, 'escape.md'),
    ])
      expect(() =>
        store.publish({
          groupId: 'grp-a',
          contactId: 'ct-a',
          sourcePath,
          active: true,
        }),
      ).toThrow()
    expect(() =>
      store.publish({
        groupId: 'grp-a',
        contactId: 'ct-a',
        sourcePath: join(own, 'escape.md'),
        active: false,
      }),
    ).toThrow('退出群聊')
  })

  it('projects creation and artifacts through the existing group log', () => {
    const { store } = fixture()
    const { service, logs } = memoryGroups(undefined, { workspace: store })
    const group = service.create({
      title: '讨论',
      members: ['ct-arch', 'ct-rev'],
    })
    const state = service.state(group.id)
    expect(state.workspace?.root).toBe(store.ensureGroup(group.id).root)
    expect(
      logs.get(group.id)?.some((event) => event.type === 'group/workspace'),
    ).toBe(true)
    const own = store.ensureMember(group.id, 'ct-arch').workspaceRoot
    writeFileSync(join(own, 'a.md'), 'a')
    const artifact = service.publishArtifact(group.id, {
      contactId: 'ct-arch',
      sourcePath: join(own, 'a.md'),
    })
    writeFileSync(join(own, 'alias.md'), 'a')
    const alias = service.publishArtifact(group.id, {
      contactId: 'ct-arch',
      sourcePath: join(own, 'alias.md'),
    })
    const artifacts = service.state(group.id).artifacts
    expect(artifacts.get(artifact.artifactRef)?.name).toBe('a.md')
    expect(artifacts.get(alias.artifactRef)?.name).toBe('alias.md')
    expect(JSON.stringify(logs.get(group.id))).not.toContain(own)
  })
})
