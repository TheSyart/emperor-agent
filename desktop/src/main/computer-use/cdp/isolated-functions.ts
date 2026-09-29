/**
 * The only JavaScript the driver ever runs in a page (spec 00 §7.3): a
 * fixed, audited registry of small functions, executed in an isolated world
 * through `Runtime.callFunctionOn`. Callers pick a function by name and pass
 * JSON primitives; model- or page-supplied code is never evaluated.
 *
 * `isolated-functions.test.ts` audits every source: no eval, no network, no
 * storage, no messaging, no dynamic import.
 */

export type IsolatedArg = string | number | boolean | null

interface IsolatedFunction {
  /** Runs with `this` bound to an element (else to the global object). */
  readonly onElement: boolean
  readonly source: string
}

export const ISOLATED_FUNCTIONS = Object.freeze({
  /** Visible page text, bounded. Input values are not part of innerText. */
  textExcerpt: {
    onElement: false,
    source: `function (maxChars) {
      const body = document.body
      if (!body) return ''
      const text = body.innerText || ''
      return text.length > maxChars ? text.slice(0, maxChars) : text
    }`,
  },
  /** Whether the page text contains a needle (waits). */
  hasText: {
    onElement: false,
    source: `function (needle) {
      const body = document.body
      return !!body && (body.innerText || '').includes(needle)
    }`,
  },
  documentState: {
    onElement: false,
    source: `function () {
      return { readyState: document.readyState, title: document.title, url: location.href }
    }`,
  },
  /** Field facts for masking and fill checks; never returns a secret value. */
  fieldState: {
    onElement: true,
    source: `function () {
      const el = this
      const tag = (el.tagName || '').toLowerCase()
      const type = (el.getAttribute && (el.getAttribute('type') || '') || '').toLowerCase()
      const autocomplete = (el.getAttribute && (el.getAttribute('autocomplete') || '') || '').toLowerCase()
      const secret = type === 'password' || type === 'hidden' ||
        autocomplete === 'one-time-code' || autocomplete.startsWith('cc-') ||
        autocomplete === 'current-password' || autocomplete === 'new-password'
      const editable = el.isContentEditable === true ||
        tag === 'textarea' || (tag === 'input' && !['checkbox','radio','button','submit','reset','file','image','range','color','hidden'].includes(type || 'text'))
      const value = typeof el.value === 'string' ? el.value : (el.isContentEditable ? el.innerText : '')
      return {
        tag, type, autocomplete, secret, editable,
        disabled: el.disabled === true, readOnly: el.readOnly === true,
        hasValue: value.length > 0,
        value: secret ? null : value.slice(0, 4096),
        checked: typeof el.checked === 'boolean' ? el.checked : null,
      }
    }`,
  },
  /** Focus and select all text so an insert replaces the old value. */
  fileInputState: {
    onElement: true,
    source: `function () {
      const el = this
      const tag = (el.tagName || '').toLowerCase()
      const type = (el.getAttribute && (el.getAttribute('type') || '') || '').toLowerCase()
      const isFile = tag === 'input' && type === 'file'
      return {
        isFile,
        multiple: isFile && el.multiple === true,
        accept: isFile ? String(el.accept || '').slice(0, 200) : '',
        disabled: el.disabled === true,
        count: isFile && el.files ? el.files.length : 0,
      }
    }`,
  },
  activeIsFrame: {
    onElement: false,
    source: `function () {
      const active = document.activeElement
      const tag = active && active.tagName ? active.tagName.toLowerCase() : ''
      return tag === 'iframe' || tag === 'frame'
    }`,
  },
  focusAndSelectAll: {
    onElement: true,
    source: `function () {
      const el = this
      el.focus({ preventScroll: false })
      if (typeof el.select === 'function') el.select()
      else if (el.isContentEditable) {
        const range = document.createRange()
        range.selectNodeContents(el)
        const selection = window.getSelection()
        selection.removeAllRanges()
        selection.addRange(range)
      }
      return document.activeElement === el
    }`,
  },
  focus: {
    onElement: true,
    source: `function () { this.focus({ preventScroll: false }); return document.activeElement === this }`,
  },
  /** Pick a <select> option by label or value and fire input + change. */
  selectOption: {
    onElement: true,
    source: `function (wanted) {
      const el = this
      if ((el.tagName || '').toLowerCase() !== 'select') return { ok: false, reason: 'not-a-select' }
      const options = Array.from(el.options)
      const match = options.find((o) => o.label === wanted || o.text === wanted) ||
        options.find((o) => o.value === wanted) ||
        options.find((o) => (o.text || '').trim().toLowerCase() === String(wanted).trim().toLowerCase())
      if (!match) return { ok: false, reason: 'no-such-option', options: options.slice(0, 50).map((o) => o.text) }
      if (match.disabled) return { ok: false, reason: 'option-disabled' }
      el.value = match.value
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
      return { ok: true, value: match.text }
    }`,
  },
  scrollIntoView: {
    onElement: true,
    source: `function () { this.scrollIntoView({ block: 'center', inline: 'center' }); return true }`,
  },
  /** Scroll the whole document of the frame. */
  scrollPage: {
    onElement: false,
    source: `function (dx, dy, unit) {
      const target = document.scrollingElement || document.documentElement
      const stepY = unit === 'page' ? innerHeight * 0.9 : 40
      const stepX = unit === 'page' ? innerWidth * 0.9 : 40
      const beforeX = target.scrollLeft, beforeY = target.scrollTop
      target.scrollBy({ left: dx * stepX, top: dy * stepY, behavior: 'instant' })
      return { moved: target.scrollLeft !== beforeX || target.scrollTop !== beforeY, x: target.scrollLeft, y: target.scrollTop }
    }`,
  },
  /** Scroll the element (or the page) by a number of pages or lines. */
  scrollBy: {
    onElement: true,
    source: `function (dx, dy, unit) {
      const el = this
      const target = el === document.documentElement || el === document.body ? document.scrollingElement || el : el
      const stepY = unit === 'page' ? (target.clientHeight || innerHeight) * 0.9 : 40
      const stepX = unit === 'page' ? (target.clientWidth || innerWidth) * 0.9 : 40
      const beforeX = target.scrollLeft, beforeY = target.scrollTop
      target.scrollBy({ left: dx * stepX, top: dy * stepY, behavior: 'instant' })
      return { moved: target.scrollLeft !== beforeX || target.scrollTop !== beforeY, x: target.scrollLeft, y: target.scrollTop }
    }`,
  },
} satisfies Record<string, IsolatedFunction>)

