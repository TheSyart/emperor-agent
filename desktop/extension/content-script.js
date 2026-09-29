// Fixed, isolated-world DOM functions. No page messages, eval, selectors from
// the native host, dynamic code, or input-value extraction are accepted here.
;(() => {
  if (globalThis.__emperorContentV1) return
  globalThis.__emperorContentV1 = true

  const documentId = crypto.randomUUID()
  let mutationVersion = 0
  let revision = 0
  let refs = new Map()
  const SENSITIVE =
    /password|one-time-code|cc-|credit|card|cvc|cvv|security|otp|token|secret/i
  const ROLES = new Set([
    'button',
    'link',
    'textbox',
    'searchbox',
    'checkbox',
    'radio',
    'combobox',
    'listbox',
    'option',
    'menu',
    'menuitem',
    'tab',
    'slider',
    'table',
    'row',
    'cell',
    'image',
    'heading',
    'dialog',
    'group',
  ])
  const INTERACTIVE =
    'a[href],button,input,textarea,select,[role],[contenteditable="true"],summary'

  new MutationObserver(() => {
    mutationVersion++
  }).observe(document, {
    subtree: true,
    childList: true,
    attributes: true,
    characterData: true,
  })
  document.addEventListener(
    'input',
    () => {
      mutationVersion++
    },
    true,
  )
  document.addEventListener(
    'change',
    () => {
      mutationVersion++
    },
    true,
  )

  function cleanText(value, max = 160) {
    return typeof value === 'string'
      ? value.replace(/\s+/g, ' ').trim().slice(0, max)
      : ''
  }

  function sensitive(node) {
    if (!(node instanceof Element)) return false
    const own = [
      node.getAttribute('type'),
      node.getAttribute('autocomplete'),
      node.getAttribute('name'),
      node.getAttribute('id'),
    ]
      .filter(Boolean)
      .join(' ')
    return (
      SENSITIVE.test(own) ||
      !!node.closest(
        '[data-private],[data-sensitive],[autocomplete="one-time-code"]',
      )
    )
  }

  function visible(node) {
    if (
      !node.isConnected ||
      node.matches('input[type="hidden"]') ||
      node.closest(
        '[hidden],[aria-hidden="true"],template,[inert],[data-private],[data-sensitive]',
      )
    )
      return false
    const style = getComputedStyle(node)
    if (style.display === 'none' || style.visibility === 'hidden') return false
    const rect = node.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0
  }

  function role(node) {
    const explicit = node.getAttribute('role')
    if (ROLES.has(explicit)) return explicit
    const tag = node.tagName.toLowerCase()
    if (tag === 'button' || tag === 'summary') return 'button'
    if (tag === 'a') return 'link'
    if (tag === 'textarea') return 'textbox'
    if (tag === 'select') return 'combobox'
    if (/^h[1-6]$/.test(tag)) return 'heading'
    if (tag === 'img') return 'image'
    if (tag === 'input') {
      const type = node.type?.toLowerCase()
      if (type === 'checkbox' || type === 'radio') return type
      if (type === 'search') return 'searchbox'
      if (type === 'range') return 'slider'
      return 'textbox'
    }
    if (node.isContentEditable) return 'textbox'
    return 'other'
  }

  function name(node) {
    const labelledBy = node.getAttribute('aria-labelledby')
    if (labelledBy) {
      const names = labelledBy
        .split(/\s+/)
        .slice(0, 4)
        .map((id) => document.getElementById(id)?.textContent || '')
      const found = cleanText(names.join(' '))
      if (found) return found
    }
    const aria = cleanText(node.getAttribute('aria-label'))
    if (aria) return aria
    if (node.labels?.length)
      return cleanText(
        [...node.labels].map((label) => label.textContent).join(' '),
      )
    if (
      node instanceof HTMLInputElement ||
      node instanceof HTMLTextAreaElement ||
      node.isContentEditable
    )
      return cleanText(node.getAttribute('placeholder'))
    if (node instanceof HTMLImageElement) return cleanText(node.alt)
    if (
      node.matches(
        'button,a,summary,[role="button"],[role="link"],[role="tab"],[role="option"],[role="menuitem"],h1,h2,h3,h4,h5,h6',
      )
    )
      return cleanText(node.innerText || node.textContent)
    return ''
  }

  function actions(node) {
    if (node.matches(':disabled,[aria-disabled="true"]') || sensitive(node))
      return []
    if (
      node.matches(
        'input:not([type="hidden"]):not([type="file"]):not([type="checkbox"]):not([type="radio"]),textarea',
      )
    )
      return ['click', 'fill']
    if (
      node.matches(
        'button,a[href],summary,[role="button"],[role="link"],input[type="checkbox"],input[type="radio"]',
      )
    )
      return ['click']
    return []
  }

  function observe(request) {
    const maxElements = Math.min(
      Math.max(Number(request.maxElements) || 200, 1),
      200,
    )
    const nextRevision = request.revision
    if (!Number.isSafeInteger(nextRevision) || nextRevision < 1)
      return { ok: false, error: 'INVALID_REQUEST' }
    revision = nextRevision
    refs = new Map()
    const elements = []
    let redactions = 0
    let total = 0
    // Fixed selector only. Traversal is bounded before serializing results.
    for (const node of document.querySelectorAll(
      INTERACTIVE + ',h1,h2,h3,h4,h5,h6,img',
    )) {
      if (!visible(node)) continue
      total++
      if (elements.length >= maxElements) break
      const ref = `r${revision}.${elements.length + 1}`
      const rect = node.getBoundingClientRect()
      const isSensitive = sensitive(node)
      if (isSensitive) redactions++
      const entry = {
        ref,
        role: role(node),
        name: name(node),
        states: [
          document.activeElement === node ? 'focused' : '',
          node.matches(':disabled,[aria-disabled="true"]') ? 'disabled' : '',
          node.matches(':checked,[aria-checked="true"]') ? 'checked' : '',
        ].filter(Boolean),
        bounds: {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
        },
        actions: actions(node),
      }
      // Deliberately no input value, textarea contents, text excerpt, page
      // storage, cookies, hidden fields, or password-derived data.
      if (isSensitive)
        entry.name =
          cleanText(node.getAttribute('aria-label')) ||
          cleanText(node.labels?.[0]?.textContent) ||
          'Sensitive field'
      elements.push(entry)
      refs.set(ref, node)
    }
    return {
      ok: true,
      documentId,
      revision,
      mutationVersion,
      viewport: {
        width: innerWidth,
        height: innerHeight,
        scale: devicePixelRatio || 1,
      },
      elements,
      truncated: total > maxElements,
      redactions,
    }
  }

  function act(request) {
    if (
      request.documentId !== documentId ||
      request.revision !== revision ||
      request.mutationVersion !== mutationVersion
    )
      return { ok: false, error: 'STALE_ELEMENT' }
    const node =
      typeof request.ref === 'string' && /^r\d+\.\d+$/.test(request.ref)
        ? refs.get(request.ref)
        : null
    if (!node || !visible(node)) return { ok: false, error: 'STALE_ELEMENT' }
    if (request.kind === 'click') {
      if (
        !actions(node).includes('click') ||
        (request.button && request.button !== 'left') ||
        (request.count && request.count !== 1)
      )
        return { ok: false, error: 'CAPABILITY_DISABLED' }
      node.click()
      refs = new Map()
      return { ok: true, dispatched: true }
    }
    if (request.kind === 'fill') {
      if (
        !actions(node).includes('fill') ||
        typeof request.text !== 'string' ||
        request.text.length > 16_384
      )
        return { ok: false, error: 'CAPABILITY_DISABLED' }
      if (!(
        node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement
      ))
        return { ok: false, error: 'CAPABILITY_DISABLED' }
      node.focus()
      const setter = Object.getOwnPropertyDescriptor(
        node instanceof HTMLInputElement
          ? HTMLInputElement.prototype
          : HTMLTextAreaElement.prototype,
        'value',
      )?.set
      if (!setter) return { ok: false, error: 'CAPABILITY_DISABLED' }
      setter.call(node, request.text)
      node.dispatchEvent(new Event('input', { bubbles: true }))
      node.dispatchEvent(new Event('change', { bubbles: true }))
      const valuePresent = node.value.length > 0
      refs = new Map()
      return { ok: true, dispatched: true, valuePresent }
    }
    return { ok: false, error: 'CAPABILITY_DISABLED' }
  }

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (
      sender.id !== chrome.runtime.id ||
      request?.channel !== 'emperor-content-v1'
    )
      return
    try {
      sendResponse(
        request.method === 'identity'
          ? { ok: true, documentId }
          : request.method === 'observe'
            ? observe(request)
            : request.method === 'act'
              ? act(request)
              : { ok: false, error: 'INVALID_REQUEST' },
      )
    } catch {
      sendResponse({ ok: false, error: 'DRIVER_UNAVAILABLE' })
    }
  })
})()
