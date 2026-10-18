<script setup lang="ts">
/**
 * One prose segment of assistant markdown (useMarkdown + chip links). Once
 * the segment is complete, its local file links are checked against Core
 * (linkStatus): a missing file is marked, a directory gets the folder icon,
 * and the hover title shows the full path. Image files the session owns
 * (Markdown images and links to image files) show inline previews that open
 * in the shared image viewer.
 */
import { inject, onMounted, onBeforeUnmount, ref, toRef, watch } from 'vue'
import { useMarkdown } from '../../../composables/useMarkdown'
import {
  handleMarkdownClick,
  handleMarkdownKeydown,
  restoreRemoteImages,
} from '../../../composables/useMarkdownLinks'
import { APP_CONTEXT_KEY } from '../../../composables/useAppContext'
import { LINK_STATUS_KEY, type LinkStatus } from './linkStatus'
import { documentIcon } from '../../../documentIcons'
import { hydrateMarkdownSiteIcons } from '../resources/siteIcons'
import { useChatContext } from '../chatContext'
import { openImageViewer } from '../../ui/imageViewer'

const props = withDefaults(
  defineProps<{
    text: string
    streaming?: boolean
    sourceMessageId?: string
  }>(),
  { streaming: false, sourceMessageId: 'markdown' },
)
const { rendered } = useMarkdown(toRef(() => props.text))
const root = ref<HTMLElement | null>(null)
const links = inject(LINK_STATUS_KEY, null)
const app = inject(APP_CONTEXT_KEY, null)
const linkOptions = { notify: (message: string) => app?.showToast(message) }
const chat = useChatContext()
let stopSiteIcons = () => {}
function markSiteIcons() {
  stopSiteIcons()
  if (root.value && !props.streaming)
    stopSiteIcons = hydrateMarkdownSiteIcons(
      root.value,
      chat.sessionId(),
      props.sourceMessageId,
    )
}
onBeforeUnmount(() => stopSiteIcons())

let generation = 0
onBeforeUnmount(() => {
  generation++
})

function onClick(event: MouseEvent): void {
  if (openImage(event)) return
  handleMarkdownClick(event, props.sourceMessageId, linkOptions)
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Enter' && event.key !== ' ') return
  if (!openImage(event)) handleMarkdownKeydown(event, linkOptions)
}

function openImage(event: MouseEvent | KeyboardEvent): boolean {
  const image = event.target
  if (!(image instanceof HTMLImageElement) || !image.getAttribute('src'))
    return false
  if (image.classList.contains('site-icon')) return false
  event.preventDefault()
  event.stopPropagation()
  openImageViewer({
    owner: chat.sessionId(),
    items: [
      {
        id: image.currentSrc || image.src,
        src: image.currentSrc || image.src,
        name: image.alt || '图片',
      },
    ],
  })
  return true
}

function enablePreview(image: HTMLImageElement): void {
  if (image.classList.contains('site-icon')) return
  image.tabIndex = 0
  image.setAttribute('role', 'button')
  image.setAttribute('aria-label', `放大预览 ${image.alt || '图片'}`)
  image.title = `放大预览 ${image.alt || '图片'}`
}

onMounted(() => {
  markSiteIcons()
  watch(
    [
      rendered,
      () => props.streaming,
      () => props.sourceMessageId,
      () => chat.sessionId(),
    ],
    markSiteIcons,
    { flush: 'post' },
  )
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
  if (!element) return
  restoreRemoteImages(element)
  element.querySelectorAll<HTMLImageElement>('img[src]').forEach(enablePreview)
  if (!links || props.streaming) return
  element.querySelectorAll('[data-md-preview]').forEach((node) => node.remove())
  const anchors = element.querySelectorAll<HTMLAnchorElement>(
    'a.md-link-chip[data-md-link="file"]',
  )
  await Promise.all(
    [...anchors].map(async (anchor) => {
      const status = await links.status(
        anchor.getAttribute('href') ?? '',
        props.sourceMessageId,
      )
      if (status && current === generation && anchor.isConnected)
        mark(anchor, status)
    }),
  )
  if (current !== generation || !links.image) return
  const explicit = [
    ...element.querySelectorAll<HTMLImageElement>('img[data-md-image]'),
  ]
  const files = [...anchors].filter((anchor) =>
    /\.(png|jpe?g|gif|webp)(?:[?#].*)?$/i.test(
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
      const src = await links.image!(href, props.sourceMessageId)
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
      enablePreview(image)
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
    anchor.dataset.mdCustomIcon = 'folder'
    delete anchor.dataset.mdColor
    anchor.style.removeProperty('--md-link-image')
    anchor.style.setProperty(
      '--md-link-ico',
      `url("${documentIcon(status.path, { directory: true }).mask}")`,
    )
  }
}
</script>

<template>
  <!-- sanitized by useMarkdown (DOMPurify) -->
  <div
    ref="root"
    class="ds-md-html"
    @click="onClick"
    @keydown="onKeydown"
    v-html="rendered"
  />
</template>
