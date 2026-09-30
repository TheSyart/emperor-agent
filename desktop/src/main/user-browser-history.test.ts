import { describe, expect, it } from 'vitest'
import { UserBrowserHistory } from './user-browser-history'

describe('UserBrowserHistory', () => {
  it('keeps committed pages newest first, one entry per consecutive page', () => {
    let now = 1_000
    const history = new UserBrowserHistory({ now: () => now })
    history.record('https://example.com/', 'Example')
    now = 2_000
    history.record('https://example.com/', '')
    now = 3_000
    history.record('https://example.com/next', 'Next')
    expect(history.list()).toEqual([
      { id: 'h2', url: 'https://example.com/next', title: 'Next', time: 3_000 },
      { id: 'h1', url: 'https://example.com/', title: 'Example', time: 2_000 },
    ])
    expect(history.find('h1')?.url).toBe('https://example.com/')
    expect(history.find('h9')).toBeUndefined()
  })

  it('takes a late title and keeps only web pages without credentials', () => {
    const history = new UserBrowserHistory()
    history.record('https://example.com/a', '')
    history.retitle('https://example.com/a', 'Loaded')
    history.retitle('https://elsewhere.test/', 'Ignored')
    for (const url of [
      'file:///etc/hosts',
      'about:blank',
      'chrome://settings',
      'https://user:secret@example.com/',
      'javascript:alert(1)',
    ])
      history.record(url, 'x')
    expect(history.list().map((entry) => [entry.url, entry.title])).toEqual([
      ['https://example.com/a', 'Loaded'],
    ])
  })

  it('drops the oldest past its limit and empties on clear', () => {
    const history = new UserBrowserHistory({ limit: 2 })
    history.record('https://a.test/', 'A')
    history.record('https://b.test/', 'B')
    history.record('https://c.test/', 'C')
    expect(history.list().map((entry) => entry.title)).toEqual(['C', 'B'])
    history.clear()
    expect(history.list()).toEqual([])
    // Ids are never reused after a clear.
    history.record('https://d.test/', 'D')
    expect(history.list()[0]?.id).toBe('h4')
  })
})
