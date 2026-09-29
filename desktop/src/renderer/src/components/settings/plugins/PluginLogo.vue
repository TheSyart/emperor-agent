<script setup lang="ts">
/**
 * PluginLogo — a plugin's square logo. The image comes from the host
 * (`logo`, never a file path); without one, or when it fails to load, a
 * stable monogram tile stands in: the first letter on a tone picked from
 * the name. The logo art is a full-bleed rounded tile already, so no extra
 * clip or frame is drawn around an image.
 *
 * Props: name, logo (host address or null), size (px, default 32).
 */
import { computed, ref, watch } from 'vue'
import { pluginMonogram } from './pluginsModel'

const props = withDefaults(
  defineProps<{ name: string; logo?: string | null; size?: number }>(),
  { logo: null, size: 32 },
)

const broken = ref(false)
watch(
  () => props.logo,
  () => (broken.value = false),
)
const monogram = computed(() => pluginMonogram(props.name))
const style = computed(() => ({
  '--plugin-logo-size': `${props.size}px`,
}))
</script>

<template>
  <img
    v-if="logo && !broken"
    class="plugin-logo"
    :src="logo"
    :style="style"
    alt=""
    aria-hidden="true"
    draggable="false"
    @error="broken = true"
  />
  <span
    v-else
    class="plugin-logo monogram"
    :data-tone="monogram.tone"
    :style="style"
    aria-hidden="true"
  >
    {{ monogram.letter }}
  </span>
</template>

<style scoped>
.plugin-logo {
  flex: none;
  width: var(--plugin-logo-size);
  height: var(--plugin-logo-size);
  object-fit: contain;
}

.monogram {
  --plugin-tone: var(--brand);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: calc(var(--plugin-logo-size) * 0.22);
  background: rgb(var(--plugin-tone) / 0.16);
  color: rgb(var(--plugin-tone));
  font-size: calc(var(--plugin-logo-size) * 0.46);
  font-weight: 700;
  line-height: 1;
  user-select: none;
}

.monogram[data-tone='accent'] {
  --plugin-tone: var(--accent);
}

.monogram[data-tone='ok'] {
  --plugin-tone: var(--ok);
}

.monogram[data-tone='warn'] {
  --plugin-tone: var(--warn);
}

.monogram[data-tone='cyan'] {
  --plugin-tone: var(--tone-cyan);
}
</style>
