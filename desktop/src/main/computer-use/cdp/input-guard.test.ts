// @vitest-environment jsdom
/**
 * The input guard's page functions (SEC-10, MAIN-8), run for real against a
 * DOM. Cross-origin frames are frames whose document the page cannot reach:
 * jsdom never loads one, so their `contentDocument` is made null here.
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  INPUT_FENCE,
  ISOLATED_FUNCTIONS,
  type IsolatedFunctionName,
} from './isolated-functions'

function run<T>(
  name: IsolatedFunctionName,
  self: unknown,
  ...args: unknown[]
): T {
  // Test only: the registry sources are what the driver sends to the page.
  const fn = new Function(`return (${ISOLATED_FUNCTIONS[name].source})`)() as (
    ...values: unknown[]
  ) => T
  return fn.apply(self, args)
}

/** An iframe whose document this page cannot reach (another origin). */
function crossOriginFrame(parent: ParentNode = document.body) {
  const frame = document.createElement('iframe')
  frame.title = 'other'
  parent.append(frame)
  Object.defineProperty(frame, 'contentDocument', { get: () => null })
  return frame
}

function input(parent: ParentNode = document.body) {
  const element = document.createElement('input')
  element.value = 'old'
  parent.append(element)
  return element
}

afterEach(() => {
  document.body.innerHTML = ''
  ;(document.activeElement as HTMLElement | null)?.blur?.()
})

describe('input guard page functions', () => {
  it('focuses and selects the field, and fences cross-origin frames while it types', () => {
    const field = input()
    const other = crossOriginFrame()
    const same = document.createElement('iframe')
    document.body.append(same)
    expect(run('focusForInput', field, true)).toEqual({
      focused: true,
      frame: false,
    })
    expect(document.activeElement).toBe(field)
    expect(field.selectionStart).toBe(0)
    expect(field.selectionEnd).toBe(3)
    // Only frames the page cannot reach are made inert (unfocusable).
    expect(other.getAttribute('inert')).toBe(INPUT_FENCE)
    expect(same.hasAttribute('inert')).toBe(false)
    expect(run('releaseInputFence', window)).toBe(1)
    expect(other.hasAttribute('inert')).toBe(false)
  })

  it('finds the focus moved into a cross-origin frame by the page’s own focus handler', () => {
    const field = input()
    const other = crossOriginFrame()
    field.addEventListener('focus', () => other.focus())
    expect(run('focusForInput', field, false)).toEqual({
      focused: false,
      frame: true,
    })
    // Nothing is fenced when the input is refused.
    expect(other.hasAttribute('inert')).toBe(false)
    expect(run('inputFocus', window)).toEqual({ frame: true })
  })

  it('looks inside open shadow roots and same-origin frames', () => {
    const host = document.createElement('div')
    document.body.append(host)
    const root = host.attachShadow({ mode: 'open' })
    const hidden = crossOriginFrame(root)
    hidden.focus()
    expect(run('inputFocus', window)).toEqual({ frame: true })
    // A frame the page can read is followed to its own focused element.
    const same = document.createElement('iframe')
    document.body.append(same)
    const inner = same.contentDocument!
    const field = inner.createElement('input')
    inner.body.append(field)
    same.focus()
    field.focus()
    expect(run('inputFocus', window)).toEqual({ frame: false })
    // ... and the fence reaches into shadow roots too.
    expect(hidden.getAttribute('inert')).toBe(INPUT_FENCE)
    expect(run('releaseInputFence', window)).toBe(1)
  })

  it('treats object and embed elements without a reachable document as frames', () => {
    const object = document.createElement('object')
    object.tabIndex = 0
    document.body.append(object)
    Object.defineProperty(object, 'contentDocument', { get: () => null })
    object.focus()
    expect(run('inputFocus', window)).toEqual({ frame: true })
  })

  it('follows the field’s own closed shadow roots', () => {
    const host = document.createElement('div')
    document.body.append(host)
    const root = host.attachShadow({ mode: 'closed' })
    const field = input(root)
    const other = crossOriginFrame(root)
    field.addEventListener('focus', () => other.focus())
    expect(run('focusForInput', field, false)).toEqual({
      focused: false,
      frame: true,
    })
  })

  it('leaves frames the page made inert itself alone', () => {
    const field = input()
    const own = crossOriginFrame()
    own.setAttribute('inert', '')
    const other = crossOriginFrame()
    run('focusForInput', field, false)
    expect(other.getAttribute('inert')).toBe(INPUT_FENCE)
    run('releaseInputFence', window)
    expect(own.getAttribute('inert')).toBe('')
    expect(other.hasAttribute('inert')).toBe(false)
  })
})
