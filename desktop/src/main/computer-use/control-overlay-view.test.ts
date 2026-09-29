import { describe, expect, it } from 'vitest'
import {
  controlOverlayHtml,
  selectControlOverlayTarget,
} from './control-overlay-view'

const active = {
  targetId: 'target-1',
  title: 'Safari',
  state: 'attached',
  control: 'agent',
}

describe('control overlay view', () => {
  it('shows the most recently controlled live target only while enabled', () => {
    const status = {
      enabled: true,
      stopped: false,
      targets: [active, { ...active, targetId: 'target-2', title: 'Chrome' }],
    }
    expect(selectControlOverlayTarget(status)).toEqual({
      title: 'Chrome',
      count: 2,
    })
    expect(selectControlOverlayTarget({ ...status, stopped: true })).toBeNull()
    expect(selectControlOverlayTarget({ ...status, enabled: false })).toBeNull()
    expect(
      selectControlOverlayTarget({
        ...status,
        targets: [{ ...active, state: 'lost' }],
      }),
    ).toBeNull()
    expect(
      selectControlOverlayTarget({
        ...status,
        targets: [{ ...active, control: 'user-takeover' }],
      }),
    ).toBeNull()
  })

  it('escapes untrusted target names and exposes only the stop navigation', () => {
    const html = controlOverlayHtml({
      title: '<img src=x onerror=alert(1)>',
      count: 1,
    })
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img')
    expect(html).toContain('emperor-overlay://stop')
    expect(html).toContain("default-src 'none'")
    expect(html).not.toContain('<script')
  })
})
