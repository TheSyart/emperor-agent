/**
 * Post-processing of a rendered (already sanitized) Pull Request body.
 *
 * PR bodies are untrusted third-party content. The markdown renderer drops
 * raw HTML and DOMPurify strips scripts, but `![](https://…)` still becomes
 * an <img> the renderer would fetch on sight — a tracking pixel that leaks
 * the viewer's IP and the moment they opened the PR. Images are therefore
 * turned into plain links (「图片：alt」) the user can choose to open in the
 * browser. Parsing happens in an inert <template>, so nothing loads here.
 */

const HTTPS = /^https:\/\//i

export function neutralizeRemoteImages(
  html: string,
  doc: Document | null = typeof document === 'undefined' ? null : document,
): string {
  if (!doc || !/<img\b/i.test(html)) return html
  const template = doc.createElement('template')
  template.innerHTML = html
  for (const image of [...template.content.querySelectorAll('img')]) {
    const src = image.getAttribute('src') ?? ''
    const alt = (image.getAttribute('alt') ?? '').trim()
    const label = `图片：${alt || '未命名'}`
    let replacement: HTMLElement
    if (HTTPS.test(src)) {
      replacement = doc.createElement('a')
      replacement.setAttribute('href', src)
      replacement.setAttribute('data-pr-image', '')
    } else {
      replacement = doc.createElement('span')
    }
    replacement.className = 'pr-md-image'
    replacement.textContent = label
    image.replaceWith(replacement)
  }
  return template.innerHTML
}

/** The http(s) target of a clicked body link, else null (anchors, files…). */
export function externalHref(anchor: Element | null): string | null {
  const href = anchor?.getAttribute('href') ?? ''
  if (!/^https?:\/\//i.test(href)) return null
  try {
    const url = new URL(href)
    if (url.username || url.password) return null
    return url.toString()
  } catch {
    return null
  }
}
