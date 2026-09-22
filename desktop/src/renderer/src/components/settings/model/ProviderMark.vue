<script setup lang="ts">
/**
 * ProviderMark — 32px provider avatar of a model row: the provider logo
 * (monochrome logos are masked in the current label color so they read in
 * both themes; color logos render as images) or the first letter of the
 * provider name.
 *
 * Props:
 * - iconId?: provider icon id (ProviderOption.iconId or the provider name).
 * - label: provider display name (fallback letter + alt text).
 */
import { computed } from 'vue'
import {
  providerIconAsset,
  providerIconFallback,
  providerIconIsMonochrome,
  providerIconMaskCssUrl,
} from '../../../model/providerIcons'

const props = defineProps<{ iconId?: string | null; label: string }>()

const asset = computed(() => providerIconAsset(props.iconId))
const monochrome = computed(() => providerIconIsMonochrome(props.iconId))
const maskStyle = computed(() =>
  asset.value ? { '--provider-mask': providerIconMaskCssUrl(asset.value) } : {},
)
</script>

<template>
  <span class="provider-mark" aria-hidden="true">
    <span v-if="asset && monochrome" class="mono" :style="maskStyle" />
    <img v-else-if="asset" :src="asset" alt="" />
    <span v-else class="letter">{{ providerIconFallback(label) }}</span>
  </span>
</template>

<style scoped>
.provider-mark {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: var(--space-8);
  height: var(--space-8);
  overflow: hidden;
  border: 1px solid var(--border-l2);
  border-radius: var(--radius-row);
  background: rgb(var(--bg-layer-1));
  color: rgb(var(--label-primary));
}

.mono {
  width: var(--space-4);
  height: var(--space-4);
  background-color: currentColor;
  mask: var(--provider-mask) center / contain no-repeat;
}

img {
  width: var(--space-4);
  height: var(--space-4);
  object-fit: contain;
}

.letter {
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  font-weight: 600;
  color: rgb(var(--label-secondary));
}
</style>
