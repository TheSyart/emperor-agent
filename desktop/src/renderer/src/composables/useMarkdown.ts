import MarkdownIt from 'markdown-it'
import { computed, type Ref } from 'vue'

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
})

export function useMarkdown(content: Ref<string>) {
  const rendered = computed(() => md.render(content.value || ''))
  return { rendered }
}
