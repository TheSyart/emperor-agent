<script setup lang="ts">
/**
 * FileDocumentPreview — a PDF, Office, iWork or RTF document in the Files
 * pane (BUG-10): its first page as macOS's Quick Look draws it (served
 * from files.mediaUrl) and, when Core could read it, its text, switched
 * with 「预览图 / 文字」; 「用默认应用打开」 and 「在访达中显示」 above.
 *
 * Props: target (the tab's preview input), name, thumbnail (a first page
 * exists), text, openable.
 */
import { computed, ref } from 'vue'
import type { FilePreviewInput } from '@emperor/core/api'
import Segmented from '../ui/Segmented.vue'
import FileOpenActions from './FileOpenActions.vue'
import { useMediaAddress } from './useFileAddress'

const props = defineProps<{
  target: FilePreviewInput
  name: string
  thumbnail?: boolean
  text?: string
  openable?: boolean
}>()

type View = 'page' | 'text'
const view = ref<View>(props.thumbnail ? 'page' : 'text')
const views = computed(() => [
  { value: 'page' as const, label: '预览图' },
  { value: 'text' as const, label: '文字' },
])
const page = props.thumbnail ? useMediaAddress(() => props.target) : null
const pageShown = computed(
  () => view.value === 'page' && page?.state.value === 'ready',
)
</script>

<template>
  <div class="file-document">
    <div class="file-document-bar">
      <Segmented
        v-if="thumbnail && text"
        v-model="view"
        :options="views"
        aria-label="文档视图"
      />
      <FileOpenActions :target="target" :openable="openable" />
    </div>
    <img
      v-if="pageShown"
      class="file-document-page"
      :src="page!.url.value"
      :alt="`${name} 第一页`"
      @error="page!.failed()"
      @load="page!.loaded()"
    />
    <p
      v-else-if="view === 'page' && page?.state.value === 'unplayable'"
      class="file-document-muted"
    >
      第一页预览图不可用
    </p>
    <pre v-else-if="view === 'text' && text" class="file-document-text">{{
      text
    }}</pre>
  </div>
</template>

<style scoped>
.file-document {
  display: grid;
  gap: var(--space-3);
}

.file-document-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}

.file-document-page {
  display: block;
  max-width: min(100%, 560px);
  max-height: 70vh;
  justify-self: center;
  border-radius: var(--r-sm);
  box-shadow:
    0 0 0 0.5px var(--hairline),
    var(--elev-1);
  background: rgb(var(--surface-base));
}

.file-document-text {
  margin: 0;
  padding: var(--space-3);
  border-radius: var(--radius-cell);
  background: rgb(var(--surface-sunken));
  color: rgb(var(--text-1));
  font: var(--font-s);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.file-document-muted {
  margin: 0;
  padding: var(--space-2);
  color: rgb(var(--text-3));
  font: var(--font-xs);
}
</style>
