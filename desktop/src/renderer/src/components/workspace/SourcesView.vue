<script setup lang="ts">
/**
 * SourcesView — the workbench's 来源 view (UI-S13): every source of one
 * chat window, opened from 「查看全部」 on the environment card. An async
 * chunk the card imports and hands to WorkspacePanel as a temporary view
 * (`requestWorkspace({ view })`), so its code stays out of the startup
 * graph. Head: 返回, 来源 (已加载来源 while older history is not loaded) and
 * the count. Body: one List, grouped 你提供的 / 已查看 / 搜索命中 (then any
 * other provenance under its own word), empty groups left out. A row: the
 * icon or thumbnail and the name; the path (home as `~`) or address on a
 * second, monospace, wrapping line; a third line only with what the
 * transcript says (the search that found it, how many places used it).
 * Choosing a row opens it as the card does: an image in the lightbox,
 * anything else in its detail (a file in 文件).
 *
 * Props: view (SourcesViewState). Emits: close.
 */
import { ArrowLeft } from 'lucide-vue-next'
import { computed } from 'vue'
import { attachmentRawUrl } from '../../api/attachments'
import {
  sourceGroups,
  type SourcesViewState,
} from '../conversation/environment/sourcesModel'
import ResourceIcon from '../conversation/resources/ResourceIcon.vue'
import { requestResourceDetail } from '../conversation/resources/resourceEvents'
import { openResourceImages } from '../conversation/resources/resourceImages'
import type { DisplayResource } from '../conversation/resources/resourceModel'
import IconButton from '../ui/IconButton.vue'
import List from '../ui/List.vue'
import ListRow from '../ui/ListRow.vue'
import ListSection from '../ui/ListSection.vue'

const props = defineProps<{ view: SourcesViewState }>()
const emit = defineEmits<{ close: [] }>()

const title = computed(() => (props.view.hasMore ? '已加载来源' : '来源'))
const groups = computed(() =>
  sourceGroups(props.view.sources, props.view.nodes),
)

function isImage(resource: DisplayResource): boolean {
  return resource.kind === 'image' && Boolean(resource.attachmentId)
}

function open(resource: DisplayResource): void {
  const session = props.view.sessionId
  if (isImage(resource))
    openResourceImages(resource, session, props.view.sources)
  else requestResourceDetail(resource, session)
}
</script>

<template>
  <section class="sources-view" :aria-label="title" data-sources-view>
    <header class="head">
      <IconButton label="返回" @click="emit('close')">
        <ArrowLeft :size="14" />
      </IconButton>
      <strong class="title">{{ title }}</strong>
      <span class="count">{{ view.sources.length }}</span>
    </header>
    <div class="body">
      <List :label="title">
        <ListSection
          v-for="group in groups"
          :key="group.key"
          :title="`${group.label} · ${group.entries.length}`"
          :data-source-group="group.key"
        >
          <ListRow
            v-for="entry in group.entries"
            :key="entry.resource.id"
            :title="entry.resource.label"
            wrap
            data-source-entry
            @select="open(entry.resource)"
          >
            <template #leading>
              <img
                v-if="isImage(entry.resource)"
                class="thumb"
                :src="attachmentRawUrl(entry.resource.attachmentId!)"
                alt=""
                loading="lazy"
              />
              <ResourceIcon
                v-else
                :resource="entry.resource"
                :session-id="view.sessionId"
                :size="16"
              />
            </template>
            <template #subtitle>
              <span class="location" :class="{ mono: entry.location.mono }">{{
                entry.location.text
              }}</span>
              <span v-if="entry.note" class="note">{{ entry.note }}</span>
            </template>
          </ListRow>
        </ListSection>
      </List>
    </div>
  </section>
</template>

<style scoped>
.sources-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.head {
  display: flex;
  flex: none;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  box-shadow: inset 0 -0.5px 0 var(--hairline);
}

.title {
  font: var(--weight-semibold) var(--type-footnote) var(--font-sans);
}

.count {
  color: rgb(var(--text-3));
  font: var(--font-xs);
  font-variant-numeric: tabular-nums;
}

.body {
  flex: 1;
  min-height: 0;
  padding: var(--space-2) var(--space-2) var(--space-4);
  overflow-y: auto;
}

.thumb {
  width: var(--icon-md);
  height: var(--icon-md);
  border-radius: var(--r-xs);
  object-fit: cover;
}

.location,
.note {
  display: block;
}

.location {
  margin-top: var(--space-0-5);
}

.location.mono {
  font: var(--font-code-small);
}

.note {
  margin-top: var(--space-0-5);
  color: rgb(var(--text-2));
}
</style>
