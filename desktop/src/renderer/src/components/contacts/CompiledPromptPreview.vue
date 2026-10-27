<script setup lang="ts">
/**
 * CompiledPromptPreview — 生成的系统提示词 (GRP-04): the persona section
 * the contact's sessions get, compiled by Core from the unsaved draft
 * exactly as at run time (`contacts.preview`; pinned knowledge and memory
 * included).
 *
 * Props: prompt; chars; version? (the saved version; none: unsaved);
 * loading?; error? (why the draft does not compile yet).
 */
import { computed } from 'vue'

const props = withDefaults(
  defineProps<{
    prompt: string
    chars: number
    version?: number | null
    loading?: boolean
    error?: string
  }>(),
  { version: null, loading: false, error: '' },
)

const caption = computed(() => {
  const size =
    props.chars >= 1000
      ? `${(props.chars / 1000).toFixed(1)}k 字`
      : `${props.chars} 字`
  return props.version ? `v${props.version} · ${size}` : `未保存 · ${size}`
})
</script>

<template>
  <section class="compiled" aria-label="生成的系统提示词">
    <header class="head">
      <h3 class="title">生成的系统提示词</h3>
      <span class="caption" :data-loading="loading || undefined">{{
        caption
      }}</span>
    </header>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <pre class="prompt" data-compiled-prompt>{{ prompt }}</pre>
  </section>
</template>

<style scoped>
.compiled {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-width: 0;
}

.head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-2);
}

.title {
  margin: 0;
  color: rgb(var(--text-1));
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  font-weight: var(--weight-semibold);
}

.caption {
  color: rgb(var(--text-3));
  font-size: var(--fs-xxs);
  font-variant-numeric: tabular-nums;
}

.caption[data-loading] {
  color: rgb(var(--text-4));
}

.error {
  margin: 0;
  color: rgb(var(--error));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
}

.prompt {
  max-height: 360px;
  margin: 0;
  padding: var(--space-2) var(--space-2-5);
  overflow: auto;
  border-radius: var(--r-sm);
  background: rgb(var(--surface-sunken));
  color: rgb(var(--text-3));
  font-family: var(--font-mono);
  font-size: var(--fs-xxxs);
  line-height: var(--lh-xxxs);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
