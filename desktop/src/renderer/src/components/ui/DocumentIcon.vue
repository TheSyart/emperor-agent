<script setup lang="ts">
/** Decorative, individually drawn file glyph from the trusted SVG catalog. */
import { computed } from 'vue'
import { documentGlyph } from '../../documentKind'
import { documentIcon } from '../../documentIcons'

const props = withDefaults(
  defineProps<{ path: string; size?: number; directory?: boolean }>(),
  { size: 15, directory: false },
)

const glyph = computed(() =>
  documentGlyph(props.path, { directory: props.directory }),
)
const icon = computed(() =>
  documentIcon(props.path, { directory: props.directory }),
)
</script>

<template>
  <!-- v-html only receives bundled SVG geometry, never path/label content. -->
  <span
    class="document-icon"
    :style="{ width: `${size}px`, height: `${size}px` }"
    :data-icon-id="icon.id"
    :data-kind="glyph.kind"
    :data-tone="icon.tone"
    aria-hidden="true"
    v-html="icon.svg"
  />
</template>

<style scoped>
.document-icon {
  --document-tone: var(--text-2);
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  color: rgb(var(--document-tone));
  vertical-align: -0.125em;
}

.document-icon :deep(svg) {
  display: block;
  width: 100%;
  height: 100%;
}

.document-icon[data-tone='blue'] {
  --document-tone: var(--tone-blue);
}

.document-icon[data-tone='cyan'] {
  --document-tone: var(--tone-cyan);
}

.document-icon[data-tone='warn'] {
  --document-tone: var(--warn);
}

.document-icon[data-tone='ok'] {
  --document-tone: var(--ok);
}

.document-icon[data-tone='brand'] {
  --document-tone: var(--brand);
}

.document-icon[data-tone='accent'] {
  --document-tone: var(--accent);
}

.document-icon[data-tone='danger'] {
  --document-tone: var(--error);
}
</style>
