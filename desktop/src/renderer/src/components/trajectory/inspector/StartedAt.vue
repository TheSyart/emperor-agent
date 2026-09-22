<script setup lang="ts">
/**
 * StartedAt — `Started` inspector row value: local timestamp that toggles
 * to the Unix seconds on click (dsh StartedAtValue).
 *
 * Props: timestamp (ms | null).
 */
import { ref } from 'vue'
import { formatStartedAt } from '../trajectoryFormat'

defineProps<{ timestamp: number | null | undefined }>()
const unix = ref(false)
</script>

<template>
  <div>
    <dt>Started</dt>
    <dd>
      <button
        v-if="
          timestamp !== null &&
          timestamp !== undefined &&
          Number.isFinite(timestamp)
        "
        type="button"
        class="toggle"
        :title="unix ? 'Show local time' : 'Show Unix timestamp'"
        @click="unix = !unix"
      >
        {{ unix ? (timestamp / 1000).toFixed(3) : formatStartedAt(timestamp) }}
      </button>
      <template v-else>Not available</template>
    </dd>
  </div>
</template>

<style scoped>
.toggle {
  all: unset;
  color: inherit;
  cursor: pointer;
  font: inherit;
  user-select: text;
}

.toggle:focus-visible {
  outline: 1px solid rgb(var(--focus-ring));
  outline-offset: 2px;
}
</style>
