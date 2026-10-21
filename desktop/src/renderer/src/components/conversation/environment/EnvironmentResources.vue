<script setup lang="ts">
/**
 * 来源 on the environment card (UI-S13): a small head 「来源」 with the
 * count, then at most three sources, one row each — what you provided
 * first, then what was read, then search hits (sourcesModel.ts) — with the
 * icon or thumbnail, the name and how it came (PROVENANCE_LABEL of its
 * strongest way in, sourceProvenance). Beyond
 * three, 「查看全部 N 个」 opens the 来源 view in the workbench
 * (workspace/SourcesView.vue, an async chunk of this card handed over as a
 * temporary view: `requestWorkspace({ view })`), which this card keeps up
 * to date while it stays mounted. A source opens as before: an image in the lightbox, anything else
 * in the resource detail. While older history is not loaded the head and
 * the link say 已加载.
 *
 * There is no 输出 row: a turn's files are in its 「已编辑 N 个文件」 card.
 *
 * Sources come from the loaded transcript (resourcesFromSnapshot):
 * attachments, 网页搜索, MCP servers, Skills. MCP names missing from the
 * boot tool list are resolved once via skills.tools.
 *
 * Props: sessionId, snapshot, hasMore (older history is not loaded).
 */
import { ChevronRight, Link } from 'lucide-vue-next'
import { computed, defineAsyncComponent, shallowRef, watch } from 'vue'
import { attachmentRawUrl } from '../../../api/attachments'
import { core } from '../../../api/http'
import { useAppContext } from '../../../composables/useAppContext'
import type { ChatSnapshot } from '../../../conversation/types'
import { type SourceToolInfo } from '../../workspace/workspaceSources'
import { requestWorkspace } from '../../workspace/workspaceState'
import { resourcesFromSnapshot } from '../resources/resourceIndex'
import { requestResourceDetail } from '../resources/resourceEvents'
import { openResourceImages } from '../resources/resourceImages'
import {
  PROVENANCE_LABEL,
  type DisplayResource,
} from '../resources/resourceModel'
import ResourceIcon from '../resources/ResourceIcon.vue'
import EnvironmentRow from './EnvironmentRow.vue'
import {
  CARD_SOURCE_LIMIT,
  orderSources,
  sourceProvenance,
  type SourcesViewState,
} from './sourcesModel'

// Loaded from this chunk, not the workbench's: its imports are already here.
const SourcesView = defineAsyncComponent(
  () => import('../../workspace/SourcesView.vue'),
)

const props = defineProps<{
  sessionId: string
  snapshot: ChatSnapshot
  hasMore?: boolean
}>()

const ctx = useAppContext()
/** `skills.tools` fetched once an MCP call is missing from the boot list. */
const fetchedTools = shallowRef<SourceToolInfo[] | null>(null)
let toolsRequested = false
const toolCatalog = computed<readonly SourceToolInfo[]>(
  () => fetchedTools.value ?? ctx.boot.value?.tools ?? [],
)
const sources = computed(() =>
  orderSources(
    resourcesFromSnapshot(props.snapshot, { tools: toolCatalog.value }).sources,
  ),
)
const shown = computed(() => sources.value.slice(0, CARD_SOURCE_LIMIT))
// Tool names never change once a row exists: rescan only for new rows.
watch(
  () => props.snapshot.order.length,
  () => {
    const snapshot = props.snapshot
    if (toolsRequested) return
    const known = new Set(toolCatalog.value.map((tool) => tool.name))
    const unresolved = snapshot.order.some((key) => {
      const node = snapshot.nodes.get(key)
      return (
        node?.kind === 'tool' &&
        node.data.name.startsWith('mcp_') &&
        !known.has(node.data.name)
      )
    })
    if (!unresolved) return
    toolsRequested = true
    void core('skills.tools')
      .then((list) => {
        if (Array.isArray(list)) fetchedTools.value = list
      })
      .catch(() => undefined)
  },
  { immediate: true },
)

function viewState(): SourcesViewState {
  return {
    sessionId: props.sessionId,
    sources: sources.value,
    nodes: props.snapshot.nodes,
    hasMore: props.hasMore === true,
  }
}
/** The 来源 view's props, following the list once it was opened. */
const viewProps = shallowRef<Record<string, unknown>>({})
let viewOpened = false
watch([sources, () => props.hasMore], () => {
  if (viewOpened) viewProps.value = { view: viewState() }
})
function openAll(): void {
  viewOpened = true
  viewProps.value = { view: viewState() }
  requestWorkspace({
    pane: 'launcher',
    view: {
      sessionId: props.sessionId,
      title: '来源',
      component: SourcesView,
      props: viewProps,
    },
  })
}

function isImage(resource: DisplayResource): boolean {
  return resource.kind === 'image' && Boolean(resource.attachmentId)
}
function select(resource: DisplayResource): void {
  if (isImage(resource))
    openResourceImages(resource, props.sessionId, sources.value)
  else requestResourceDetail(resource, props.sessionId)
}
</script>

<template>
  <section
    v-if="sources.length"
    class="sources"
    data-section="sources"
    :aria-label="hasMore ? '已加载来源' : '来源'"
  >
    <div class="sources-head">
      <span>{{ hasMore ? '已加载来源' : '来源' }}</span>
      <span class="count">{{ sources.length }}</span>
    </div>
    <EnvironmentRow
      v-for="item in shown"
      :key="item.id"
      data-source-item
      :label="item.label"
      :title="item.label"
      :value="PROVENANCE_LABEL[sourceProvenance(item)]"
      @click="select(item)"
    >
      <template #lead>
        <img
          v-if="isImage(item)"
          class="thumb"
          :src="attachmentRawUrl(item.attachmentId!)"
          alt=""
          loading="lazy"
        />
        <ResourceIcon
          v-else
          :resource="item"
          :session-id="sessionId"
          :size="16"
        />
      </template>
    </EnvironmentRow>
    <EnvironmentRow
      v-if="sources.length > CARD_SOURCE_LIMIT"
      class="all"
      data-row="sources-all"
      :label="
        hasMore
          ? `查看已加载的 ${sources.length} 个`
          : `查看全部 ${sources.length} 个`
      "
      @click="openAll"
    >
      <template #lead><Link :size="16" /></template>
      <template #value><ChevronRight :size="14" /></template>
    </EnvironmentRow>
  </section>
</template>

<style scoped>
.sources {
  display: flex;
  flex-direction: column;
  gap: var(--space-0-5);
}

/* The ListSection head: 12/18 medium, tertiary. */
.sources-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  padding: var(--space-0-5) var(--space-2);
  color: rgb(var(--text-3));
  font: var(--weight-medium) var(--type-caption) var(--font-sans);
}

.count {
  font-weight: var(--weight-regular);
  font-variant-numeric: tabular-nums;
}

.thumb {
  width: var(--icon-md);
  height: var(--icon-md);
  border-radius: var(--r-xs);
  object-fit: cover;
}

.sources .all {
  color: rgb(var(--text-2));
}
</style>
