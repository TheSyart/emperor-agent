<script setup lang="ts">
/**
 * SourceBlocks — raw message blocks in model order (`Block #N type`);
 * tool-call blocks jump to their tool record.
 *
 * Props: blocks. Emits: open-call(callId).
 */
import type { TrajectorySourceBlock } from '../../../trajectory/model'
import DsChevronRight from '../../icons/ds/DsChevronRight.vue'

defineProps<{ blocks: readonly TrajectorySourceBlock[] }>()
defineEmits<{ 'open-call': [callId: string] }>()
</script>

<template>
  <div class="traj-source-blocks">
    <section v-for="(block, index) in blocks" :key="index" class="block">
      <button
        v-if="block.callId !== undefined"
        type="button"
        class="jump"
        :aria-label="`Open Block #${index + 1} tool call summary`"
        title="Open tool call summary"
        @click="$emit('open-call', block.callId)"
      >
        <span class="label">Block #{{ index + 1 }} {{ block.type }}</span>
        <DsChevronRight :size="12" class="jump-icon" />
      </button>
      <div v-else class="header">
        <span class="label">Block #{{ index + 1 }} {{ block.type }}</span>
      </div>
      <a
        v-if="block.imageSrc !== undefined"
        class="image-link"
        :href="block.imageSrc"
        target="_blank"
        rel="noopener noreferrer"
      >
        <img class="image" :src="block.imageSrc" :alt="block.imageAlt ?? ''" />
      </a>
      <pre v-else class="content">{{ block.content }}</pre>
    </section>
  </div>
</template>

<style scoped>
.traj-source-blocks {
  padding: var(--space-3) var(--space-3-5);
}

.block + .block {
  margin-top: var(--space-3-5);
}

.header,
.jump {
  display: flex;
  align-items: center;
  gap: 2px;
  width: max-content;
  margin-bottom: 2px;
  user-select: none;
}

.jump {
  padding: 0;
  border: 0;
  background: transparent;
  cursor: pointer;
}

.label {
  color: rgb(var(--label-tertiary));
  font: 11px / 16px var(--font-mono);
}

.jump-icon {
  color: rgb(var(--label-caption));
}

.jump:hover .jump-icon {
  color: rgb(var(--label-primary));
}

.content {
  margin: 0;
  overflow-wrap: anywhere;
  color: rgb(var(--label-primary));
  font: 12px / 19px var(--font-mono);
  tab-size: 2;
  white-space: pre-wrap;
}

.image-link {
  display: block;
  max-width: 100%;
  overflow: hidden;
  border-radius: 2px;
}

.image {
  display: block;
  max-width: 100%;
  max-height: 320px;
  object-fit: contain;
}
</style>
