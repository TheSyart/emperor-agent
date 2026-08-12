import { existsSync } from 'node:fs'
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createNodeSyncPersistenceAdapter } from '../store/persistence'
import { ProjectStore } from './store'

function fixture() {
  const stateRoot = mkdtempSync(join(tmpdir(), 'emperor-project-store-'))
  const workspace = join(stateRoot, 'workspace')
  mkdirSync(workspace, { recursive: true })
  return { stateRoot, workspace }
}

describe('ProjectStore persistence', () => {
  it('keeps the projects/index.json array schema and private mode', () => {
    const { stateRoot, workspace } = fixture()
    const store = new ProjectStore(stateRoot)

    const created = store.resolve(workspace)
    const onDisk = JSON.parse(readFileSync(store.indexPath, 'utf8'))

    expect(store.indexPath).toBe(join(stateRoot, 'projects', 'index.json'))
    expect(onDisk).toEqual([created])
    expect(statSync(store.indexPath).mode & 0o777).toBe(0o600)
    expect(new ProjectStore(stateRoot).get(created.project_id)).toEqual(created)
  })

  it('quarantines a truncated legacy index instead of exposing partial state', () => {
    const { stateRoot } = fixture()
    const path = join(stateRoot, 'projects', 'index.json')
    mkdirSync(join(stateRoot, 'projects'), { recursive: true })
    writeFileSync(path, '[{"project_id":', 'utf8')

    expect(new ProjectStore(stateRoot).list()).toEqual([])
    expect(existsSync(path)).toBe(false)
    expect(
      readdirSync(join(stateRoot, 'projects')).some((name) =>
        name.startsWith('index.json.corrupt-'),
      ),
    ).toBe(true)
  })

  it('preserves the previous index when durable rename fails', () => {
    const { stateRoot, workspace } = fixture()
    const healthy = new ProjectStore(stateRoot)
    const original = healthy.resolve(workspace)
    const before = readFileSync(healthy.indexPath, 'utf8')
    const secondWorkspace = join(stateRoot, 'workspace-two')
    mkdirSync(secondWorkspace, { recursive: true })
    const failing = new ProjectStore(stateRoot, {
      persistenceAdapter: createNodeSyncPersistenceAdapter({
        beforeOperation(operation) {
          if (operation === 'rename') throw new Error('injected rename')
        },
      }),
    })

    expect(() => failing.resolve(secondWorkspace)).toThrow(
      expect.objectContaining({ code: 'persistence_io', operation: 'rename' }),
    )
    expect(readFileSync(healthy.indexPath, 'utf8')).toBe(before)
    expect(new ProjectStore(stateRoot).list()).toEqual([original])
    expect(
      readdirSync(join(stateRoot, 'projects')).filter((name) =>
        name.includes('.tmp-'),
      ),
    ).toEqual([])
  })
})
