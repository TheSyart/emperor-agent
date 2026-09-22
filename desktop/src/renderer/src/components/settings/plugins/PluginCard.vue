<script setup lang="ts">
/**
 * PluginCard — one installed Plugin in the Settings › 插件 grid (dsh plugin
 * inventory card): a compact header button (name, runtime dot, 已启用 /
 * 已停用 tag, chevron) that discloses the facts (DefinitionList) and the
 * controls — the enable switch and an inline-confirmed 「卸载」. Managed
 * Plugins are read-only.
 *
 * Props: plugin (plugins.list row), busy (a mutation is in flight).
 * v-model:open — disclosure state.
 * Emits: toggle(enabled), uninstall.
 */
import { computed, ref, watch } from 'vue'
import Button from '../../ui/Button.vue'
import { DsChevronDown } from '../../icons/ds'
import {
  DefinitionList,
  StatusBadge,
  Switch,
  settingsId,
  type DefinitionItem,
} from '../ui'
import {
  activationState,
  capabilityChips,
  scopeLabel,
  shortDigest,
  signatureLabel,
  sourceLabel,
  type PluginSummary,
} from './pluginInstall'

const props = defineProps<{ plugin: PluginSummary; busy?: boolean }>()
const emit = defineEmits<{ toggle: [enabled: boolean]; uninstall: [] }>()
const open = defineModel<boolean>('open', { default: false })

const uid = settingsId('plugin-card')
const confirming = ref(false)

const readOnly = computed(() => props.plugin.scope === 'managed')
const state = computed(() => activationState(props.plugin))
const configuration = computed(() =>
  props.plugin.enabled ? '已启用' : '已停用',
)

const facts = computed<DefinitionItem[]>(() => {
  const plugin = props.plugin
  const capabilities = capabilityChips(plugin.capabilities)
  return [
    { term: '版本', value: plugin.version || '未物化', mono: true },
    { term: '范围', value: scopeLabel(plugin.scope) },
    { term: '状态', value: state.value.label },
    { term: '来源', value: sourceLabel(plugin.source) },
    { term: '签名', value: signatureLabel(plugin.signature.status) },
    { term: '能力', value: capabilities.join('，') || '—' },
    { term: 'Digest', value: shortDigest(plugin.digest), mono: true },
  ]
})

watch(open, (value) => {
  if (!value) confirming.value = false
})

function toggle(enabled: boolean): void {
  emit('toggle', enabled)
}
</script>

<template>
  <li
    class="plugin-card"
    :data-open="open || undefined"
    :data-plugin-id="plugin.pluginId"
  >
    <button
      type="button"
      class="card-head"
      :aria-expanded="open"
      :aria-controls="`${uid}-details`"
      @click="open = !open"
    >
      <strong class="card-title" :title="plugin.pluginId">
        {{ plugin.name }}
      </strong>
      <span class="card-trailing">
        <span
          v-if="plugin.enabled"
          class="dot"
          :data-tone="state.tone"
          role="img"
          :aria-label="state.label"
          :title="state.label"
        />
        <StatusBadge :tone="plugin.enabled ? 'ok' : 'neutral'">
          {{ configuration }}
        </StatusBadge>
        <DsChevronDown :size="12" class="chevron" aria-hidden="true" />
      </span>
    </button>
    <div v-if="open" :id="`${uid}-details`" class="card-details">
      <code class="plugin-id">{{ plugin.pluginId }}</code>
      <DefinitionList :items="facts" />
      <div class="card-actions">
        <p v-if="readOnly" class="managed-note">
          受管 Plugin 由组织策略控制，不能在这里修改。
        </p>
        <template v-else-if="confirming">
          <span class="confirm-text">卸载后持久数据保留。确认卸载？</span>
          <Button
            size="sm"
            variant="outline"
            :disabled="busy"
            @click="confirming = false"
          >
            取消
          </Button>
          <Button
            size="sm"
            variant="danger"
            :disabled="busy"
            :aria-label="`确认卸载 ${plugin.name}`"
            @click="emit('uninstall')"
          >
            卸载
          </Button>
        </template>
        <template v-else>
          <label class="enable" :for="`${uid}-enabled`">
            <Switch
              :id="`${uid}-enabled`"
              :model-value="plugin.enabled"
              :disabled="busy"
              @update:model-value="toggle"
            />
            启用
          </label>
          <Button
            size="sm"
            variant="danger"
            :disabled="busy"
            :aria-label="`卸载 ${plugin.name}`"
            @click="confirming = true"
          >
            卸载
          </Button>
        </template>
      </div>
    </div>
  </li>
</template>

<style scoped>
.plugin-card {
  min-width: 0;
  overflow: hidden;
  border: 1px solid var(--border-l2);
  border-radius: var(--radius-cell);
  background: rgb(var(--bg-layer-3));
  list-style: none;
}

.plugin-card[data-open] {
  border-color: var(--border-l1);
  box-shadow: var(--shadow-lv1);
}

.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  width: 100%;
  min-height: calc(var(--space-6) * 2 + var(--space-1));
  padding: var(--space-3) var(--space-3-5);
  border: 0;
  background: transparent;
  font: inherit;
  color: inherit;
  text-align: left;
  cursor: pointer;
}

.card-head:hover,
.plugin-card[data-open] > .card-head {
  background: var(--interactive-bg-hover);
}

.card-head:focus-visible {
  outline: 2px solid rgb(var(--focus-ring));
  outline-offset: -2px;
}

.card-title {
  min-width: 0;
  overflow: hidden;
  font-size: var(--fs-s);
  line-height: var(--lh-s);
  font-weight: 600;
  color: rgb(var(--label-primary));
  text-overflow: ellipsis;
  white-space: nowrap;
}

.card-trailing {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: var(--space-1-5);
  color: rgb(var(--label-tertiary));
}

.dot {
  display: inline-block;
  flex: none;
  width: var(--space-1-5);
  height: var(--space-1-5);
  border-radius: var(--radius-pill);
  background: rgb(var(--label-tertiary));
}

.dot[data-tone='ok'] {
  background: rgb(var(--state-ok));
}

.dot[data-tone='warn'] {
  background: rgb(var(--state-warn));
}

.dot[data-tone='error'] {
  background: rgb(var(--state-error));
}

.chevron {
  flex: none;
  transition: transform var(--duration-ds-fast) var(--ease-in-out);
}

.plugin-card[data-open] .chevron {
  transform: rotate(180deg);
}

.card-details {
  display: flex;
  flex-direction: column;
  gap: var(--space-2-5);
  padding: var(--space-2-5) var(--space-3-5) var(--space-3);
  border-top: 1px solid var(--border-l2);
  background: rgb(var(--selector-fill));
}

.plugin-id {
  font: var(--font-code-small);
  color: rgb(var(--label-primary));
  overflow-wrap: anywhere;
}

.card-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: var(--space-2);
  padding-top: var(--space-2-5);
  border-top: 1px solid var(--border-l2);
}

.enable {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  margin-right: auto;
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  color: rgb(var(--label-secondary));
  cursor: pointer;
}

.confirm-text,
.managed-note {
  flex: 1 1 140px;
  min-width: 0;
  margin: 0;
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  color: rgb(var(--label-secondary));
}

.managed-note {
  color: rgb(var(--label-tertiary));
}
</style>
