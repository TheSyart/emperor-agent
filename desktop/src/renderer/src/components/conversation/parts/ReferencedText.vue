<script setup lang="ts">
/**
 * ReferencedText — a sent message's text with its skill / plugin chips
 * (E-track §2.4): the saved `references` when they fit the text, else the
 * names the app knows now (older messages). A chip whose skill or plugin is
 * gone is greyed and says so. Inline; the parent sets the text style.
 *
 * Props: text, references?.
 */
import { computed } from 'vue'
import type { MessageReference } from '../../../types'
import { DsSkill } from '../../icons/ds'
import { useReferenceCatalog } from '../../composer/editor/referenceCatalog'
import { messageSegments } from '../../composer/editor/referenceText'

const props = defineProps<{
  text: string
  references?: readonly MessageReference[]
}>()

const catalog = useReferenceCatalog()
const segments = computed(() =>
  messageSegments(props.text, props.references, catalog),
)

function chipName(kind: string, label: string): string {
  return `${kind === 'skill' ? '技能' : '插件'} ${label}`
}
</script>

<template>
  <template v-for="(segment, index) in segments" :key="index"
    ><span
      v-if="segment.kind === 'chip'"
      class="reference-chip"
      :data-kind="segment.chip.kind"
      :data-unavailable="segment.available ? undefined : 'true'"
      role="img"
      :aria-label="
        segment.available
          ? chipName(segment.chip.kind, segment.chip.label)
          : `${chipName(segment.chip.kind, segment.chip.label)}（已不可用）`
      "
      :title="segment.available ? undefined : '已不可用'"
      ><DsSkill :size="14" class="reference-chip-icon" />{{
        segment.chip.label
      }}</span
    ><template v-else>{{ segment.text }}</template></template
  >
</template>

<style scoped>
.reference-chip {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  padding: 0 var(--space-1);
  margin: 0 var(--space-0-5);
  border-radius: var(--radius-cell);
  background: rgb(var(--accent-fill) / 0.12);
  color: rgb(var(--accent-strong));
  font-weight: 500;
  white-space: nowrap;
  vertical-align: baseline;
}

.reference-chip-icon {
  flex: none;
}

.reference-chip[data-unavailable] {
  background: var(--interactive-bg-hover);
  color: rgb(var(--label-tertiary));
  text-decoration: line-through;
}
</style>
