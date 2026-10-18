import DOMPurify from 'isomorphic-dompurify'
import MarkdownIt from 'markdown-it'
import Token from 'markdown-it/lib/token.mjs'
import { computed, type Ref } from 'vue'
import { documentGlyph, pathLinkLabel } from '../documentKind'
import { documentIcon } from '../documentIcons'
import {
  displayResource,
  trimAutoUrl,
} from '../components/conversation/resources/resourceModel'

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
})

// DOMPurify 默认 URI 白名单；chip 在此基础上额外放行 file:。
const DEFAULT_URI_REGEXP =
  /^(?:(?:https?|mailto|tel|callto|sms|cid|xmpp):|[^a-z]|[a-z+.-]+(?:[^a-z+.-:]|$))/i
const CHIP_URI_REGEXP =
  /^(?:(?:https?|mailto|tel|callto|sms|cid|xmpp|file):|[^a-z]|[a-z+.-]+(?:[^a-z+.-:]|$))/i

// 命中默认白名单之外的 file: href 时保留该属性；javascript:/data:/vbscript: 等
// 危险协议不在 CHIP_URI_REGEXP 里，仍被默认剥离。模块加载时注册一次（sanitize 期间
// 配置被冻结，无法对单次调用局部加 hook，故挂在共享实例上）。
DOMPurify.addHook('uponSanitizeAttribute', (_node, data) => {
  if (
    data.attrName === 'href' &&
    CHIP_URI_REGEXP.test(data.attrValue) &&
    !DEFAULT_URI_REGEXP.test(data.attrValue)
  ) {
    data.forceKeepAttr = true
  }
})

/**
 * 防御纵深：markdown-it `html:false` 已挡住注入，这层防的是未来配置漂移。
 * 在默认 html profile 之上额外放行 `file:` href 与 `target` 属性：
 * chip 卡需要它们。安全性不受影响——`javascript:`/`data:` 在 markdown-it
 * `validateLink` 阶段就被拒成纯文本，且这里的 URI 白名单也不含它们。
 */
export function sanitizeHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    ADD_ATTR: ['target'],
  })
}

export type MdLinkKind = 'web' | 'file'

/**
 * 分类 markdown 链接：http(s) 视为网页，file:// 与绝对路径视为本地文件；
 * 相对路径带扩展名、或以 `/` 结尾（目录）时也视为本地文件；
 * 其余（mailto / #anchor / app: / 其他相对路径）返回 null，保持普通链接样式。
 */
