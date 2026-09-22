import { describe, expect, it, vi } from 'vitest'
import { createTrajectoryDurationStore } from './durationStore'
import type { TrajectoryTurnModel } from './layout'
import { extractMarkdownPlainText, trajectoryPreviewText } from './preview'
import { TrajectorySearchIndex } from './searchIndex'
import { trajectorySearchMatchIndexes } from './viewModel'

const turns: readonly TrajectoryTurnModel[] = [
  {
    turn: 1,
    groups: [
      {
        title: 'Message',
        cells: [
          {
            index: 1,
            kind: 'user',
            text: '',
            previewMarkdown: 'Pick a **Color**',
            sourceSeq: 10,
            timeSeconds: 0,
          },
        ],
      },
      {
        title: 'Step 1',
        cells: [
          {
            index: 2,
            kind: 'message',
            text: '',
            recordId: 'assistant\u00001\u00001',
            requestOnly: true,
            timeSeconds: null,
          },
          {
            index: 3,
            kind: 'tool',
            text: 'bash',
            callId: 'call_bash',
            inputDetail: '{"command":"echo alpha"}',
            resultPreviewMarkdown: 'alpha output',
            childSessionId: 'sub-7',
            timeSeconds: 1,
          },
        ],
      },
    ],
  },
]

describe('TrajectorySearchIndex', () => {
  it('matches every term case-insensitively across record sources', () => {
    const index = new TrajectorySearchIndex()
    expect(index.search('anything')?.size).toBe(0)
    const layouts = [turns]
    expect(index.update(layouts)).toBe(true)
    expect(index.update(layouts)).toBe(false)
    expect(index.size).toBe(2)
    expect(index.search('   ')).toBeNull()
    expect([...(index.search('COLOR') ?? [])]).toEqual([
      'user\u0000seq\u000010',
    ])
    expect([...(index.search('bash alpha') ?? [])]).toEqual([
      'tool\u0000call\u0000call_bash',
    ])
    expect([...(index.search('turn 1 sub-7') ?? [])]).toEqual([
      'tool\u0000call\u0000call_bash',
    ])
    expect(index.search('bash color')?.size).toBe(0)
    expect(
      trajectorySearchMatchIndexes([turns], index.search('step 1')),
    ).toEqual(new Set([3]))
    expect(trajectorySearchMatchIndexes([turns], null)).toBeNull()
  })

  it('drops records that left the layout and reuses unchanged entries', () => {
    const index = new TrajectorySearchIndex()
    index.update([turns])
    const trimmed: readonly TrajectoryTurnModel[] = [
      { turn: 1, groups: [turns[0]!.groups[0]!] },
    ]
    index.update([trimmed])
    expect(index.size).toBe(1)
    expect(index.search('bash')?.size).toBe(0)
  })
})

describe('trajectory preview', () => {
  it('strips Markdown markup while keeping raw HTML, labels and alt text', () => {
    expect(
      extractMarkdownPlainText(
        '# Title\n\nSome **bold** [link](https://x.y) ![alt text](a.png) <kbd>K</kbd>\n\n```ts\nconst a = 1\n```\n\n- one\n- two',
      ),
    ).toBe(
      'Title\n\nSome bold link alt text <kbd>K</kbd>\n\nconst a = 1\n\none\ntwo',
    )
  })

  it('bounds the one-line preview', () => {
    expect(trajectoryPreviewText('a\n\n  b')).toBe('a b')
    const long = trajectoryPreviewText('word '.repeat(1_000))
    expect(long.endsWith('…')).toBe(true)
    expect(long.length).toBeLessThanOrEqual(513)
  })
})

describe('trajectory duration store', () => {
  it('persists and notifies the preference', () => {
    const values = new Map<string, string>()
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
    }
    const store = createTrajectoryDurationStore(storage)
    const listener = vi.fn()
    const unsubscribe = store.subscribe(listener)
    expect(store.get()).toBe(false)
    store.set(true)
    store.set(true)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(createTrajectoryDurationStore(storage).get()).toBe(true)
    unsubscribe()
    store.set(false)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('works without storage and survives throwing storage', () => {
    const throwing = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    }
    const store = createTrajectoryDurationStore(throwing)
    expect(store.get()).toBe(false)
    store.set(true)
    expect(store.get()).toBe(true)
    expect(createTrajectoryDurationStore(undefined).get()).toBe(false)
  })
})
