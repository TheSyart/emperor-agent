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

  it('does not count follow-up-required results as progress', () => {
    const ledger = new TurnProgressLedger()
    ledger.recordToolResult(
      {
        id: 'redirect_1',
        name: 'web_fetch',
        arguments: { url: 'https://a.test' },
      },
      ToolResultObj.fromText('redirect', {
        meta: {
          outcome: 'followup_required',
          strategy_key: 'web_fetch:https://a.test:redirect',
        },
      }),
      { executed: true, readOnly: true },
    )
    ledger.finishIteration()

    expect(ledger.snapshot()).toMatchObject({
      meaningfulProgress: 0,
      noProgressIterations: 1,
      lastIterationHadError: false,
      repeatedFailureStrategyKey: 'web_fetch:https://a.test:redirect',
      repeatedFailureStrategyCount: 1,
    })
  })

  it('tracks consecutive failures of the same strategy', () => {
    const ledger = new TurnProgressLedger()
    for (let index = 0; index < 3; index += 1) {
      ledger.recordToolResult(
        {
          id: `fetch_${index}`,
          name: 'web_fetch',
          arguments: { url: 'https://a.test' },
        },
        ToolResultObj.fromText('not found', {
          isError: true,
          meta: {
            outcome: 'failure',
            failure_kind: 'http_status',
            strategy_key: 'web_fetch:https://a.test:status',
          },
        }),
        { executed: true, readOnly: true },
      )
      ledger.finishIteration()
    }

    expect(ledger.snapshot()).toMatchObject({
      repeatedFailureStrategyKey: 'web_fetch:https://a.test:status',
      repeatedFailureStrategyCount: 3,
    })
  })

  it('records external evidence only when a successful result has a source URL', () => {
    const ledger = new TurnProgressLedger()
    ledger.recordToolResult(
      { id: 'search_empty', name: 'web_search', arguments: { query: 'news' } },
      ToolResultObj.fromText('no sources', {
        meta: { outcome: 'success', results: [] },
      }),
      { executed: true, readOnly: true, externalContent: true },
    )
    ledger.recordToolResult(
      {
        id: 'fetch_ok',
        name: 'web_fetch',
        arguments: { url: 'https://example.com/news' },
      },
      ToolResultObj.fromText(
        'news\nbackup source: https://second.example/report',
        {
          meta: {
            outcome: 'success',
            url: 'https://example.com/news',
            http_status: 200,
            success_scope: 'response_body',
            evidence_disposition: 'verified',
          },
        },
      ),
      { executed: true, readOnly: true, externalContent: true },
    )

    expect(ledger.snapshot().externalEvidenceUrls).toEqual([
      'https://example.com/news',
      'https://second.example/report',
    ])
  })

  it('counts a new command URL only as candidate discovery and ignores an identical retry', () => {
    const ledger = new TurnProgressLedger()
    const call = {
      id: 'external_command_1',
      name: 'run_command',
      arguments: { command: 'agent-reach search politics' },
    }
    const result = ToolResultObj.fromText(
      'headline https://news.example/politics',
      {
        meta: {
          outcome: 'success',
          evidence_disposition: 'candidate',
          workspace_effect: 'none',
          verification_required: true,
        },
      },
    )

    ledger.recordToolResult(call, result, {
      executed: true,
      readOnly: false,
      externalContent: true,
    })
    ledger.finishIteration()
    ledger.recordToolResult({ ...call, id: 'external_command_2' }, result, {
      executed: true,
      readOnly: false,
      externalContent: true,
    })
    ledger.finishIteration()

    expect(ledger.snapshot()).toMatchObject({
      meaningfulProgress: 1,
      noProgressIterations: 1,
      successfulChanges: [],
      successfulEvidence: [],
      externalEvidenceUrls: [],
      externalCandidateUrls: ['https://news.example/politics'],
    })
  })

  it('does not count an empty non-mutating process success as meaningful progress', () => {
    const ledger = new TurnProgressLedger()
    ledger.recordToolResult(
      {
        id: 'empty_command',
        name: 'run_command',
        arguments: { command: 'true' },
      },
      ToolResultObj.fromText('', {
        meta: {
          outcome: 'success',
          evidence_disposition: 'none',
          workspace_effect: 'none',
        },
      }),
      { executed: true, readOnly: false },
    )
    ledger.finishIteration()

    expect(ledger.snapshot()).toMatchObject({
      meaningfulProgress: 0,
      noProgressIterations: 1,
      successfulChanges: [],
      successfulEvidence: [],
    })
  })
})