export function classifyMdLink(href: string): MdLinkKind | null {
  if (/^https?:\/\//i.test(href)) return 'web'
  if (/^file:\/\//i.test(href)) return 'file'
  if (href.startsWith('/')) return 'file'
  if (/^[a-zA-Z]:[\\/]/.test(href)) return 'file'
  const candidate = href.replace(/(?::[1-9]\d*(?::[1-9]\d*)?|#L[1-9]\d*)$/i, '')
  if (/^[a-z][a-z0-9+.-]*:/i.test(candidate)) return null
  if (/^(?:\.\.?\/)?[^?#]+\.[a-z0-9]{1,12}$/i.test(candidate)) return 'file'
  if (/^(?:\.\.?\/)?[^?#\s]+\/$/.test(href)) return 'file'
  return null
}

/**
 * 把 chip 链接 href 还原成文件系统路径，交给 `shell.openPath`。
 * markdown-it 的 normalizeLink 会 percent-encode 空格/反斜杠等，这里解码回来；
 * `file://` 形式则取 URL 的 pathname，并去掉 Windows 盘符前的斜杠（/C:/x → C:/x）。
 */
export function hrefToFilePath(href: string): string {
  let raw = href
  if (/^file:\/\//i.test(raw)) {
    try {
      const url = new URL(raw)
      // Windows 上 file:///C:/x 的 host 可能是盘符；若有 host 需拼回。
      const host = url.host && url.host !== 'localhost' ? `${url.host}:` : ''
      raw = decodeURIComponent(host + url.pathname)
      if (/^\/[a-zA-Z]:[\\/]/.test(raw)) raw = raw.slice(1)
      return raw
    } catch {
      raw = raw.replace(/^file:\/\//i, '')
    }
  }
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

// 默认 validateLink 拒绝 file:（连同 javascript:/data:），导致 file:// 链接
// 退化成纯文本。这里额外放行 file://，危险协议仍由默认校验 + DOMPurify 拦截。
const defaultValidateLink = md.validateLink.bind(md)
md.validateLink = (url: string) =>
  defaultValidateLink(url) || url.startsWith('file://')

/**
 * 把内联链接升级成 chip 卡：附加 class / data-md-link / data-md-ext / target / rel，
 * 以及类型图标 data-md-icon（语言另有 data-md-badge 徽标文字与 data-md-tone 色调）。
 * 纯 HTML 属性，全部在 sanitize 白名单内；图标交给外部 CSS。
 * 本地文件链接的文字本身就是路径时，只显示文件名（完整路径留在 title）。
 * 裸 URL（linkify 自动链）完整显示域名、路径、参数与锚点，不截断长名称。
 * 注意：markdown-it 会把 Windows 反斜杠 percent-encode 成 %5C，所以分类前先解码，
 * 才能识别出 `C:\…` 这种盘符形式。
 */
md.core.ruler.push('md_link_chips', (state) => {
  for (const token of state.tokens) {
    if (token.type !== 'inline' || !token.children) continue
    const children = token.children
    for (let index = 0; index < children.length; index += 1) {
      const child = children[index]
      if (!child || child.type !== 'link_open') continue
      let href = child.attrGet('href') ?? ''
      const labelToken = children[index + 1]
      if (
        child.markup === 'linkify' &&
        labelToken?.type === 'text' &&
        children[index + 2]?.type === 'link_close'
      ) {
        const trimmed = trimAutoUrl(labelToken.content)
        if (trimmed.length < labelToken.content.length) {
          const trailing = new Token('text', '', 0)
          trailing.content = labelToken.content.slice(trimmed.length)
          labelToken.content = trimmed
          children.splice(index + 3, 0, trailing)
          href = md.normalizeLink(trimmed)
          child.attrSet('href', href)
        }
      }
      let decoded = href
      try {
        decoded = decodeURIComponent(href)
      } catch {
        decoded = href
      }
      const kind = classifyMdLink(decoded)
      if (!kind) continue
      child.attrSet('class', 'md-link-chip')
      child.attrSet('data-md-link', kind)
      child.attrSet('title', decoded)
      child.attrSet('target', '_blank')
      child.attrSet('rel', 'noopener noreferrer')
      const ext = /\.([a-z0-9]{1,8})(?:[?#].*)?$/i
        .exec(decoded)?.[1]
        ?.toLowerCase()
      if (kind === 'file' && ext) child.attrSet('data-md-ext', ext)
      const glyph = documentGlyph(decoded)
      child.attrSet('data-md-icon', glyph.kind)
      if (glyph.badge) child.attrSet('data-md-badge', glyph.badge)
      if (glyph.tone) child.attrSet('data-md-tone', glyph.tone)
      const asset = documentIcon(decoded)
      if (kind === 'file') {
        child.attrSet('data-md-custom-icon', asset.id)
        child.attrSet('style', `--md-link-ico: url("${asset.mask}")`)
        if (asset.image) {
          child.attrSet('data-md-color', 'true')
          child.attrSet('style', `--md-link-image: url("${asset.image}")`)
        }
        if (asset.tone) child.attrSet('data-md-tone', asset.tone)
      }
      const resource = displayResource(href, '', 'markdown')
      if (resource) child.attrSet('data-resource-kind', resource.kind)
      if (resource?.kind === 'web')
        child.attrSet(
          'data-site-letter',
          new URL(href).hostname
            .replace(/^www\./, '')
            .slice(0, 1)
            .toUpperCase(),
        )
      if (resource?.github)
        child.attrSet('data-resource-type', resource.github.type)
      if (kind === 'file') showFileName(children, index, decoded)
      if (child.markup === 'linkify') {
        const textToken = children[index + 1]
        if (textToken?.type === 'text') {
          try {
            const url = new URL(href)
            textToken.content =
              url.host +
              (url.pathname === '/' ? '' : url.pathname) +
              url.search +
              url.hash
          } catch {
            /* 保留原文本 */
          }
        }
      }
    }
  }
  return false
})

/** A lone label (text or code) that is the link's path → the file name. */
function showFileName(
  children: NonNullable<Token['children']>,
  open: number,
  target: string,
): void {
  const label = children[open + 1]
  if (children[open + 2]?.type !== 'link_close') return
  if (label?.type !== 'text' && label?.type !== 'code_inline') return
  const name = pathLinkLabel(label.content, target)
  if (name === null) return
  label.type = 'text'
  label.tag = ''
  label.markup = ''
  label.content = name
}

export function useMarkdown(content: Ref<string>) {
  const rendered = computed(() => sanitizeHtml(md.render(content.value || '')))
  return { rendered }
}
