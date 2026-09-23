import { describe, expect, it } from 'vitest'
import type { PullRequestListItem } from '../../../api/pullRequests'
import {
  applyClientFilters,
  checkOutcome,
  checksSummary,
  clampListWidth,
  emptyListMessage,
  groupPullRequests,
  LIST_WIDTH_DEFAULT,
  LIST_WIDTH_KEY,
  LIST_WIDTH_MAX,
  LIST_WIDTH_MIN,
  pullRefFromParams,
  pullRouteParams,
  prepareBodyMarkdown,
  pullStateBadge,
  readListWidth,
  relativeAgeZh,
  relativeAgoZh,
  reviewDecisionLabel,
  sortChecks,
  stepIndex,
  stripHtmlComments,
  visiblePulls,
  writeListWidth,
} from './pullRequestModel'

const NOW = Date.parse('2026-09-23T12:00:00.000Z')
const ago = (ms: number) => new Date(NOW - ms).toISOString()
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

function item(patch: Partial<PullRequestListItem>): PullRequestListItem {
  return {
    repo: 'acme/widgets',
    number: 1,
    title: 'Title',
    state: 'OPEN',
    isDraft: false,
    url: 'https://github.com/acme/widgets/pull/1',
    author: 'octo',
    createdAt: ago(10 * DAY),
    updatedAt: ago(DAY),
    headRefName: 'feat/x',
    additions: 1,
    deletions: 1,
    checks: null,
    reviewDecision: null,
    ...patch,
  }
}

describe('relativeAgeZh', () => {
  it.each([
    [0, '刚刚'],
    [59 * 1000, '刚刚'],
    [MIN, '1 分钟'],
    [59 * MIN, '59 分钟'],
    [HOUR, '1 小时'],
    [23 * HOUR, '23 小时'],
    [DAY, '1 天'],
    [6 * DAY, '6 天'],
    [7 * DAY, '1 周'],
    [29 * DAY, '4 周'],
    [30 * DAY, '1 个月'],
    [95 * DAY, '3 个月'],
    [364 * DAY, '11 个月'],
    [366 * DAY, '1 年'],
    [800 * DAY, '2 年'],
  ])('%i ms ago → %s', (elapsed, label) => {
    expect(relativeAgeZh(ago(elapsed), NOW)).toBe(label)
  })

  it('reads future times as just now and bad input as empty', () => {
    expect(relativeAgeZh(new Date(NOW + HOUR).toISOString(), NOW)).toBe('刚刚')
    expect(relativeAgeZh('not a date', NOW)).toBe('')
    expect(relativeAgeZh('', NOW)).toBe('')
  })

  it('has a sentence form for the detail header', () => {
    expect(relativeAgoZh(ago(3 * DAY), NOW)).toBe('3 天前')
    expect(relativeAgoZh(ago(1000), NOW)).toBe('刚刚')
    expect(relativeAgoZh('nope', NOW)).toBe('')
  })
})

describe('route params', () => {
  it('parses a valid deep link and round-trips it', () => {
    const ref = pullRefFromParams({
      owner: 'acme',
      repo: 'widgets.js',
      number: '42',
    })
    expect(ref).toEqual({ repo: 'acme/widgets.js', number: 42 })
    expect(pullRouteParams(ref!)).toEqual({
      owner: 'acme',
      repo: 'widgets.js',
      number: '42',
    })
  })

  it.each([
    [{}],
    [{ owner: 'acme', repo: 'widgets' }],
    [{ owner: '-acme', repo: 'widgets', number: '1' }],
    [{ owner: 'acme', repo: '..', number: '1' }],
    [{ owner: 'acme', repo: 'a/b', number: '1' }],
    [{ owner: 'acme', repo: 'widgets', number: '0' }],
    [{ owner: 'acme', repo: 'widgets', number: '01' }],
    [{ owner: 'acme', repo: 'widgets', number: '1.5' }],
    [{ owner: 'acme', repo: 'widgets', number: '99999999999' }],
  ])('rejects %j', (params) => {
    expect(pullRefFromParams(params)).toBeNull()
  })

  it('takes the first value of repeated params', () => {
    expect(
      pullRefFromParams({ owner: ['acme'], repo: ['widgets'], number: ['7'] }),
    ).toEqual({ repo: 'acme/widgets', number: 7 })
  })
})

