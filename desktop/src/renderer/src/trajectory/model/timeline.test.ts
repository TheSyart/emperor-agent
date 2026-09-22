// Timeline projection ported from the dsh ui-trajectory views spec
// ("timeline projection"), plus the brush / zoom / pan math extracted from
// the dsh TrajectoryTimeline component.
import { describe, expect, it } from 'vitest'
import type { TrajectoryTurnModel } from './layout'
import {
  commitTimelineBrush,
  deriveTrajectoryTimeline,
  edgePanTimelineStart,
  nearestTimelineSpan,
  panTimelineViewport,
  rangeFraction,
  retainTimelineRange,
  revealTimelineSpan,
  timelineDomain,
  timelineRecordDetail,
  timelineTooltipLabel,
  timelineTtftFraction,
  trajectoryTimelineFocusIndexes,
  visibleTimelineSpans,
  zoomTimelineViewport,
  type TrajectoryTimelineModel,
} from './timeline'

const turns = [
  {
    turn: 1,
    groups: [
      {
        title: 'Step 1',
        cells: [
          {
            index: 1,
            kind: 'message',
            text: 'assistant',
            startedAt: 1_000,
            timeSeconds: 1,
          },
          {
            index: 2,
            kind: 'tool',
            text: 'bash',
            startedAt: 2_000,
            timeSeconds: 1,
          },
          { index: 3, kind: 'user', text: 'unknown', timeSeconds: 0 },
        ],
      },
    ],
  },
] satisfies readonly TrajectoryTurnModel[]

const separatedTurns = [
  {
    turn: 1,
    groups: [
      {
        title: 'Step 1',
        cells: [
          {
            index: 1,
            kind: 'message',
            text: 'first',
            startedAt: 1_000,
            timeSeconds: 1,
          },
          {
            index: 2,
            kind: 'tool',
            text: 'within-turn gap',
            startedAt: 4_000,
            timeSeconds: 1,
          },
        ],
      },
    ],
  },
  {
    turn: 2,
    groups: [
      {
        title: 'Step 1',
        cells: [
          {
            index: 3,
            kind: 'message',
            text: 'after user idle',
            startedAt: 40_000,
            timeSeconds: 1,
          },
        ],
      },
    ],
  },
] satisfies readonly TrajectoryTurnModel[]

function sequenceModel(count: number): TrajectoryTimelineModel {
  const model = deriveTrajectoryTimeline([
    {
      turn: 1,
      groups: [
        {
          title: 'Step 1',
          cells: Array.from({ length: count }, (_, index) => ({
            index: index + 1,
            kind: 'message' as const,
            text: `record ${index}`,
            timeSeconds: 1,
          })),
        },
      ],
    },
  ])
  if (model === null) throw new Error('no model')
  return model
}

