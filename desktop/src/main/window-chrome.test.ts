import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  mainWindowChrome,
  TRAFFIC_LIGHTS,
  TRAFFIC_LIGHTS_SIZE,
} from './window-chrome'

const theme = join(__dirname, '..', 'renderer', 'src', 'theme')
const renderer = join(__dirname, '..', 'renderer', 'src')

/** A px length token of components.css (`--name: 46px;`). */
function px(name: string): number {
  const css = readFileSync(join(theme, 'components.css'), 'utf8')
  const match = css.match(new RegExp(`${name}:\\s*(\\d+)px;`))
  if (!match) throw new Error(`no px token ${name}`)
  return Number(match[1])
}

describe('main window chrome (UI-S01)', () => {
  it('hides the native title bar and places the traffic lights on macOS', () => {
    expect(mainWindowChrome('darwin')).toEqual({
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: TRAFFIC_LIGHTS,
    })
    expect(TRAFFIC_LIGHTS.x).toBe(16)
  })

  it('keeps the standard frame elsewhere', () => {
    expect(mainWindowChrome('linux')).toEqual({})
    expect(mainWindowChrome('win32')).toEqual({})
  })

  it('centres the lights on the 46px top bars below the 8px gutter', () => {
    const gutter = px('--shell-gutter')
    const bar = px('--shell-bar-h')
    expect(gutter).toBe(8)
    expect(bar).toBe(46)
    expect(TRAFFIC_LIGHTS.y + TRAFFIC_LIGHTS_SIZE.height / 2).toBe(
      gutter + bar / 2,
    )
    // The lights sit inside the rail's top area (gutter + bar).
    expect(TRAFFIC_LIGHTS.y + TRAFFIC_LIGHTS_SIZE.height).toBeLessThan(
      gutter + bar,
    )
    expect(TRAFFIC_LIGHTS.x).toBeLessThan(px('--rail-w'))
  })

  it('keeps content beside the lights clear of them', () => {
    // Content next to the lights (the sidebar's top bar, or the panel when
    // the sidebar is folded) starts 8px after their right end.
    expect(px('--shell-lights-clear')).toBe(
      TRAFFIC_LIGHTS.x + TRAFFIC_LIGHTS_SIZE.width + px('--shell-gutter'),
    )
  })

  it('marks drag regions in CSS and keeps controls and overlays clickable', () => {
    const base = readFileSync(join(theme, 'base.css'), 'utf8')
    expect(base).toMatch(/\[data-app-drag\]\s*\{\s*-webkit-app-region:\s*drag;/)
    expect(base).toMatch(
      /\[data-app-drag\][^{]*:is\([^)]*button[^)]*\)[^{]*\{\s*-webkit-app-region:\s*no-drag;/,
    )
    // Everything teleported out of #app (menus, dialogs, lightboxes) is
    // never a drag region, even above a top bar.
    expect(base).toMatch(
      /body\s*>\s*:not\(#app\)[^{]*\{\s*-webkit-app-region:\s*no-drag;/,
    )
    const frame = readFileSync(
      join(renderer, 'components', 'shell', 'AppFrame.vue'),
      'utf8',
    )
    expect(frame).toMatch(/\.handle\s*\{[^}]*-webkit-app-region:\s*no-drag;/)
  })
})
