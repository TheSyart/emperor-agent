<script setup lang="ts">
/**
 * McpServerCard — one MCP server in 能力 › MCP (dsh McpSettingsTab card
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
import EmptyState from '../../ui/EmptyState.vue'
import { computed } from 'vue'
import Button from '../../ui/Button.vue'
import Dot from '../../ui/Dot.vue'
import { DsTrash } from '../../icons/ds'
import { DefinitionList, SettingsCard, Badge, Switch } from '../ui'
import {
  mcpEmptyToolsText,
  mcpServerFacts,
  mcpServerSummary,
  mcpTransportLabel,
  type McpServerView,
  mcpStateDot,
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
      <Dot
        class="state-dot"
        :data-state="server.state"
        :state="mcpStateDot(server.state)"
        :label="server.stateLabel"
      />
    </template>
    <template #meta>
      <Badge mono>{{ mcpTransportLabel(server.transport) }}</Badge>
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
        <Badge variant="count" :label="server.tools.length" />
      </div>
      <ul v-if="server.tools.length" class="tool-list">
        <li v-for="tool in server.tools" :key="tool.name" class="tool">
          <code class="tool-name">{{ tool.name }}</code>
          <span v-if="tool.description" class="tool-description">
            {{ tool.description }}
          </span>
        </li>
      </ul>
      <EmptyState v-else variant="inline" :title="mcpEmptyToolsText(server)" />
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
.state-dot::before,
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
</style>
