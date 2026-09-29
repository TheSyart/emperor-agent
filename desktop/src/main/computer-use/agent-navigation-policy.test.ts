import { describe, expect, it, vi } from 'vitest'
import {
  decideAgentNavigation,
  subframeNavigationAllowed,
} from './agent-navigation-policy'

describe('agent navigation policy', () => {
  it.each([
    ['https://example.com/', true],
    ['http://192.168.1.20:8080/', true],
    ['http://localhost:5173/', true],
    ['about:blank', true],
    ['about:srcdoc', true],
    ['data:text/html,<p>x</p>', true],
    ['blob:https://example.com/uuid', true],
    ['file:///Users/me/.ssh/id_rsa', false],
    ['chrome://settings', false],
    ['devtools://devtools/bundled/inspector.html', false],
    ['app://bundle/index.html', false],
    ['javascript:alert(1)', false],
    ['https://user:pass@example.com/', false],
    ['not a url', false],
  ])('sub-frame %s → %s', (url, allowed) => {
    expect(subframeNavigationAllowed(url)).toBe(allowed)
  })

  it('refuses non-web main frames before asking the kernel', () => {
    const kernel = vi.fn(() => 'allow' as const)
    for (const url of ['file:///etc/hosts', 'data:text/html,x', 'about:blank'])
      expect(
        decideAgentNavigation(
          { targetId: 't', url, frame: 'main', initiator: 'page' },
          kernel,
        ),
      ).toBe('block')
    expect(kernel).not.toHaveBeenCalled()
  })

  it('lets the kernel decide web main frames, including LAN (D3)', () => {
    const kernel = vi.fn((navigation: { url: string }) =>
      navigation.url.includes('evil') ? ('block' as const) : ('allow' as const),
    )
    const main = (url: string) =>
      decideAgentNavigation(
        { targetId: 't', url, frame: 'main', initiator: 'agent' },
        kernel,
      )
    expect(main('http://10.0.0.5/admin')).toBe('allow')
    expect(main('https://evil.test/')).toBe('block')
    expect(main('https://example.com/')).toBe('allow')
  })

  it('fails closed without a kernel or when it throws', () => {
    const navigation = {
      targetId: 't',
      url: 'https://example.com/',
      frame: 'main' as const,
      initiator: 'page' as const,
    }
    expect(decideAgentNavigation(navigation, null)).toBe('block')
    expect(
      decideAgentNavigation(navigation, () => {
        throw new Error('boom')
      }),
    ).toBe('block')
  })

  it('checks sub-frames by URL only', () => {
    const kernel = vi.fn(() => 'block' as const)
    expect(
      decideAgentNavigation(
        {
          targetId: 't',
          url: 'https://other.test/embed',
          frame: 'sub',
          initiator: 'page',
        },
        kernel,
      ),
    ).toBe('allow')
    expect(kernel).not.toHaveBeenCalled()
  })
})
