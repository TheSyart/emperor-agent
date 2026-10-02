import { describe, expect, it } from 'vitest'
import { AGENT_REQUEST_METHODS, parseAgentEvent } from './nm-bridge-agent'

describe('the extension’s Agent messages (RV-09)', () => {
  it('lets main ask for a tab, a navigation, a follow and a download verdict', () => {
    expect(AGENT_REQUEST_METHODS).toEqual([
      'tab.open',
      'target.navigate',
      'target.follow',
      'download.resolve',
    ])
  })

  it('reads a page that moved: origin only', () => {
    expect(
      parseAgentEvent(
        'target.navigated',
        { targetId: 'abc', generation: 4, origin: 'https://news.example' },
        'pair-1',
      ),
    ).toEqual({
      type: 'target-navigated',
      pairingId: 'pair-1',
      targetId: 'abc',
      generation: 4,
      origin: 'https://news.example',
    })
    for (const origin of [
      'https://news.example/path',
      'chrome://settings',
      'https://news.example:443',
    ])
      expect(() =>
        parseAgentEvent(
          'target.navigated',
          { targetId: 'abc', generation: 4, origin },
          'pair-1',
        ),
      ).toThrow(/PROTOCOL_MISMATCH/)
  })

  it('reads a held download, bounding what the page controls', () => {
    expect(
      parseAgentEvent(
        'download.pending',
        {
          downloadId: 31,
          targetId: 'abc',
          generation: 4,
          origin: '',
          filename: 'x'.repeat(500),
          mimeType: 'application/pdf',
          bytes: -1,
          browser: 'edge',
        },
        'pair-1',
      ),
    ).toEqual({
      type: 'download-pending',
      pairingId: 'pair-1',
      downloadId: 31,
      targetId: 'abc',
      generation: 4,
      origin: '',
      filename: 'x'.repeat(200),
      mimeType: 'application/pdf',
      bytes: -1,
      browser: 'edge',
    })
    expect(
      parseAgentEvent(
        'download.pending',
        {
          downloadId: 31,
          targetId: 'abc',
          generation: 4,
          origin: 'https://files.example',
          filename: 'r.pdf',
          mimeType: '',
          bytes: 10,
          browser: 'netscape',
        },
        'pair-1',
      ),
    ).toMatchObject({ browser: 'chrome' })
    for (const broken of [
      { downloadId: -1 },
      { downloadId: 1.5 },
      { origin: 'https://files.example/r.pdf' },
      { filename: 7 },
      { bytes: -2 },
    ])
      expect(() =>
        parseAgentEvent(
          'download.pending',
          {
            downloadId: 31,
            targetId: 'abc',
            generation: 4,
            origin: '',
            filename: 'r.pdf',
            mimeType: '',
            bytes: 1,
            browser: 'chrome',
            ...broken,
          },
          'pair-1',
        ),
      ).toThrow(/PROTOCOL_MISMATCH/)
  })

  it('reads how an allowed download ended', () => {
    expect(
      parseAgentEvent(
        'download.done',
        { downloadId: 31, state: 'interrupted', filename: 'r.pdf', bytes: 3 },
        'pair-1',
      ),
    ).toEqual({
      type: 'download-done',
      pairingId: 'pair-1',
      downloadId: 31,
      state: 'interrupted',
      filename: 'r.pdf',
      bytes: 3,
    })
    expect(() =>
      parseAgentEvent(
        'download.done',
        { downloadId: 31, state: 'paused', filename: 'r.pdf', bytes: 3 },
        'pair-1',
      ),
    ).toThrow(/PROTOCOL_MISMATCH/)
  })

  it('leaves other events to the bridge', () => {
    expect(parseAgentEvent('target.attached', {}, 'pair-1')).toBeNull()
  })
})
