<script setup lang="ts">
import { computed, inject, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import {
  BookOpen,
  CircleDot,
  GitCommitHorizontal,
  GitPullRequest,
  Github,
  Plug,
  Puzzle,
  Tag,
  Workflow,
} from 'lucide-vue-next'
import DocumentIcon from '../../ui/DocumentIcon.vue'
import { DsSkill } from '../../icons/ds'
import type { DisplayResource } from './resourceModel'
import { APP_CONTEXT_KEY } from '../../../composables/useAppContext'
import { nearestAvatarSize } from '../../ui/avatar'
import Avatar from '../../ui/Avatar.vue'
import { useChatContext } from '../chatContext'
import { loadSiteIcon, whenVisible } from './siteIcons'
const props = withDefaults(
  defineProps<{
    resource: DisplayResource
    size?: number
    sessionId?: string
  }>(),
  { size: 16 },
)
const chat = useChatContext()
const siteRoot = ref<HTMLElement | null>(null)
const siteImage = ref<string | null>(null)
let generation = 0
let stop = () => {}
function refreshSiteIcon() {
  const current = ++generation
  stop()
  siteImage.value = null
  const sessionId = props.sessionId ?? chat.sessionId()
  if (!siteRoot.value || props.resource.kind !== 'web' || !sessionId) return
  stop = whenVisible(siteRoot.value, () => {
    void loadSiteIcon(sessionId, props.resource).then((value) => {
      if (
        generation === current &&
        sessionId === (props.sessionId ?? chat.sessionId())
      )
        siteImage.value = value
    })
  })
}
onMounted(refreshSiteIcon)
watch(
  () => [
    props.resource.href,
    props.resource.sourceMessageId,
    props.sessionId ?? chat.sessionId(),
  ],
  refreshSiteIcon,
  { flush: 'post' },
)
onBeforeUnmount(() => {
  generation++
  stop()
})
const context = inject(APP_CONTEXT_KEY, null)
const pluginLogo = computed(
  () =>
    context?.boot.value?.plugins?.find(
      (plugin) => `plugin:${plugin.pluginId}` === props.resource.id,
    )?.logo ?? null,
)
const icon = computed(() =>
  props.resource.kind === 'github'
    ? {
        repository: BookOpen,
        pull_request: GitPullRequest,
        issue: CircleDot,
        commit: GitCommitHorizontal,
        release: Tag,
        run: Workflow,
        page: Github,
      }[props.resource.github?.type ?? 'page']
    : ({ skill: DsSkill, plugin: Puzzle, mcp: Plug } as const)[
        props.resource.kind as 'skill' | 'plugin' | 'mcp'
      ],
)
const site = computed(() => {
  try {
    return new URL(props.resource.href).hostname
      .replace(/^www\./, '')
      .slice(0, 1)
      .toUpperCase()
  } catch {
    return 'W'
  }
})
</script>
<template>
  <Avatar
    kind="logo"
    v-if="resource.kind === 'plugin'"
    :label="resource.label"
    :src="pluginLogo"
    :size="nearestAvatarSize(size)"
  />
  <span
    v-else-if="resource.kind === 'web'"
    ref="siteRoot"
    class="site-mark"
    :data-site-icon="siteImage ? 'ready' : undefined"
    :style="{ width: `${size}px`, height: `${size}px` }"
    aria-hidden="true"
    ><img
      v-if="siteImage"
      class="site-icon"
      :src="siteImage"
      alt=""
      :width="size"
      :height="size"
      @error="siteImage = null"
    /><template v-else>{{ site }}</template></span
  >
  <component
    :is="icon"
    v-else-if="
      icon && !['file', 'folder', 'attachment'].includes(resource.kind)
    "
    :size="size"
    aria-hidden="true"
  />
  <DocumentIcon
    v-else
    :path="
      resource.attachmentId ? resource.label : resource.href || resource.label
    "
    :directory="resource.kind === 'folder'"
    :size="size"
  />
</template>
<style scoped>
.site-mark {
  display: inline-grid;
  place-items: center;
  flex: none;
  border-radius: var(--r-xs);
  background: rgb(var(--accent) / 0.1);
  color: rgb(var(--text-link));
  font: var(--weight-semibold) 0.65rem/1 var(--font-sans);
}
.site-icon {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
  border-radius: var(--r-xs);
  background: rgb(var(--nb-00));
}
</style>
