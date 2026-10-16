import { expect, it } from 'vitest'
import { DelegationPolicy } from './policy'
import { fixtureDelegationRecord } from './testing'
import type { DelegationStart } from './types'
const spec: DelegationStart = {
  backend: 'codex',
  description: 'test',
  prompt: 'test',
  context: 'isolated',
  workspace: 'isolated-worktree',
  base: 'committed',
  runInBackground: true,
  clientRequestId: 'request',
}
it('never widens readonly parent and denies snapshots or writable worktrees', () => {
  const p = new DelegationPolicy(),
    owner = fixtureDelegationRecord().owner,
    parent = {
      cwd: '/src',
      policy: { mode: 'read-only' as const, workspaceRoot: '/src' },
    }
  expect(() => p.resolve(parent, spec, owner, 3)).toThrow('PERMISSION_DENIED')
  expect(
    p.resolve(parent, { ...spec, workspace: 'shared-readonly' }, owner, 3).mode,
  ).toBe('read-only')
  expect(() =>
    p.resolve(
      parent,
      { ...spec, workspace: 'shared-readonly', base: 'snapshot' },
      owner,
      3,
    ),
  ).toThrow('PERMISSION_DENIED')
})
it('narrows full access for readonly review and enforces depth and plan boundaries', () => {
  const p = new DelegationPolicy(),
    owner = fixtureDelegationRecord().owner,
    parent = {
      cwd: '/src',
      policy: { mode: 'danger-full-access' as const, workspaceRoot: '/src' },
    }
  expect(
    p.resolve(parent, { ...spec, workspace: 'shared-readonly' }, owner, 3).mode,
  ).toBe('read-only')
  expect(() => p.resolve(parent, spec, { ...owner, depth: 4 }, 3)).toThrow(
    'DEPTH_LIMIT',
  )
  expect(() =>
    p.resolve({ ...parent, planMode: true }, spec, owner, 3),
  ).toThrow('PLAN_MODE_UNSUPPORTED')
})
