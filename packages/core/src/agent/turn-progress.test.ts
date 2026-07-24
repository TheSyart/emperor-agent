import { describe, expect, it } from 'vitest'
import { ToolResultObj } from '../tools/base'
import { TurnProgressLedger } from './turn-progress'

describe('TurnProgressLedger', () => {
  it('does not count an identical mutation and result as new progress', () => {
    const ledger = new TurnProgressLedger()
    const call = {
      id: 'edit_1',
      name: 'edit_file',
      arguments: { path: 'index.html', old: 'a', replacement: 'b' },
    }
    const result = ToolResultObj.fromText('updated index.html')

    ledger.recordToolResult(call, result, { executed: true, readOnly: false })
    ledger.finishIteration()
    ledger.recordToolResult({ ...call, id: 'edit_2' }, result, {
      executed: true,
      readOnly: false,
    })
    ledger.finishIteration()

    expect(ledger.snapshot()).toMatchObject({
      meaningfulProgress: 1,
      noProgressIterations: 1,
      lastIterationHadError: false,
      successfulChanges: ['edit_file:index.html'],
    })
  })

  it('counts only previously uncovered read_file ranges as new evidence', () => {
    const ledger = new TurnProgressLedger()
    const read = (id: string, offset: number, limit: number, text: string) => {
      ledger.recordToolResult(
        {
          id,
          name: 'read_file',
          arguments: { path: 'large.ts', offset, limit },
        },
        ToolResultObj.fromText(text),
        { executed: true, readOnly: true },
      )
      ledger.finishIteration()
    }

    read('read_1', 1, 200, '1\tfirst\n200\tlast')
    read('read_2', 50, 50, '50\tmiddle\n99\tcovered')
    read('read_3', 201, 100, '201\tnew\n300\tlast')

    expect(ledger.snapshot()).toMatchObject({
      meaningfulProgress: 2,
      repeatedReadCount: 1,
      noProgressIterations: 0,
    })
  })

  it('treats the same read range as new evidence after a successful mutation', () => {
    const ledger = new TurnProgressLedger()
    const readCall = {
      id: 'read_1',
      name: 'read_file',
      arguments: { path: 'index.html', offset: 1, limit: 50 },
    }

    ledger.recordToolResult(readCall, ToolResultObj.fromText('1\tbefore'), {
      executed: true,
      readOnly: true,
    })
    ledger.finishIteration()
    ledger.recordToolResult(
      {
        id: 'edit_1',
        name: 'edit_file',
        arguments: {
          path: 'index.html',
          old_text: 'before',
          new_text: 'after',
        },
      },
      ToolResultObj.fromText('updated index.html'),
      { executed: true, readOnly: false },
    )
    ledger.finishIteration()
    ledger.recordToolResult(
      { ...readCall, id: 'read_2' },
      ToolResultObj.fromText('1\tafter'),
      { executed: true, readOnly: true },
    )
    ledger.finishIteration()

    expect(ledger.snapshot()).toMatchObject({
      meaningfulProgress: 3,
      repeatedReadCount: 0,
      noProgressIterations: 0,
    })
  })

  it('counts only verification evidence as progress during the verifying phase', () => {
    const ledger = new TurnProgressLedger()
    ledger.recordToolResult(
      {
        id: 'unrelated_edit',
        name: 'edit_file',
        arguments: { path: 'extra.html' },
      },
      ToolResultObj.fromText('updated extra.html'),
      {
        executed: true,
        readOnly: false,
        planPhase: 'verifying',
        verificationEvidence: false,
      },
    )
    ledger.finishIteration()
    ledger.recordToolResult(
      {
        id: 'declared_test',
        name: 'run_command',
        arguments: { command: 'npm test' },
      },
      ToolResultObj.fromText('tests passed'),
      {
        executed: true,
        readOnly: false,
        planPhase: 'verifying',
        verificationEvidence: true,
      },
    )
    ledger.finishIteration()

    expect(ledger.snapshot()).toMatchObject({
      meaningfulProgress: 1,
      noProgressIterations: 0,
      successfulChanges: [],
      successfulEvidence: ['run_command:npm test'],
    })
  })
})
