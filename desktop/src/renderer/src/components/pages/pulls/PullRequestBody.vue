<script setup lang="ts">
/**
 * PullRequestBody — a PR description rendered as markdown. Untrusted:
 * useMarkdown renders without raw HTML and sanitizes (DOMPurify); template
 * comments are dropped, task-list markers become ☑ / ☐, images become links
 * (pullBodyHtml.ts), and every link click is handled here — http(s) opens
 * in the system browser, anything else (relative paths, anchors) does
 * nothing. Clicks never reach the chat's reference resolver, so a PR cannot
 * make the app open a local file.
 *
 * Loaded lazily by PullRequestDetail (markdown-it + DOMPurify stay out of
 * the page chunk). Props: body.
 */
import { computed, inject } from 'vue'
import { openExternal } from '../../../api/backend'
import { APP_CONTEXT_KEY } from '../../../composables/useAppContext'
import { useMarkdown } from '../../../composables/useMarkdown'
import { externalHref, neutralizeRemoteImages } from './pullBodyHtml'
import { prepareBodyMarkdown } from './pullRequestModel'

const props = defineProps<{ body: string }>()
const app = inject(APP_CONTEXT_KEY, null)

const source = computed(() => prepareBodyMarkdown(props.body))
const { rendered } = useMarkdown(source)
const html = computed(() => neutralizeRemoteImages(rendered.value))

function onClick(event: MouseEvent): void {
  const anchor = (event.target as Element | null)?.closest?.('a')
  if (!anchor) return
  event.preventDefault()
  event.stopPropagation()
  const href = externalHref(anchor)
  if (!href) return
  openExternal(href).catch(() => app?.showToast('无法在浏览器中打开链接'))
}
</script>

<template>
  <!-- sanitized by useMarkdown (DOMPurify); images neutralized -->
  <div
    v-if="source"
    class="markdown-body pr-md"
    data-pr-body
    @click="onClick"
    v-html="html"
  />
  <p v-else class="pr-md-empty">没有描述。</p>
</template>

<style scoped>
.pr-md {
  font-size: var(--fs-s);
  line-height: var(--lh-s);
}

.pr-md :deep(h1) {
  font-size: var(--fs-base);
  line-height: var(--lh-base);
}

.pr-md :deep(h2),
.pr-md :deep(h3) {
  font-size: var(--fs-s);
  line-height: var(--lh-s);
}

.pr-md :deep(input[type='checkbox']) {
  margin-right: var(--space-1-5);
  vertical-align: middle;
}

.pr-md :deep(.pr-md-image) {
  display: inline-flex;
  padding: 0 var(--space-1-5);
  border: 1px dashed var(--border-l3);
  border-radius: var(--radius-sm);
  color: rgb(var(--label-secondary));
  font-size: var(--fs-xxs);
  font-weight: 400;
  text-decoration: none;
}

.pr-md-empty {
  margin: 0;
  color: rgb(var(--label-tertiary));
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
}
</style>
