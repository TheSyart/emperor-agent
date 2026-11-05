import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { shellContainmentPolicy, shellGuardPolicy } from './backend'

describe('CG-01 Shell group-private roots', () => {
  it('denies reads and writes in confined and full-access guard policies', () => {
    const stateRoot = mkdtempSync(join(tmpdir(), 'emperor-group-shell-'))
    const other = join(stateRoot, 'groups', 'grp-a', 'members', 'ct-other')
    const confined = shellContainmentPolicy({
      mode: 'workspace-write',
      workspaceRoot: join(stateRoot, 'workspace'),
      deniedRoots: [other],
    })
    expect(confined.read.deny).toContain(other)
    expect(confined.write.deny).toContain(other)
    const full = shellGuardPolicy(stateRoot, undefined, [other])
    expect(full.read.deny).toContain(other)
    expect(full.write.deny).toContain(other)
  })
})
