// Ledger fold behaviours ported from the dsh ui-trajectory table spec
// (collapsed turns, collapsed assistant tool runs, request boundaries after
// steering input, coincident request markers, record state and tabs).
import { describe, expect, it } from 'vitest'
import type { TrajectoryTurnModel } from './layout'
import {
  deriveTrajectoryLedger,
  flattenTrajectoryRecords,
  indexTrajectoryRequestBoundaries,
  indexTrajectoryRequestBoundaryRuns,
  indexTrajectoryRequestDisplayNumbers,
  trajectoryAssistantToolCalls,
  trajectoryDetailTabs,
  trajectoryMessageSourceLabel,
  trajectoryParentRecords,
  trajectoryRecordDisplayText,
  trajectoryRecordResultText,
  trajectoryRecordState,
  trajectorySectionLabel,
  trajectoryToolCallTextParts,
} from './ledger'
import type { TrajectoryCellProps } from './record'
import { trajectoryRecordId } from './record'
import {
  trajectoryCollapsibleAssistantIds,
  trajectoryCollapsibleTurnIds,
} from './viewModel'

function cell(
  index: number,
  kind: TrajectoryCellProps['kind'],
  extra: Partial<TrajectoryCellProps> = {},
): TrajectoryCellProps {
  return { index, kind, text: '', timeSeconds: 0, ...extra }
}

const turns: readonly TrajectoryTurnModel[] = [
  {
    turn: 1,
    groups: [
      {
        title: 'Message',
        cells: [
          cell(1, 'system', { text: 'Initial System Prompt' }),
          cell(2, 'user', { previewMarkdown: 'hi', sourceSeq: 2 }),
        ],
      },
      {
        title: 'Step 1',
        cells: [
          cell(3, 'message', {
            recordId: 'assistant\u00001\u00001',
            text: 'Tool call only',
            sourceBlocks: [{ type: 'tool-call', content: '{}', callId: 'c1' }],
          }),
          cell(4, 'tool', { text: 'bash', callId: 'c1', outputDetail: 'ok' }),
          cell(5, 'subtool', { text: 'job:bash', callId: 'job:1' }),
        ],
      },
      {
        title: 'Step 2',
        cells: [
          cell(6, 'user', { previewMarkdown: 'steer', sourceSeq: 6 }),
          cell(7, 'message', {
            recordId: 'assistant\u00001\u00002',
            previewMarkdown: 'done',
          }),
        ],
      },
    ],
  },
  {
    turn: null,
    groups: [
      {
        title: 'Compaction 9',
        cells: [cell(8, 'compacted', { timeSeconds: null })],
      },
    ],
  },
]

