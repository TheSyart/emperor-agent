<script setup lang="ts">
/**
 * McpServerCard — one MCP server in Settings › MCP (dsh McpSettingsTab card
 * on SettingsCard): status dot, name, transport badge, state · tool count,
 * enable Switch. Expanding shows the connection facts (DefinitionList: masked
 * URL or command line, header / env keys, last error), the discovered tools
 * and 删除.
 *
 * Props:
 * - server: McpServerView (mcpModel.buildMcpServerViews).
 * - busy?: a toggle / removal for this server is in flight.
 * - open (v-model:open): expanded state.
 * Emits: toggle(enabled) from the Switch, remove from 删除.
 */
import { computed } from 'vue'
import Button from '../../ui/Button.vue'
import { DsTrash } from '../../icons/ds'
import { DefinitionList, SettingsCard, StatusBadge, Switch } from '../ui'
import {
  mcpEmptyToolsText,
  mcpServerFacts,
  mcpServerSummary,
  mcpTransportLabel,
  type McpServerView,
} from './mcpModel'

const props = withDefaults(
  defineProps<{ server: McpServerView; busy?: boolean }>(),
  { busy: false },
)
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ toggle: [enabled: boolean]; remove: [] }>()

const facts = computed(() => mcpServerFacts(props.server))
const summary = computed(() => mcpServerSummary(props.server))

function onToggle(value: boolean) {
  emit('toggle', value)
}
</script>

<template>
  <SettingsCard
    v-model:open="open"
    expandable
    class="mcp-server-card"
    :title="server.name"
    :data-server="server.name"
    :data-state="server.state"
  >
    <template #leading>
      <span
        class="state-dot"
        :data-state="server.state"
        role="img"
        :aria-label="server.stateLabel"
      />
    </template>
    <template #meta>
      <StatusBadge mono>{{ mcpTransportLabel(server.transport) }}</StatusBadge>
    </template>
    <template #description>
      <span class="summary" :data-tone="server.tone" :title="summary">
        {{ summary }}
      </span>
    </template>
    <template #actions>
      <Switch
        :model-value="server.enabled"
        :disabled="busy"
        :aria-label="`启用 ${server.name}`"
        @update:model-value="onToggle"
      />
    </template>

    <DefinitionList :items="facts" />

    <div class="tools">
      <div class="tools-head">
        <span>工具</span>
        <span class="tools-count">{{ server.tools.length }}</span>
      </div>
      <ul v-if="server.tools.length" class="tool-list">
        <li v-for="tool in server.tools" :key="tool.name" class="tool">
          <code class="tool-name">{{ tool.name }}</code>
          <span v-if="tool.description" class="tool-description">
            {{ tool.description }}
          </span>
        </li>
      </ul>
      <p v-else class="tools-empty">{{ mcpEmptyToolsText(server) }}</p>
    </div>

    <template #footer>
      <Button
        size="sm"
        variant="danger"
        :disabled="busy"
        :aria-label="`删除 ${server.name}`"
        @click="emit('remove')"
      >
        <template #icon><DsTrash :size="14" /></template>
        删除
      </Button>
    </template>
  </SettingsCard>
</template>

<style scoped>
.state-dot {
  position: relative;
  display: inline-block;
  flex: none;
  width: var(--space-2-5);
  height: var(--space-2-5);
  border-radius: var(--radius-pill);
  color: rgb(var(--label-tertiary));
}

.state-dot::before,
.state-dot::after {
  content: '';
  position: absolute;
  border-radius: inherit;
  background: currentColor;
}

.state-dot::before {
  inset: 0;
  opacity: 0.16;
}

.state-dot::after {
  inset: 2px;
}

.state-dot[data-state='connected'] {
  color: rgb(var(--state-ok));
}

.state-dot[data-state='connecting'] {
  color: rgb(var(--state-warn));
}

.state-dot[data-state='connecting']::before {
  animation: mcp-dot-pulse 1.2s var(--ease-in-out) infinite;
}

.state-dot[data-state='failed'] {
  color: rgb(var(--state-error));
}

.state-dot[data-state='disabled'] {
  color: rgb(var(--label-tertiary));
}

.state-dot[data-state='disabled']::before {
  opacity: 0;
}

.state-dot[data-state='disabled']::after {
  inset: 1px;
  background: transparent;
  box-shadow: inset 0 0 0 1.5px currentColor;
}

@keyframes mcp-dot-pulse {
  0%,
  100% {
    opacity: 0.12;
    transform: scale(0.8);
  }

  50% {
    opacity: 0.32;
    transform: scale(1.15);
  }
}

.summary {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.summary[data-tone='error'] {
  color: rgb(var(--state-error-label));
}

.tools {
  display: flex;
  flex-direction: column;
  gap: var(--space-1-5);
  min-width: 0;
  padding-top: var(--space-3);
  border-top: 1px solid var(--border-l1);
}

.tools-head {
  display: flex;
  align-items: center;
  gap: var(--space-1-5);
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  font-weight: 500;
  color: rgb(var(--label-secondary));
}

.tools-count {
  font-family: var(--font-mono);
  font-weight: 400;
  color: rgb(var(--label-tertiary));
}

.tool-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  margin: 0;
  padding: 0;
  list-style: none;
}

.tool {
  display: flex;
  flex-direction: column;
  gap: var(--space-0-5);
  min-width: 0;
  padding: var(--space-1-5) var(--space-2-5);
  border-radius: var(--radius-row);
  background: rgb(var(--selector-fill));
}

.tool-name {
  font-family: var(--font-mono);
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  color: rgb(var(--label-primary));
  overflow-wrap: anywhere;
}

.tool-description {
  display: -webkit-box;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  color: rgb(var(--label-tertiary));
  overflow-wrap: anywhere;
}

.tools-empty {
  margin: 0;
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  color: rgb(var(--label-tertiary));
}
</style>