describe('timeline projection', () => {
  it('uses equal-width operation slots and stable semantic lanes', () => {
    expect(deriveTrajectoryTimeline(turns)).toEqual({
      start: 0,
      end: 3,
      spans: [
        {
          index: 1,
          isError: false,
          kind: 'message',
          label: 'assistant',
          lane: 1,
          start: 0,
          end: 1,
        },
        {
          index: 2,
          isError: false,
          kind: 'tool',
          label: 'bash',
          lane: 2,
          start: 1,
          end: 2,
        },
        {
          index: 3,
          isError: false,
          kind: 'user',
          label: 'unknown',
          lane: 0,
          start: 2,
          end: 3,
        },
      ],
      turnBoundaries: [{ turn: 1, time: 0 }],
    })
  })

  it('marks error records directly on timeline spans', () => {
    const model = deriveTrajectoryTimeline([
      {
        turn: 1,
        groups: [
          {
            title: 'Step 1',
            cells: [
              {
                index: 1,
                kind: 'tool',
                text: 'failed tool',
                timeSeconds: 0.1,
                isError: true,
              },
            ],
          },
        ],
      },
    ])
    expect(model?.spans[0]).toMatchObject({
      kind: 'tool',
      isError: true,
      lane: 2,
    })
  })

  it('ignores durations and idle gaps while retaining turn boundaries', () => {
    expect(deriveTrajectoryTimeline(separatedTurns)).toMatchObject({
      start: 0,
      end: 3,
      spans: [
        { index: 1, start: 0, end: 1 },
        { index: 2, start: 1, end: 2 },
        { index: 3, start: 2, end: 3 },
      ],
      turnBoundaries: [
        { turn: 1, time: 0 },
        { turn: 2, time: 2 },
      ],
    })
  })

  it('compresses every idle gap in duration mode while actual mode retains wall time', () => {
    expect(deriveTrajectoryTimeline(separatedTurns, 'duration')).toMatchObject({
      start: 1_000,
      end: 4_000,
      spans: [
        { index: 1, start: 1_000, end: 2_000 },
        { index: 2, start: 2_000, end: 3_000 },
        { index: 3, start: 3_000, end: 4_000 },
      ],
      turnBoundaries: [
        { turn: 1, time: 1_000 },
        { turn: 2, time: 3_000 },
      ],
    })
    expect(deriveTrajectoryTimeline(separatedTurns, 'actual')).toMatchObject({
      start: 1_000,
      end: 41_000,
      spans: [
        { index: 1, start: 1_000, end: 2_000 },
        { index: 2, start: 4_000, end: 5_000 },
        { index: 3, start: 40_000, end: 41_000 },
      ],
    })
    // 'time' keeps wall-clock starts with equal (zero-width) durations.
    expect(
      deriveTrajectoryTimeline(separatedTurns, 'time')?.spans,
    ).toMatchObject([
      { start: 1_000, end: 1_000 },
      { start: 4_000, end: 4_000 },
      { start: 40_000, end: 40_000 },
    ])
  })

  it('projects between-turn compaction without inventing a turn boundary', () => {
    const withStandaloneCompaction = [
      {
        turn: 1,
        groups: [
          {
            title: 'Step 1',
            cells: [
              { index: 1, kind: 'message', text: 'before', timeSeconds: 0 },
            ],
          },
        ],
      },
      {
        turn: null,
        groups: [
          {
            title: 'Compaction 3',
            cells: [
              { index: 2, kind: 'compacted', text: 'summary', timeSeconds: 0 },
            ],
          },
        ],
      },
      {
        turn: 2,
        groups: [
          {
            title: 'Step 1',
            cells: [
              { index: 3, kind: 'message', text: 'after', timeSeconds: 0 },
            ],
          },
        ],
      },
    ] satisfies readonly TrajectoryTurnModel[]

    expect(deriveTrajectoryTimeline(withStandaloneCompaction)).toMatchObject({
      spans: [
        { index: 1, start: 0, end: 1 },
        { index: 2, start: 1, end: 2 },
        { index: 3, start: 2, end: 3 },
      ],
      turnBoundaries: [
        { turn: 1, time: 0 },
        { turn: 2, time: 2 },
      ],
    })
  })

  it('skips request-only boundaries and returns no model for empty input', () => {
    expect(deriveTrajectoryTimeline([])).toBeNull()
    expect(
      deriveTrajectoryTimeline([
        {
          turn: 1,
          groups: [
            {
              title: 'Step 1',
              cells: [
                {
                  index: 1,
                  kind: 'message',
                  text: '',
                  requestOnly: true,
                  timeSeconds: 1,
                },
              ],
            },
          ],
        },
      ]),
    ).toBeNull()
    expect(
      deriveTrajectoryTimeline(turns, 'actual')?.spans.map(
        (span) => span.index,
      ),
    ).toEqual([1, 2])
  })

  it('focuses records overlapping an inclusive range', () => {
    expect([
      ...trajectoryTimelineFocusIndexes(turns, { start: 1, end: 1.5 }),
    ]).toEqual([1, 2])
    expect([
      ...trajectoryTimelineFocusIndexes(
        separatedTurns,
        { start: 4_500, end: 39_000 },
        'actual',
      ),
    ]).toEqual([2])
  })
})

describe('timeline record details', () => {
  it('splits assistant time into recorded TTFT and decoding', () => {
    const detail = timelineRecordDetail({
      index: 1,
      kind: 'message',
      text: '',
      timeSeconds: 1,
      startedAt: 1_000,
      assistantMetrics: {
        timingRecorded: true,
        stepStartTime: 1_000,
        firstTokenTime: 1_250,
        completedTime: 2_000,
        usageProvided: false,
        outputTokens: null,
      },
    })
    expect(detail).toEqual({
      durationMs: 1_000,
      startedAt: 1_000,
      ttftMs: 250,
      decodingMs: 750,
    })
    expect(timelineTtftFraction(detail)).toBe(0.25)
    expect(timelineTooltipLabel('message', detail).split('\n')[0]).toBe(
      'ASSISTANT',
    )
    expect(timelineTooltipLabel('message', detail)).toContain(
      'TTFT 250 ms · Decoding 750 ms',
    )
    expect(
      timelineTtftFraction(
        timelineRecordDetail({
          index: 2,
          kind: 'tool',
          text: '',
          timeSeconds: null,
        }),
      ),
    ).toBeNull()
  })
})

