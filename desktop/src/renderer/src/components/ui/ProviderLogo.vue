<script setup lang="ts">
/**
 * ProviderLogo — a model provider's logo. Monochrome logos are masked in the
 * current label color so they read in both themes; color logos render as
 * images; providers without an upstream logo draw a generic glyph (server /
 * plug) or, when unknown, the first letter of the provider name.
 *
 * Props:
 * - iconId?: provider icon id (ProviderOption.iconId or the provider name).
 * - label: provider display name (fallback letter).
 * - size: 'xs' (16px, bare — chips and menu rows) | 'sm' (24px tile) |
 *   'md' (32px tile, default) | 'lg' (40px tile).
 */
import { computed } from 'vue'
import { providerGlyphIcons } from '../../icons'
import {
  providerIconAsset,
  providerIconFallback,
  providerIconGlyph,
  providerIconIsMonochrome,
  providerIconMaskCssUrl,
} from '../../model/providerIcons'

const props = withDefaults(
  defineProps<{
    iconId?: string | null
    label: string
    size?: 'xs' | 'sm' | 'md' | 'lg'
  }>(),
  { iconId: null, size: 'md' },
)

const asset = computed(() => providerIconAsset(props.iconId))
const monochrome = computed(() => providerIconIsMonochrome(props.iconId))
const glyph = computed(() => {
  const id = providerIconGlyph(props.iconId)
  return id ? providerGlyphIcons[id] : null
})
const maskStyle = computed(() =>
  asset.value ? { '--provider-mask': providerIconMaskCssUrl(asset.value) } : {},
)
</script>

<template>
  <span class="provider-logo" :data-size="size" aria-hidden="true">
    <span v-if="asset && monochrome" class="art mono" :style="maskStyle" />
    <img v-else-if="asset" class="art" :src="asset" alt="" />
    <component :is="glyph" v-else-if="glyph" class="art glyph" />
    <span v-else class="letter">{{ providerIconFallback(label) }}</span>
  </span>
</template>

<style scoped>
.provider-logo {
  --logo-box: var(--space-8);
  --logo-art: calc(var(--space-4) + var(--space-0-5));
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: var(--logo-box);
  height: var(--logo-box);
  overflow: hidden;
  border: 1px solid var(--border-l2);
  border-radius: var(--radius-row);
  background: rgb(var(--bg-layer-1));
  color: rgb(var(--label-primary));
}

.provider-logo[data-size='xs'] {
  --logo-box: var(--space-4);
  --logo-art: var(--space-3-5);
  border: 0;
  border-radius: 0;
  background: transparent;
}

.provider-logo[data-size='sm'] {
  --logo-box: var(--space-6);
  --logo-art: var(--space-3-5);
  border-radius: var(--radius-sm);
}

.provider-logo[data-size='lg'] {
  --logo-box: calc(var(--space-8) + var(--space-2));
  --logo-art: calc(var(--space-5) + var(--space-0-5));
  border-radius: var(--radius-cell);
}

.art {
  width: var(--logo-art);
  height: var(--logo-art);
  object-fit: contain;
}

.mono {
  background-color: currentColor;
  mask: var(--provider-mask) center / contain no-repeat;
}

.glyph {
  color: rgb(var(--label-secondary));
}

.letter {
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  font-weight: 600;
  color: rgb(var(--label-secondary));
}

.provider-logo[data-size='xs'] .letter,
.provider-logo[data-size='sm'] .letter {
  font-size: var(--fs-xxxs);
  line-height: var(--lh-xxxs);
}
</style>
