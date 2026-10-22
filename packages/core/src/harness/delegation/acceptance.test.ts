import { expect, it, vi } from 'vitest'
import { writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { receiptFixture } from './receipt-test-fixture'
import {
  DelegationAcceptance,
  criteriaDigest,
  type AcceptanceCriteria,
} from './acceptance'

/** Waits on work that runs processes, Git or the file system: room for a
 * loaded CI runner instead of the 1 s default (FIX-17). */
const LOADED = { timeout: 10_000 }

async function fixture() {
  const f = await receiptFixture()
  writeFileSync(join(f.lease.cwd, 'result.txt'), 'verified artifact')
  const receipt = await f.receipts.collect(f.run.id),
    acceptance = new DelegationAcceptance({
      root: join(f.root, 'state'),
      receipts: f.receipts,
      mutations: f.mutations,
      scope: () => ({ taskScopeId: 'task', permission: 'workspace-write' }),
    })
  return { ...f, receipt, acceptance }
}
const criteria: AcceptanceCriteria = {
  description: 'result file has the required bytes',
  commands: [
    {
      executable: process.execPath,
      args: [
        '-e',
        'if(require("fs").readFileSync("result.txt","utf8")!=="verified artifact")process.exit(3);console.log("independent host assertion passed")',
      ],
    },
  ],
}
const authorization = {
  source: 'host-plan' as const,
  taskScopeId: 'task',
  criteriaDigest: criteriaDigest(criteria),
}
it('runs an independent host assertion, records its command/log/exact tree, and invalidates after edits', async () => {
  const f = await fixture()
  try {
    const result = await f.acceptance.validate(
      f.receipt.id,
      criteria,
      authorization,
    )
    expect(result.state).toBe('passed')
    expect(result.evidence).toHaveLength(1)
    expect(result.evidence[0]).toMatchObject({
      source: 'host-verified',
      treeDigest: f.receipt.resultTreeDigest,
      exitCode: 0,
      quiescent: true,
      cwd: f.lease.cwd,
    })
    expect(readFileSync(result.evidence[0]!.logRef!, 'utf8')).toContain(
      'independent host assertion passed',
    )
    writeFileSync(join(f.lease.cwd, 'result.txt'), 'later correction')
    expect((await f.acceptance.current(result.id)).state).toBe('unverified')
  } finally {
    f.cleanup()
  }
})
it('does not turn an agent-reported pass or empty criteria into host-verified acceptance', async () => {
  const f = await fixture(),
    empty: AcceptanceCriteria = { description: '', commands: [] }
  try {
    const result = await f.acceptance.validate(f.receipt.id, empty, {
      ...authorization,
      criteriaDigest: criteriaDigest(empty),
    })
    expect(result.state).toBe('unverified')
    expect(result.evidence).toEqual([])
    expect(f.receipt.summary).toContain('native report')
  } finally {
    f.cleanup()
  }
})
it('rejects changed scope or criteria authorization before running a command', async () => {
  const f = await fixture()
  try {
    await expect(
      f.acceptance.validate(f.receipt.id, criteria, {
        ...authorization,
        taskScopeId: 'another-task',
      }),
    ).rejects.toThrow('PERMISSION_DENIED')
    await expect(
      f.acceptance.validate(f.receipt.id, criteria, {
        ...authorization,
        criteriaDigest: 'altered',
      }),
    ).rejects.toThrow('PERMISSION_DENIED')
  } finally {
    f.cleanup()
  }
})
it('does not reuse a pass when verification itself changes the result tree', async () => {
  const f = await fixture(),
    mutating: AcceptanceCriteria = {
      description: 'a test that changes code',
      commands: [
        {
          executable: process.execPath,
          args: [
            '-e',
            'require("fs").writeFileSync("result.txt","mutated by test")',
          ],
        },
      ],
    }
  try {
    expect(
      (
        await f.acceptance.validate(f.receipt.id, mutating, {
          ...authorization,
          criteriaDigest: criteriaDigest(mutating),
        })
      ).state,
    ).toBe('unverified')
  } finally {
    f.cleanup()
  }
})
it('failed assertions remain failed and an explicit review requirement remains needs_user', async () => {
  const f = await fixture(),
    fail: AcceptanceCriteria = {
      description: 'must fail',
      commands: [
        { executable: process.execPath, args: ['-e', 'process.exit(7)'] },
      ],
    },
    review = { ...criteria, requiresReview: true }
  try {
    const result = await f.acceptance.validate(f.receipt.id, fail, {
      ...authorization,
      criteriaDigest: criteriaDigest(fail),
    })
    expect(result.state).toBe('failed')
    expect(result.evidence[0]?.exitCode).toBe(7)
    expect(
      (
        await f.acceptance.validate(f.receipt.id, review, {
          ...authorization,
          criteriaDigest: criteriaDigest(review),
        })
      ).state,
    ).toBe('needs_user')
  } finally {
    f.cleanup()
  }
})
it('keeps the authoritative verification log outside the child-writable runtime directory', async () => {
  const f = await fixture(),
    symlink: AcceptanceCriteria = {
      description: 'log ownership boundary',
      commands: [
        {
          executable: process.execPath,
          args: [
            '-e',
            'const fs=require("fs"),p=require("path");fs.symlinkSync(p.resolve("result.txt"),p.join(process.env.HOME,"output.log"));console.log("host captured output")',
          ],
        },
      ],
    }
  try {
    const result = await f.acceptance.validate(f.receipt.id, symlink, {
      ...authorization,
      criteriaDigest: criteriaDigest(symlink),
    })
    expect(readFileSync(join(f.lease.cwd, 'result.txt'), 'utf8')).toBe(
      'verified artifact',
    )
    expect(result.state).toBe('passed')
    expect(readFileSync(result.evidence[0]!.logRef!, 'utf8')).toContain(
      'host captured output',
    )
  } finally {
    f.cleanup()
  }
})
it('reconciles verification process ownership and quarantines an unprovable writer after restart', async () => {
  const { saveOwnership } = await import('./ownership'),
    f = await fixture(),
    empty: AcceptanceCriteria = { description: '', commands: [] }
  try {
    const pending = await f.acceptance.validate(f.receipt.id, empty, {
      ...authorization,
      criteriaDigest: criteriaDigest(empty),
    })
    saveOwnership(join(f.root, 'state'), {
      schemaVersion: 1,
      pid: process.pid,
      startedAt: 0,
      fingerprint: 'unverifiable-fixture-identity',
      delegationId: f.record.id,
      runId: 'dgr-verification-fixture',
      parentRunId: f.run.id,
      purpose: 'verification',
      generation: 1,
      boundaryReceiptId: pending.id,
      policyDigest: 'host-verification',
      cwd: f.lease.cwd,
      platform: process.platform,
      descendants: [],
    })
    const report = await f.acceptance.reconcile()
    expect(report.needsRecovery).toContain('dgr-verification-fixture')
    expect(f.mutations.hasActiveWriter(f.lease.cwd)).toBe(true)
    await expect(
      f.acceptance.recoverVerification('dgr-verification-fixture'),
    ).rejects.toThrow('OUTCOME_UNKNOWN')
  } finally {
    f.cleanup()
  }
})
it('times out a real verification process and proves its delayed write did not occur', async () => {
  const f = await fixture(),
    late = join(f.lease.cwd, 'late-verifier.txt'),
    timed: AcceptanceCriteria = {
      description: 'bounded verification',
      commands: [
        {
          executable: process.execPath,
          args: [
            '-e',
            'setTimeout(()=>require("fs").writeFileSync("late-verifier.txt","escaped"),2500)',
          ],
          timeoutMs: 1000,
        },
      ],
    }
  try {
    const result = await f.acceptance.validate(f.receipt.id, timed, {
      ...authorization,
      criteriaDigest: criteriaDigest(timed),
    })
    expect(result.state).toBe('failed')
    expect(result.evidence[0]?.quiescent).toBe(true)
    await new Promise((r) => setTimeout(r, 2700))
    const { existsSync } = await import('node:fs')
    expect(existsSync(late)).toBe(false)
  } finally {
    f.cleanup()
  }
}, 20000)
it('returns bounded needs_user and retains the writer when verification shutdown cannot be proved', async () => {
  const { ManagedAgentProcess } = await import('./process'),
    f = await fixture(),
    acceptance = new DelegationAcceptance({
      root: join(f.root, 'state'),
      receipts: f.receipts,
      mutations: f.mutations,
      processes: new ManagedAgentProcess({ identityMatches: () => false }),
      scope: () => ({ taskScopeId: 'task', permission: 'workspace-write' }),
    }),
    blocked: AcceptanceCriteria = {
      description: 'unknown stop proof',
      commands: [
        {
          executable: process.execPath,
          args: ['-e', 'setInterval(()=>{},1000)'],
          timeoutMs: 1000,
        },
      ],
    }
  try {
    const result = await acceptance.validate(f.receipt.id, blocked, {
      ...authorization,
      criteriaDigest: criteriaDigest(blocked),
    })
    expect(result.state).toBe('needs_user')
    expect(result.evidence[0]?.quiescent).toBe(false)
    expect(f.mutations.hasActiveWriter(f.lease.cwd)).toBe(true)
    const { readdirSync } = await import('node:fs'),
      id = readdirSync(join(f.root, 'state/processes'))
        .find((p) => p.startsWith('dgr-verification-'))!
        .slice(0, -5)
    await acceptance.recoverVerification(id)
    expect(f.mutations.hasActiveWriter(f.lease.cwd)).toBe(false)
  } finally {
    const { readdirSync } = await import('node:fs')
    try {
      for (const p of readdirSync(join(f.root, 'state/processes')))
        if (p.startsWith('dgr-verification-'))
          await acceptance.recoverVerification(p.slice(0, -5)).catch(() => {})
    } finally {
      f.cleanup()
    }
  }
}, 20000)

it('protects shared Git metadata and the isolated Git pointer during actual host verification', async () => {
  for (const workspace of ['shared-exclusive', 'isolated-worktree'] as const) {
    const f = await receiptFixture(workspace)
    try {
      const file = join(
          f.lease.cwd,
          workspace === 'shared-exclusive' ? '.git/config' : '.git',
        ),
        before = readFileSync(file)
      const receipt = await f.receipts.collect(f.run.id),
        acceptance = new DelegationAcceptance({
          root: join(f.root, 'state'),
          receipts: f.receipts,
          mutations: f.mutations,
          scope: () => ({ taskScopeId: 'task', permission: 'workspace-write' }),
        })
      const criteria = {
        description: 'Git metadata must remain protected',
        commands: [
          {
            executable: process.execPath,
            args: [
              '-e',
              workspace === 'shared-exclusive'
                ? 'require("fs").appendFileSync(".git/config","\\n# illegal verification write\\n")'
                : 'require("fs").writeFileSync(".git",require("fs").readFileSync(".git"))',
            ],
          },
        ],
      }
      const result = await acceptance.validate(receipt.id, criteria, {
        source: 'host-plan',
        taskScopeId: 'task',
        criteriaDigest: criteriaDigest(criteria),
      })
      expect(result.state).toBe('failed')
      expect(readFileSync(file)).toEqual(before)
    } finally {
      f.cleanup()
    }
  }
}, 45000)
it('rechecks narrowed permission after waiting for the verification workspace lease', async () => {
  const f = await fixture()
  let permission: 'workspace-write' | 'read-only' = 'workspace-write'
  const acceptance = new DelegationAcceptance({
    root: join(f.root, 'state'),
    receipts: f.receipts,
    mutations: f.mutations,
    scope: () => ({ taskScopeId: 'task', permission }),
  })
  const held = await f.mutations.resources.acquire({
    keys: [f.lease.cwd],
    mode: 'exclusive',
    owner: 'hold',
  })
  const criteria = {
    description: 'must not write after narrowing',
    commands: [
      {
        executable: process.execPath,
        args: [
          '-e',
          'require("fs").writeFileSync("permission-late.txt","forbidden")',
        ],
      },
    ],
  }
  const pending = acceptance.validate(f.receipt.id, criteria, {
    source: 'host-plan',
    taskScopeId: 'task',
    criteriaDigest: criteriaDigest(criteria),
  })
  await vi.waitFor(
    () => expect(acceptance.isActive(f.run.id)).toBe(true),
    LOADED,
  )
  permission = 'read-only'
  held.release()
  try {
    await pending
    expect(existsSync(join(f.lease.cwd, 'permission-late.txt'))).toBe(false)
  } finally {
    f.cleanup()
  }
})