describe('timeline brush, zoom and pan', () => {
  it('clamps a zoomed viewport and reports the visible domain', () => {
    const model = sequenceModel(10)
    expect(timelineDomain(model, null)).toEqual({
      fullDuration: 10,
      start: 0,
      duration: 10,
      zoomed: false,
    })
    expect(timelineDomain(model, { start: 8, end: 12 })).toEqual({
      fullDuration: 10,
      start: 6,
      duration: 4,
      zoomed: true,
    })
    expect(retainTimelineRange(model, { start: 11, end: 12 })).toBeNull()
    expect(retainTimelineRange(model, { start: 2, end: 3 })).toEqual({
      start: 2,
      end: 3,
    })
  })

  it('zooms around the pointer with a minimum of four operations', () => {
    const model = sequenceModel(10)
    const full = timelineDomain(model, null)
    const zoomed = zoomTimelineViewport(model, full, 0.5, -10_000, 'sequence')
    expect(zoomed).toEqual({ start: 3, end: 7 })
    // Zooming back out past the full domain drops the viewport.
    expect(
      zoomTimelineViewport(
        model,
        timelineDomain(model, zoomed),
        0.5,
        10_000,
        'sequence',
      ),
    ).toBeNull()
  })

  it('pans within the model and auto-pans at the edges while brushing', () => {
    const model = sequenceModel(10)
    expect(panTimelineViewport(model, 3, 4, 0.5)).toEqual({ start: 1, end: 5 })
    expect(panTimelineViewport(model, 3, 4, 5)).toEqual({ start: 0, end: 4 })
    const domain = timelineDomain(model, { start: 3, end: 7 })
    expect(edgePanTimelineStart(model, domain, 200, 400)).toBe(3)
    expect(edgePanTimelineStart(model, domain, 0, 400)).toBeLessThan(3)
    expect(edgePanTimelineStart(model, domain, 400, 400)).toBeGreaterThan(3)
    expect(
      edgePanTimelineStart(model, timelineDomain(model, null), 0, 400),
    ).toBe(0)
  })

  it('reveals a selected span outside the viewport', () => {
    const model = sequenceModel(10)
    const viewport = { start: 0, end: 4 }
    expect(revealTimelineSpan(model, viewport, { start: 2, end: 3 })).toBe(
      viewport,
    )
    expect(revealTimelineSpan(model, viewport, { start: 8, end: 9 })).toEqual({
      start: 5,
      end: 9,
    })
    expect(
      revealTimelineSpan(model, { start: 6, end: 10 }, { start: 1, end: 2 }),
    ).toEqual({ start: 1, end: 5 })
    expect(revealTimelineSpan(model, null, { start: 8, end: 9 })).toBeNull()
  })

  it('commits clicks as one-slot ranges and keeps wide drags', () => {
    const model = sequenceModel(10)
    const domain = timelineDomain(model, null)
    expect(commitTimelineBrush(model, domain, 4.2, 4.2, true)).toEqual({
      start: 3.7,
      end: 4.7,
    })
    expect(commitTimelineBrush(model, domain, 6, 2, false)).toEqual({
      start: 2,
      end: 6,
    })
    expect(commitTimelineBrush(model, domain, 9.9, 9.95, false)).toEqual({
      start: 9,
      end: 10,
    })
    expect(nearestTimelineSpan(model, 4.2)?.index).toBe(5)
    expect(nearestTimelineSpan(model, 42)?.index).toBe(10)
  })

  it('maps ranges to visible-domain fractions and filters visible spans', () => {
    const model = sequenceModel(10)
    const domain = timelineDomain(model, { start: 2, end: 6 })
    expect(
      rangeFraction(
        { start: 3, end: 5 },
        domain.start,
        domain.duration,
        model.start,
        model.end,
      ),
    ).toEqual({
      start: 0.25,
      end: 0.75,
    })
    expect(
      visibleTimelineSpans(model, domain, 10).map((span) => span.index),
    ).toEqual([2, 3, 4, 5, 6, 7, 10])
  })
})
