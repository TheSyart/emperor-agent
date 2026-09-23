<script setup lang="ts">
/**
 * ProviderPicker — the provider catalog as logo tiles, split into region
 * sections (国内 / 海外 / 聚合 / 本地 / 自定义) with a search box. Used as the
 * first step of 「添加模型」 and by the entry editor's 「更换」.
 *
 * Props:
 * - options: the Provider catalog (ModelConfigPayload.providerOptions).
 * - counts?: saved model count per provider name (shows 「已添加 n」).
 * - selected?: the provider currently chosen (marked, aria-pressed).
 * Emits: pick(providerName).
 */
import { computed, ref } from 'vue'
import type { ProviderOption } from '../../../types'
import ProviderLogo from '../../ui/ProviderLogo.vue'
import { SearchField } from '../ui'
import {
  providerDisplayName,
  providerNameParts,
  providerSections,
} from '../../../model/providerGroups'

const props = withDefaults(
  defineProps<{
    options: readonly ProviderOption[]
    counts?: Readonly<Record<string, number>>
    selected?: string | null
  }>(),
  { counts: () => ({}), selected: null },
)
const emit = defineEmits<{ pick: [provider: string] }>()

const query = ref('')
const sections = computed(() => providerSections(props.options, query.value))

function tileLabel(option: ProviderOption): string {
  const count = props.counts[option.name]
  const name = providerDisplayName(option.name, option)
  return count ? `${name}，已添加 ${count} 个模型` : name
}

function tileParts(option: ProviderOption): { name: string; caption: string } {
  const { name, note } = providerNameParts(
    providerDisplayName(option.name, option),
  )
  const count = props.counts[option.name]
  return {
    name,
    caption: [note, count ? `已添加 ${count}` : ''].filter(Boolean).join(' · '),
  }
}
</script>

<template>
  <div class="provider-picker" data-testid="provider-picker">
    <SearchField
      v-model="query"
      size="sm"
      placeholder="搜索供应商"
      aria-label="搜索供应商"
    />
    <section
      v-for="section in sections"
      :key="section.region"
      class="section"
      :aria-label="section.label"
    >
      <h5 class="section-title">{{ section.label }}</h5>
      <div class="grid">
        <button
          v-for="option in section.providers"
          :key="option.name"
          type="button"
          class="tile"
          :aria-pressed="option.name === selected"
          :title="providerDisplayName(option.name, option)"
          :aria-label="tileLabel(option)"
          @click="emit('pick', option.name)"
        >
          <ProviderLogo
            :icon-id="option.iconId || option.name"
            :label="providerDisplayName(option.name, option)"
            size="sm"
          />
          <span class="tile-text">
            <span class="tile-name">{{ tileParts(option).name }}</span>
            <span v-if="tileParts(option).caption" class="tile-caption">
              {{ tileParts(option).caption }}
            </span>
          </span>
        </button>
      </div>
    </section>
    <p v-if="!sections.length" class="empty">没有匹配的供应商</p>
  </div>
</template>

<style scoped>
.provider-picker {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  min-width: 0;
}

.section {
  display: flex;
  flex-direction: column;
  gap: var(--space-1-5);
  min-width: 0;
}

.section-title {
  margin: 0;
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  font-weight: 500;
  color: rgb(var(--label-tertiary));
}

.grid {
  display: grid;
  grid-template-columns: repeat(
    auto-fill,
    minmax(calc(var(--space-8) * 5), 1fr)
  );
  gap: var(--space-1-5);
}

.tile {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  min-height: calc(var(--space-8) + var(--space-3));
  padding: var(--space-1) var(--space-2-5) var(--space-1) var(--space-2);
  border: 1px solid var(--border-l2);
  border-radius: var(--radius-cell);
  background: transparent;
  color: rgb(var(--label-primary));
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition:
    background-color var(--duration-ds-fast) ease,
    border-color var(--duration-ds-fast) ease;
}

.tile:hover {
  border-color: rgb(var(--label-dimmed));
  background: var(--interactive-bg-hover);
}

.tile:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px rgb(var(--focus-ring) / 0.5);
}

.tile[aria-pressed='true'] {
  border-color: rgb(var(--accent-fill) / 0.6);
  background: rgb(var(--accent-soft));
}

.tile-text {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
}

.tile-name,
.tile-caption {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tile-name {
  font-size: var(--fs-xs);
  line-height: var(--lh-xxs);
}

.tile-caption {
  font-size: var(--fs-xxxs);
  line-height: var(--lh-xxxs);
  color: rgb(var(--label-tertiary));
}

.empty {
  margin: 0;
  padding: var(--space-4) 0;
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  color: rgb(var(--label-tertiary));
  text-align: center;
}
</style>