describe('client filters', () => {
  const items = [
    item({ number: 1, isDraft: true }),
    item({ number: 2, checks: 'failure' }),
    item({ number: 3, reviewDecision: 'CHANGES_REQUESTED' }),
    item({ number: 4, isDraft: true, checks: 'failure' }),
  ]

  it('keeps everything without filters', () => {
    expect(applyClientFilters(items, []).map((i) => i.number)).toEqual([
      1, 2, 3, 4,
    ])
  })

  it('ANDs the selected facets', () => {
    expect(applyClientFilters(items, ['draft']).map((i) => i.number)).toEqual([
      1, 4,
    ])
    expect(
      applyClientFilters(items, ['draft', 'checksFailed']).map((i) => i.number),
    ).toEqual([4])
    expect(
      applyClientFilters(items, new Set(['changesRequested'] as const)).map(
        (i) => i.number,
      ),
    ).toEqual([3])
  })
})

describe('grouping', () => {
  const items = [
    item({ repo: 'acme/a', number: 1, updatedAt: ago(3 * DAY) }),
    item({ repo: 'acme/b', number: 2, updatedAt: ago(HOUR) }),
    item({ repo: 'acme/a', number: 3, updatedAt: ago(2 * HOUR) }),
  ]

  it('one tab-labelled group sorted by update time', () => {
    const groups = groupPullRequests(items, 'none', '由我创建')
    expect(groups).toHaveLength(1)
    expect(groups[0]!.label).toBe('由我创建')
    expect(groups[0]!.items.map((i) => i.number)).toEqual([2, 3, 1])
  })

  it('groups by repository, most recently active repo first', () => {
    const groups = groupPullRequests(items, 'repo', '全部')
    expect(groups.map((g) => g.label)).toEqual(['acme/b', 'acme/a'])
    expect(groups[1]!.items.map((i) => i.number)).toEqual([3, 1])
  })

  it('yields no groups for an empty list', () => {
    expect(groupPullRequests([], 'none', '全部')).toEqual([])
  })

  it('skips collapsed groups when walking rows', () => {
    const groups = groupPullRequests(items, 'repo', '全部')
    expect(
      visiblePulls(groups, new Set(['repo:acme/b'])).map((i) => i.number),
    ).toEqual([3, 1])
  })

  it('steps and clamps keyboard indexes', () => {
    expect(stepIndex(-1, 1, 3)).toBe(0)
    expect(stepIndex(-1, -1, 3)).toBe(2)
    expect(stepIndex(0, -1, 3)).toBe(0)
    expect(stepIndex(2, 1, 3)).toBe(2)
    expect(stepIndex(1, 1, 3)).toBe(2)
    expect(stepIndex(0, 1, 0)).toBe(-1)
  })

  it('explains an empty list per tab / search / filter', () => {
    expect(emptyListMessage('reviewing', '', false)).toBe(
      '没有等待你审查的 Pull Request',
    )
    expect(emptyListMessage('mine', '', false)).toBe(
      '你没有打开中的 Pull Request',
    )
    expect(emptyListMessage('all', ' cache ', false)).toBe(
      '没有找到与「cache」匹配的 Pull Request',
    )
    expect(emptyListMessage('all', 'x', true)).toBe(
      '没有符合筛选条件的 Pull Request',
    )
  })
})

