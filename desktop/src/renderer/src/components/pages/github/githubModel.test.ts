import { describe, expect, it } from 'vitest'
import {
  durationZh,
  githubPluginOn,
  issueRefFromParams,
  issueStateBadge,
  labelColor,
  readIssueFilter,
  repoFromRemote,
  repoFromText,
  runEventLabel,
  runOutcome,
  runRefFromParams,
  writeIssueFilter,
} from './githubModel'

describe('GitHub pages model', () => {
  it('shows the pages only while the GitHub plugin is on', () => {
    const plugin = { pluginId: 'github', effective: true, activation: 'active' }
    expect(githubPluginOn([plugin])).toBe(true)
    expect(githubPluginOn([{ ...plugin, activation: 'disabled' }])).toBe(false)
    expect(githubPluginOn([{ ...plugin, effective: false }])).toBe(false)
    expect(githubPluginOn([])).toBe(false)
  })

  it('reads references from route params and rejects the rest', () => {
    expect(
      issueRefFromParams({ owner: 'acme', repo: 'widgets', number: '12' }),
    ).toEqual({
      repo: 'acme/widgets',
      number: 12,
    })
    expect(
      runRefFromParams({
        owner: 'acme',
        repo: 'widgets',
        runId: '36566264518',
      }),
    ).toEqual({
      repo: 'acme/widgets',
      runId: 36566264518,
    })
    expect(
      issueRefFromParams({ owner: '-x', repo: 'y', number: '1' }),
    ).toBeNull()
    expect(
      issueRefFromParams({ owner: 'acme', repo: '..', number: '1' }),
    ).toBeNull()
    expect(
      issueRefFromParams({ owner: 'acme', repo: 'widgets', number: '0' }),
    ).toBeNull()
    expect(repoFromText(' acme/widgets ')).toBe('acme/widgets')
    expect(repoFromText('acme/widgets/extra')).toBeNull()
    expect(repoFromText('https://github.com/acme/widgets')).toBeNull()
  })

  it('takes the default CI repository only from a github.com origin', () => {
    expect(
      repoFromRemote({
        webUrl: 'https://github.com/acme/widgets',
        provider: 'github',
      }),
    ).toBe('acme/widgets')
    expect(
      repoFromRemote({
        webUrl: 'https://github.com/acme/widgets.git/',
        provider: 'github',
      }),
    ).toBe('acme/widgets')
    expect(
      repoFromRemote({
        webUrl: 'https://acme.ghe.com/acme/widgets',
        provider: 'github',
      }),
    ).toBeNull()
    expect(
      repoFromRemote({
        webUrl: 'https://gitlab.com/acme/widgets',
        provider: 'gitlab',
      }),
    ).toBeNull()
    expect(
      repoFromRemote({ webUrl: 'https://github.com/acme', provider: 'github' }),
    ).toBeNull()
    expect(repoFromRemote({ webUrl: null, provider: null })).toBeNull()
    expect(repoFromRemote(null)).toBeNull()
  })

  it('describes run events and job durations', () => {
    expect(runEventLabel('push')).toBe('推送')
    expect(runEventLabel('workflow_run')).toBe('workflow_run')
    expect(durationZh('2026-09-29T12:10:00Z', '2026-09-29T12:10:42Z')).toBe(
      '42 秒',
    )
    expect(durationZh('2026-09-29T12:10:00Z', '2026-09-29T12:19:00Z')).toBe(
      '9 分钟',
    )
    expect(durationZh('2026-09-29T12:00:00Z', '2026-09-29T13:05:00Z')).toBe(
      '1 小时 5 分钟',
    )
    expect(durationZh('2026-09-29T12:00:00Z', '2026-09-29T14:00:00Z')).toBe(
      '2 小时',
    )
    expect(durationZh('2026-09-29T12:10:00Z', null)).toBe('')
    expect(durationZh('2026-09-29T12:10:00Z', '2026-09-29T12:00:00Z')).toBe('')
  })

  it('labels issue states and run outcomes', () => {
    expect(issueStateBadge({ state: 'OPEN' })).toEqual({
      label: '开放',
      tone: 'ok',
    })
    expect(
      issueStateBadge({ state: 'CLOSED', stateReason: 'COMPLETED' }),
    ).toEqual({ label: '已完成', tone: 'accent' })
    expect(
      issueStateBadge({ state: 'CLOSED', stateReason: 'NOT_PLANNED' }),
    ).toEqual({ label: '不处理', tone: 'neutral' })
    expect(runOutcome({ status: 'in_progress', conclusion: null })).toEqual({
      label: '进行中',
      tone: 'neutral',
    })
    expect(runOutcome({ status: 'queued', conclusion: null })).toEqual({
      label: '排队中',
      tone: 'neutral',
    })
    expect(runOutcome({ status: 'completed', conclusion: 'success' })).toEqual({
      label: '成功',
      tone: 'ok',
    })
    expect(runOutcome({ status: 'completed', conclusion: 'failure' })).toEqual({
      label: '失败',
      tone: 'error',
    })
    expect(
      runOutcome({ status: 'completed', conclusion: 'cancelled' }),
    ).toEqual({ label: '已取消', tone: 'neutral' })
  })

  it('remembers the Issue filter and ignores anything unknown', () => {
    const store = new Map<string, string>()
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    }
    expect(readIssueFilter(storage)).toBe('involved')
    writeIssueFilter('owned', storage)
    expect(readIssueFilter(storage)).toBe('owned')
    store.set('emperor.github.issueFilter', 'everything')
    expect(readIssueFilter(storage)).toBe('involved')
    const broken = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    }
    expect(readIssueFilter(broken)).toBe('involved')
    expect(() => writeIssueFilter('owned', broken)).not.toThrow()
    expect(readIssueFilter(null)).toBe('involved')
  })

  it('draws a label color only from a plain hex value', () => {
    expect(labelColor('d73a4a')).toBe('#d73a4a')
    expect(labelColor('red;background:url(x)')).toBeNull()
    expect(labelColor('')).toBeNull()
  })
})
