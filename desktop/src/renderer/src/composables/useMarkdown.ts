import DOMPurify from 'isomorphic-dompurify'
import MarkdownIt from 'markdown-it'
import { computed, type Ref } from 'vue'

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
})

/** 防御纵深：markdown-it `html:false` 已挡住注入，这层防的是未来配置漂移。 */
export function sanitizeHtml(html: string): string {
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } })
}

export function useMarkdown(content: Ref<string>) {
  const rendered = computed(() => sanitizeHtml(md.render(content.value || '')))
  return { rendered }
}