describe('trajectory ledger', () => {
  it('flattens turns into rows with group and turn boundaries', () => {
    const rows = flattenTrajectoryRecords(turns)
    expect(
      rows.map((row) => [
        row.cell.index,
        row.section,
        row.group,
        row.groupStart,
        row.turnStart,
        row.turnEnd,
      ]),
    ).toEqual([
      [1, 0, 'Message', true, false, false],
      [2, 0, 'Message', false, true, false],
      [3, 0, 'Step 1', true, false, false],
      [4, 0, 'Step 1', false, false, false],
      [5, 0, 'Step 1', false, false, false],
      [6, 0, 'Step 2', true, false, false],
      [7, 0, 'Step 2', false, false, true],
      [8, 1, 'Compaction 9', true, true, true],
    ])
    expect(trajectorySectionLabel(null)).toBe('Between turns')
    expect(trajectorySectionLabel(3)).toBe('Turn 3')
  })

  it('keeps the first row and a compact summary when a turn is collapsed', () => {
    const rows = deriveTrajectoryLedger(turns, { collapsedTurns: new Set([1]) })
    expect(
      rows.map((row) => [row.cell.index, row.collapsedSummary ?? null]),
    ).toEqual([
      [1, null],
      [2, null],
      [2, '2 steps · 2 tool calls'],
      [8, null],
    ])
    expect(rows[2]).toMatchObject({
      collapsedSummaryKind: 'turn',
      turnEnd: true,
      turnStart: false,
    })
    expect(trajectoryCollapsibleTurnIds(turns)).toEqual([1])
  })

  it('folds the tool rows of a collapsed assistant record', () => {
    const assistantId = trajectoryRecordId(turns[0]!.groups[1]!.cells[0]!)
    expect(trajectoryCollapsibleAssistantIds(turns)).toEqual([assistantId])
    const rows = deriveTrajectoryLedger(turns, {
      collapsedAssistants: new Set([assistantId]),
    })
    expect(
      rows.map((row) => [row.cell.index, row.collapsedSummary ?? null]),
    ).toEqual([
      [1, null],
      [2, null],
      [3, null],
      [3, '2 tool calls · bash, job:bash'],
      [6, null],
      [7, null],
      [8, null],
    ])
    expect(
      trajectoryAssistantToolCalls(flattenTrajectoryRecords(turns), 3).map(
        (row) => row.cell.index,
      ),
    ).toEqual([4, 5])
  })

  it('filters by search matches and recomputes boundaries', () => {
    const rows = deriveTrajectoryLedger(turns, {
      searchMatches: new Set([4, 7]),
    })
    expect(
      rows.map((row) => [
        row.cell.index,
        row.groupStart,
        row.turnStart,
        row.turnEnd,
      ]),
    ).toEqual([
      [4, true, true, false],
      [7, true, false, true],
    ])
  })

  it('places request boundaries after leading steering input and numbers them', () => {
    const rows = flattenTrajectoryRecords(turns)
    const boundaries = indexTrajectoryRequestBoundaries(rows)
    expect(boundaries.get('1\u0000Step 1')).toBe(3)
    expect(boundaries.get('1\u0000Step 2')).toBe(7)
    expect(boundaries.get('null\u0000Compaction 9')).toBe(8)
    const numbers = indexTrajectoryRequestDisplayNumbers(
      rows,
      [{ turn: 1, step: 2, group: 'Step 2', number: 4 }],
      boundaries,
    )
    expect(numbers.get('1\u0000Step 2')).toBe(4)
    expect(numbers.get('1\u0000Step 1')).toBe(5)
  })

  it('lays coincident request markers left to right', () => {
    const rows = flattenTrajectoryRecords([
      {
        turn: 1,
        groups: [
          {
            title: 'Step 1',
            cells: [cell(1, 'message', { requestOnly: true, isError: true })],
          },
          {
            title: 'Step 2',
            cells: [cell(2, 'message', { requestOnly: true })],
          },
          {
            title: 'Step 3',
            cells: [cell(3, 'message', { previewMarkdown: 'ok' })],
          },
        ],
      },
    ])
    expect([...indexTrajectoryRequestBoundaryRuns(rows)]).toEqual([
      [1, 0],
      [2, 1],
      [3, 2],
    ])
  })

  it('derives record state, text, source labels and inspector tabs', () => {
    expect(trajectoryRecordState(cell(1, 'tool'))).toBe('running')
    expect(trajectoryRecordState(cell(1, 'tool', { outputDetail: 'x' }))).toBe(
      'complete',
    )
    expect(
      trajectoryRecordState(cell(1, 'compacted', { timeSeconds: null })),
    ).toBe('running')
    expect(trajectoryRecordState(cell(1, 'message', { isError: true }))).toBe(
      'error',
    )
    expect(
      trajectoryRecordDisplayText(
        cell(1, 'message', { text: 'Tool call only' }),
      ),
    ).toBe('')
    expect(
      trajectoryRecordDisplayText(
        cell(1, 'tool', { text: 'bash', previewMarkdown: '**ls**' }),
      ),
    ).toBe('bash · ls')
    expect(
      trajectoryRecordDisplayText(
        cell(1, 'context', { inputDetail: '# Memory' }),
      ),
    ).toBe('Memory')
    expect(
      trajectoryRecordResultText(
        cell(1, 'tool', { resultPreviewMarkdown: '`ok`' }),
      ),
    ).toBe('ok')
    expect(trajectoryToolCallTextParts('tool', 'bash · ls')).toEqual({
      name: 'bash',
      args: 'ls',
    })
    expect(trajectoryToolCallTextParts('message', 'x')).toBeUndefined()
    expect(
      trajectoryMessageSourceLabel({ kind: 'context', producer: 'memory' }),
    ).toBe('Context · memory')
    expect(
      trajectoryMessageSourceLabel({ kind: 'event', type: 'goal/change' }),
    ).toBe('Event · goal/change')
    expect(trajectoryMessageSourceLabel({ kind: 'user' })).toBe('User')
    expect(trajectoryMessageSourceLabel(null)).toBe('Unknown')
    expect(
      trajectoryDetailTabs(cell(1, 'system')).map((tab) => tab.id),
    ).toEqual(['system-prompt', 'tools'])
    expect(
      trajectoryDetailTabs(
        cell(1, 'system', {
          previousPromptDetail: {
            config: { provider: 'p', model: 'm' },
            system: '',
            tools: [],
          },
        }),
      ).map((tab) => tab.id),
    ).toEqual(['system-prompt', 'tools', 'diff'])
    expect(
      trajectoryDetailTabs(cell(1, 'user', { messageSource: {} })).map(
        (tab) => tab.id,
      ),
    ).toEqual(['overview', 'rendered', 'raw', 'source'])
    expect(
      trajectoryDetailTabs(
        cell(1, 'tool', { inputDetail: '{}', outputDetail: 'x' }),
      ).map((tab) => tab.id),
    ).toEqual(['overview', 'input', 'output', 'schema', 'timing'])
    expect(
      trajectoryDetailTabs(cell(1, 'compacted')).map((tab) => tab.id),
    ).toEqual(['overview', 'raw'])
  })

  it('finds the parent assistant and tool of a subtool row', () => {
    const rows = flattenTrajectoryRecords(turns)
    const subtool = rows.find((row) => row.cell.index === 5)!
    const parents = trajectoryParentRecords(rows, subtool)
    expect(parents.tool?.cell.index).toBe(4)
    expect(parents.message?.cell.index).toBe(3)
    expect(trajectoryParentRecords(rows, rows[0]!)).toEqual({})
  })
})