describe('labels', () => {
  it('maps state + draft to a badge', () => {
    expect(pullStateBadge('OPEN', false)).toEqual({ label: '打开', tone: 'ok' })
    expect(pullStateBadge('OPEN', true)).toEqual({
      label: '草稿',
      tone: 'neutral',
    })
    expect(pullStateBadge('MERGED', false).label).toBe('已合并')
    expect(pullStateBadge('CLOSED', true).label).toBe('已关闭')
  })

  it('maps review decisions', () => {
    expect(reviewDecisionLabel('APPROVED')).toBe('已批准')
    expect(reviewDecisionLabel('CHANGES_REQUESTED')).toBe('需要修改')
    expect(reviewDecisionLabel('REVIEW_REQUIRED')).toBe('等待审查')
    expect(reviewDecisionLabel(null)).toBe('')
  })

  it('classifies checks and summarizes worst first', () => {
    const checks = [
      { name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' },
      { name: 'build', status: 'IN_PROGRESS', conclusion: null },
      { name: 'ci/legacy', status: 'PENDING', conclusion: null },
      { name: 'docs', status: 'COMPLETED', conclusion: 'SKIPPED' },
      { name: 'e2e', status: 'COMPLETED', conclusion: 'TIMED_OUT' },
    ]
    expect(checks.map(checkOutcome)).toEqual([
      'success',
      'failure',
      'pending',
      'pending',
      'neutral',
      'failure',
    ])
    expect(sortChecks(checks).map((c) => c.name)).toEqual([
      'e2e',
      'test',
      'build',
      'ci/legacy',
      'docs',
      'lint',
    ])
    expect(checksSummary(checks)).toBe(
      '2 项失败 · 2 项进行中 · 1 项已跳过 · 1 项通过',
    )
    expect(checksSummary([])).toBe('')
  })

  it('strips HTML comments from PR bodies', () => {
    expect(
      stripHtmlComments('<!-- template -->\n## 改动\n- a <!-- x -->\n'),
    ).toBe('## 改动\n- a')
    expect(stripHtmlComments('text <!-- unterminated')).toBe('text')
  })

  it('shows task-list markers outside code fences', () => {
    expect(
      prepareBodyMarkdown(
        [
          '<!-- hint -->',
          '- [x] done',
          '* [ ] todo',
          '1. [X] numbered',
          '- [link](https://x.test)',
          '```md',
          '- [ ] literal',
          '```',
          '  - [ ] nested',
        ].join('\n'),
      ),
    ).toBe(
      [
        '- ☑ done',
        '* ☐ todo',
        '1. ☑ numbered',
        '- [link](https://x.test)',
        '```md',
        '- [ ] literal',
        '```',
        '  - ☐ nested',
      ].join('\n'),
    )
  })
})

describe('list width persistence', () => {
  function memoryStorage(initial: Record<string, string> = {}) {
    const data = new Map(Object.entries(initial))
    return {
      data,
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => void data.set(key, value),
    }
  }

  it('clamps to the column range', () => {
    expect(clampListWidth(10)).toBe(LIST_WIDTH_MIN)
    expect(clampListWidth(9999)).toBe(LIST_WIDTH_MAX)
    expect(clampListWidth('400')).toBe(400)
    expect(clampListWidth('wide')).toBe(LIST_WIDTH_DEFAULT)
  })

  it('reads and writes through storage', () => {
    const storage = memoryStorage()
    expect(readListWidth(storage)).toBe(LIST_WIDTH_DEFAULT)
    writeListWidth(420.4, storage)
    expect(storage.data.get(LIST_WIDTH_KEY)).toBe('420')
    expect(readListWidth(storage)).toBe(420)
  })

  it('survives throwing or missing storage', () => {
    const throwing = {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      },
    }
    expect(readListWidth(throwing)).toBe(LIST_WIDTH_DEFAULT)
    expect(() => writeListWidth(400, throwing)).not.toThrow()
    expect(readListWidth(null)).toBe(LIST_WIDTH_DEFAULT)
  })
})
