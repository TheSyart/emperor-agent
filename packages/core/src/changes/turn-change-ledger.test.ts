import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { TurnChangeLedger } from './turn-change-ledger'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'emperor-turn-changes-'))
  const stateRoot = join(root, '.emperor')
  const workspaceRoot = join(root, 'workspace')
  mkdirSync(workspaceRoot, { recursive: true })
  return {
    root,
    stateRoot,
    workspaceRoot,
    ledger: new TurnChangeLedger({ stateRoot }),
  }
}

describe('TurnChangeLedger', () => {
  it('computes exact net line changes from the first agent-owned mutation', async () => {
    const test = fixture()
    const path = join(test.workspaceRoot, 'app.ts')
    writeFileSync(path, 'alpha\nbeta\n')

    const captured = await test.ledger.capture(
      {
        sessionId: 'session_1',
        turnId: 'turn_1',
        toolCallId: 'call_1',
        toolName: 'edit_file',
        workspaceRoot: test.workspaceRoot,
        paths: [path],
      },
      async () => writeFileSync(path, 'alpha\ngamma\ndelta\n'),
    )

    expect(captured.snapshot).toMatchObject({
      status: 'tracking',
      filesChanged: 1,
      additions: 2,
      deletions: 1,
      binaryFiles: 0,
      truncated: false,
      files: [
        {
          path: 'app.ts',
          kind: 'modified',
          additions: 2,
          deletions: 1,
          binary: false,
        },
      ],
    })
  })

  it('merges repeated mutations and removes a file restored to its baseline', async () => {
    const test = fixture()
    const path = join(test.workspaceRoot, 'app.ts')
    writeFileSync(path, 'before\n')
    const input = {
      sessionId: 'session_1',
      turnId: 'turn_1',
      toolCallId: 'call_1',
      toolName: 'edit_file',
      workspaceRoot: test.workspaceRoot,
      paths: [path],
    }

    await test.ledger.capture(input, async () =>
      writeFileSync(path, 'changed\n'),
    )
    const restored = await test.ledger.capture(
      { ...input, toolCallId: 'call_2' },
      async () => writeFileSync(path, 'before\n'),
    )

    expect(restored.snapshot).toMatchObject({
      filesChanged: 0,
      additions: 0,
      deletions: 0,
      files: [],
    })
  })

  it('keeps one execution ledger across control-resumed model turns', async () => {
    const test = fixture()
    const path = join(test.workspaceRoot, 'index.html')
    writeFileSync(path, '')

    await test.ledger.capture(
      {
        sessionId: 'session_1',
        executionId: 'execution_1',
        rootTurnId: 'turn_1',
        turnId: 'turn_1',
        toolCallId: 'call_1',
        toolName: 'write_file',
        workspaceRoot: test.workspaceRoot,
        paths: [path],
      },
      async () => writeFileSync(path, '<main>\n'),
    )
    const resumed = await test.ledger.capture(
      {
        sessionId: 'session_1',
        executionId: 'execution_1',
        rootTurnId: 'turn_1',
        turnId: 'turn_2',
        toolCallId: 'call_2',
        toolName: 'edit_file',
        workspaceRoot: test.workspaceRoot,
        paths: [path],
      },
      async () => writeFileSync(path, '<main>\n</main>\n'),
    )

    expect(resumed.snapshot).toMatchObject({
      version: 2,
      executionId: 'execution_1',
      rootTurnId: 'turn_1',
      activeTurnId: 'turn_2',
      turnId: 'turn_2',
      filesChanged: 1,
      additions: 2,
      deletions: 0,
    })
    const final = await test.ledger.finalize({
      sessionId: 'session_1',
      executionId: 'execution_1',
      turnId: 'turn_2',
    })
    expect(final).toMatchObject({
      version: 2,
      executionId: 'execution_1',
      rootTurnId: 'turn_1',
      activeTurnId: 'turn_2',
      filesChanged: 1,
      additions: 2,
    })
  })

  it('coalesces a content-preserving rename into one changed file', async () => {
    const test = fixture()
    const oldPath = join(test.workspaceRoot, 'old.txt')
    const newPath = join(test.workspaceRoot, 'new.txt')
    writeFileSync(oldPath, 'same\n')

    const result = await test.ledger.capture(
      {
        sessionId: 'session_1',
        turnId: 'turn_1',
        toolCallId: 'call_rename',
        toolName: 'rename_file',
        workspaceRoot: test.workspaceRoot,
        paths: [oldPath, newPath],
      },
      async () => {
        const content = readFileSync(oldPath)
        writeFileSync(newPath, content)
        await import('node:fs/promises').then(({ unlink }) => unlink(oldPath))
      },
    )

    expect(result.snapshot.files).toEqual([
      {
        path: 'new.txt',
        kind: 'renamed',
        additions: 0,
        deletions: 0,
        binary: false,
      },
    ])
  })

  it('persists active baselines and finalizes binary changes without fake line counts', async () => {
    const test = fixture()
    const path = join(test.workspaceRoot, 'asset.bin')
    writeFileSync(path, Buffer.from([0, 1, 2]))
    await test.ledger.capture(
      {
        sessionId: 'session_1',
        turnId: 'turn_1',
        toolCallId: 'call_1',
        toolName: 'write_file',
        workspaceRoot: test.workspaceRoot,
        paths: [path],
      },
      async () => writeFileSync(path, Buffer.from([0, 1, 3])),
    )

    const restarted = new TurnChangeLedger({ stateRoot: test.stateRoot })
    const final = await restarted.finalize({
      sessionId: 'session_1',
      turnId: 'turn_1',
    })

    expect(final).toMatchObject({
      status: 'complete',
      filesChanged: 1,
      additions: 0,
      deletions: 0,
      binaryFiles: 1,
      files: [
        {
          path: 'asset.bin',
          kind: 'modified',
          additions: null,
          deletions: null,
          binary: true,
        },
      ],
    })
  })

  it('does not attribute a later external edit to the agent task', async () => {
    const test = fixture()
    const path = join(test.workspaceRoot, 'app.ts')
    writeFileSync(path, 'before\n')

    await test.ledger.capture(
      {
        sessionId: 'session_1',
        turnId: 'turn_1',
        toolCallId: 'call_1',
        toolName: 'edit_file',
        workspaceRoot: test.workspaceRoot,
        paths: [path],
      },
      async () => writeFileSync(path, 'agent\n'),
    )
    writeFileSync(path, 'external\nextra\n')

    const final = await test.ledger.finalize({
      sessionId: 'session_1',
      turnId: 'turn_1',
    })

    expect(final).toMatchObject({
      status: 'partial',
      filesChanged: 1,
      additions: 1,
      deletions: 1,
      files: [
        {
          path: 'app.ts',
          kind: 'modified',
          additions: 1,
          deletions: 1,
        },
      ],
    })
  })

  it('keeps only confirmed changes when an external edit appears between mutations', async () => {
    const test = fixture()
    const path = join(test.workspaceRoot, 'app.ts')
    writeFileSync(path, 'before\n')
    const baseInput = {
      sessionId: 'session_1',
      turnId: 'turn_1',
      toolCallId: 'call_1',
      toolName: 'edit_file',
      workspaceRoot: test.workspaceRoot,
      paths: [path],
    }

    await test.ledger.capture(baseInput, async () =>
      writeFileSync(path, 'agent-one\n'),
    )
    writeFileSync(path, 'external\n')
    const second = await test.ledger.capture(
      { ...baseInput, toolCallId: 'call_2' },
      async () => writeFileSync(path, 'agent-two\nextra\n'),
    )

    expect(second.snapshot).toMatchObject({
      status: 'partial',
      filesChanged: 1,
      additions: 1,
      deletions: 1,
      files: [
        {
          path: 'app.ts',
          kind: 'modified',
          additions: 1,
          deletions: 1,
        },
      ],
    })
  })

  it('marks a failed mutation that changed disk as partial without claiming it', async () => {
    const test = fixture()
    const path = join(test.workspaceRoot, 'app.ts')
    writeFileSync(path, 'before\n')

    await expect(
      test.ledger.capture(
        {
          sessionId: 'session_1',
          turnId: 'turn_1',
          toolCallId: 'call_1',
          toolName: 'edit_file',
          workspaceRoot: test.workspaceRoot,
          paths: [path],
        },
        async () => {
          writeFileSync(path, 'partial-write\n')
          throw new Error('simulated failure')
        },
      ),
    ).rejects.toThrow('simulated failure')

    const snapshot = await test.ledger.snapshot({
      sessionId: 'session_1',
      turnId: 'turn_1',
    })
    expect(snapshot).toMatchObject({
      status: 'partial',
      filesChanged: 0,
      additions: 0,
      deletions: 0,
      files: [],
    })
  })
})
