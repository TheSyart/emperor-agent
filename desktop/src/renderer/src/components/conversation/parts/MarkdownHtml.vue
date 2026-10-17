<script setup lang="ts">
/**
 * One prose segment of assistant markdown (useMarkdown + chip links). Once
 * the segment is complete, its local file links are checked against Core
 * (linkStatus): a missing file is marked, a directory gets the folder icon,
 * and the hover title shows the full path.
 */
import { inject, onBeforeUnmount, onMounted, ref, toRef, watch } from 'vue'
import { useMarkdown } from '../../../composables/useMarkdown'
import { handleMarkdownChipClick } from '../../../composables/useMarkdownLinks'
import { LINK_STATUS_KEY, type LinkStatus } from './linkStatus'

const props = withDefaults(
  defineProps<{ text: string; streaming?: boolean }>(),
  { streaming: false },
)
const { rendered } = useMarkdown(toRef(() => props.text))
const root = ref<HTMLElement | null>(null)
const links = inject(LINK_STATUS_KEY, null)
let generation = 0
onBeforeUnmount(() => {
  generation++
})

function onClick(event: MouseEvent): void {
  handleMarkdownChipClick(event, 'conversation')
}

onMounted(() => {
  void markLinks()
  watch(
    [rendered, () => props.streaming, () => links?.version.value],
    () => void markLinks(),
    { flush: 'post' },
  )
})

async function markLinks(): Promise<void> {
  const current = ++generation
  const element = root.value
  if (!links || props.streaming || !element) return
  element.querySelectorAll('[data-md-preview]').forEach((node) => node.remove())
  const anchors = element.querySelectorAll<HTMLAnchorElement>(
    'a.md-link-chip[data-md-link="file"]',
  )
  await Promise.all(
    [...anchors].map(async (anchor) => {
      const status = await links.status(anchor.getAttribute('href') ?? '')
      if (status && current === generation && anchor.isConnected)
        mark(anchor, status)
    }),
  )
  if (current !== generation || !links.image) return
  const explicit = [
    ...element.querySelectorAll<HTMLImageElement>('img[data-md-image]'),
  ]
  const files = [...anchors].filter((anchor) =>
    /\.(png|jpe?g|gif|webp|svg)(?:[?#].*)?$/i.test(
      anchor.getAttribute('href') ?? '',
    ),
  )
  await Promise.all(
    [...explicit, ...files].map(async (node) => {
      const href =
        node.getAttribute(
          node instanceof HTMLImageElement ? 'data-md-image' : 'href',
        ) ?? ''
      if (node instanceof HTMLImageElement) node.removeAttribute('src')
      const src = await links.image!(href)
      if (current !== generation || !node.isConnected) return
      if (!src) {
        if (node instanceof HTMLImageElement) {
          const fallback = document.createElement('a')
          fallback.className = 'md-link-chip'
          fallback.dataset.mdLink = 'file'
          fallback.href = href
          fallback.textContent = `${node.alt || '图片'}（无法预览，打开文件）`
          node.replaceWith(fallback)
        }
        return
      }
      const image =
        node instanceof HTMLImageElement ? node : document.createElement('img')
      image.classList.add('md-image-preview')
      image.alt ||= node.textContent || '图片'
      image.src = src
      if (!(node instanceof HTMLImageElement)) {
        image.dataset.mdPreview = 'true'
        node.after(image)
      }
    }),
  )
}

function mark(anchor: HTMLAnchorElement, status: LinkStatus): void {
  const missing = status.state === 'missing'
  anchor.title = missing ? `不存在：${status.path}` : status.path
  if (missing) {
    anchor.dataset.mdState = 'missing'
    anchor.setAttribute('aria-disabled', 'true')
  } else {
    delete anchor.dataset.mdState
    anchor.removeAttribute('aria-disabled')
  }
  if (status.state === 'directory') {
    anchor.dataset.mdIcon = 'folder'
    delete anchor.dataset.mdBadge
    delete anchor.dataset.mdTone
  }
}
</script>

<template>
  <!-- sanitized by useMarkdown (DOMPurify) -->
  <div ref="root" class="ds-md-html" @click="onClick" v-html="rendered" />
</template>
