<script setup lang="ts">
/**
 * GroupMarkdown — what a member said (Markdown, like a reply in a chat)
 * with its @-mentions marked (GRP-08, 预览 B: 「@ 高亮」). The marks are
 * put on the rendered text after each render — never inside code, a link
 * or a mark already there — so the Markdown renderer and its sanitizer
 * stay as they are.
 *
 * Props: content; names (the names an @ can mean).
 */
import { nextTick, onMounted, ref, watch } from 'vue'
import MarkdownBlock from '../chat/MarkdownBlock.vue'
import { mentionPattern } from './groupModel'

const props = defineProps<{ content: string; names: readonly string[] }>()
const host = ref<HTMLElement | null>(null)

function mark(): void {
  const element = host.value
  const pattern = mentionPattern(props.names)
  if (!element || !pattern) return
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node.parentElement?.closest('code, pre, a, .mention')
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT,
  })
  const texts: Text[] = []
  for (let node = walker.nextNode(); node; node = walker.nextNode())
    texts.push(node as Text)
  for (const node of texts) {
    const text = node.data
    pattern.lastIndex = 0
    if (!pattern.test(text)) continue
    pattern.lastIndex = 0
    const fragment = document.createDocumentFragment()
    let last = 0
    for (const match of text.matchAll(pattern)) {
      const at = match.index ?? 0
      if (at > last)
        fragment.append(document.createTextNode(text.slice(last, at)))
      const span = document.createElement('span')
      span.className = 'mention'
      span.textContent = match[0]
      fragment.append(span)
      last = at + match[0].length
    }
    if (last < text.length)
      fragment.append(document.createTextNode(text.slice(last)))
    node.replaceWith(fragment)
  }
}

onMounted(mark)
watch(
  () => [props.content, props.names.join('\n')],
  () => void nextTick(mark),
  { flush: 'post' },
)
</script>

<template>
  <div ref="host" class="group-markdown">
    <MarkdownBlock :content="content" />
  </div>
</template>

<style scoped>
.group-markdown :deep(.mention) {
  padding: 0 var(--space-1);
  border-radius: var(--r-xs);
  background: rgb(var(--accent-soft));
  color: rgb(var(--text-link));
  font-weight: var(--weight-medium);
}
</style>
