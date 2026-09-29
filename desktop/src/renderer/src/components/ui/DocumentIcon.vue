<script setup lang="ts">
/**
 * DocumentIcon — the type icon of a file by its name (documentKind.ts, the
 * E-track contract §4 table): a language or PDF badge on its theme tone,
 * else a lucide line icon. Decorative (aria-hidden); the name says the rest.
 *
 * Props: path; size (default 15, the line icon's px); directory?.
 */
import {
  Braces,
  File,
  FileArchive,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  Folder,
  Globe,
} from 'lucide-vue-next'
import { computed, type Component } from 'vue'
import { documentGlyph, type DocumentKind } from '../../documentKind'

const props = withDefaults(
  defineProps<{ path: string; size?: number; directory?: boolean }>(),
  { size: 15, directory: false },
)

const ICONS: Record<Exclude<DocumentKind, 'language' | 'pdf'>, Component> = {
  document: FileText,
  data: Braces,
  code: FileCode,
  image: FileImage,
  sheet: FileSpreadsheet,
  archive: FileArchive,
  folder: Folder,
  web: Globe,
  file: File,
}

const glyph = computed(() =>
  documentGlyph(props.path, { directory: props.directory }),
)
const icon = computed(() => {
  const kind = glyph.value.kind
  return kind === 'language' || kind === 'pdf' ? File : ICONS[kind]
})
</script>

<template>
  <span
    v-if="glyph.badge"
    class="doc-badge"
    :data-tone="glyph.tone"
    :data-kind="glyph.kind"
    aria-hidden="true"
    >{{ glyph.badge }}</span
  >
  <component
    :is="icon"
    v-else
    :size="size"
    :data-kind="glyph.kind"
    aria-hidden="true"
  />
</template>

<style scoped>
.doc-badge {
  --badge-tone: var(--label-secondary);
  display: inline-grid;
  place-items: center;
  flex: none;
  min-width: 1.6em;
  padding: 0 0.3em;
  border-radius: var(--radius-xs);
  background: rgb(var(--badge-tone) / 0.14);
  color: rgb(var(--badge-tone));
  font: 700 0.625rem / 1.5 var(--font-mono);
}

.doc-badge[data-tone='blue'] {
  --badge-tone: var(--tone-blue);
}

.doc-badge[data-tone='cyan'] {
  --badge-tone: var(--tone-cyan);
}

.doc-badge[data-tone='warn'] {
  --badge-tone: var(--warn);
}

.doc-badge[data-tone='ok'] {
  --badge-tone: var(--ok);
}

.doc-badge[data-tone='brand'] {
  --badge-tone: var(--brand);
}

.doc-badge[data-tone='accent'] {
  --badge-tone: var(--accent);
}

.doc-badge[data-tone='danger'] {
  --badge-tone: var(--danger);
}
</style>