/**
 * Hit-test check: is `other` (the node at the click point) this element or
 * inside it, walking across shadow roots? Called with an element argument,
 * so it lives outside the primitive-only registry but under the same audit.
 */
export const CONTAINS_NODE_SOURCE = `function (other) {
  let node = other
  while (node) {
    if (node === this) return true
    node = node.parentNode || node.host || null
  }
  return false
}`

export type IsolatedFunctionName = keyof typeof ISOLATED_FUNCTIONS

export function isIsolatedFunctionName(
  name: string,
): name is IsolatedFunctionName {
  return Object.hasOwn(ISOLATED_FUNCTIONS, name)
}

/** Validate a call; throws on unknown names or non-primitive arguments. */
export function isolatedCall(
  name: string,
  args: readonly unknown[],
): { source: string; onElement: boolean; args: IsolatedArg[] } {
  if (!isIsolatedFunctionName(name))
    throw new Error(`unknown isolated function ${name}`)
  const checked = args.map((arg) => {
    if (arg === null || ['string', 'number', 'boolean'].includes(typeof arg)) {
      if (typeof arg === 'string' && arg.length > 10_000)
        throw new Error('argument too long')
      if (typeof arg === 'number' && !Number.isFinite(arg))
        throw new Error('non-finite argument')
      return arg as IsolatedArg
    }
    throw new Error('isolated functions only take JSON primitives')
  })
  const fn = ISOLATED_FUNCTIONS[name]
  return { source: fn.source, onElement: fn.onElement, args: checked }
}
