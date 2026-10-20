<script setup lang="ts">
/**
 * McpServerCard — one MCP server in 能力 › MCP (dsh McpSettingsTab card
 * on SettingsCard): status dot, name, transport badge, state · tool count,
 * enable Switch. Expanding shows the connection facts (DefinitionList: masked
 * URL or command line, header / env keys, last error), the discovered tools,
 * a stdio server's last stderr lines on request (最近输出, `mcp.serverLog`,
 * KRN-04) and 删除.
 *
 * Props:
 * - server: McpServerView (mcpModel.buildMcpServerViews).
 * - busy?: a toggle / removal for this server is in flight.
 * - open (v-model:open): expanded state.
 * Emits: toggle(enabled) from the Switch, remove from 删除.
 */
import EmptyState from '../../ui/EmptyState.vue'
import { computed, ref } from 'vue'
import { getMcpServerLog } from '../../../api/mcp'
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

/** null until asked; '' when the server wrote nothing. */
const output = ref<string | null>(null)
const outputRunning = ref(true)
const outputLoading = ref(false)
const outputError = ref('')

async function loadOutput() {
  outputLoading.value = true
  outputError.value = ''
  try {
    const log = await getMcpServerLog(props.server.name)
    outputRunning.value = log.text !== null
    output.value = log.text ?? ''
  } catch (error) {
    outputError.value = error instanceof Error ? error.message : String(error)
  } finally {
    outputLoading.value = false
  }
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

    <div v-if="server.transport === 'stdio'" class="server-output">
      <div class="tools-head">
        <span>最近输出</span>
        <span class="output-hint">stderr · 最近 200 行</span>
        <Button
          size="sm"
          class="output-load"
          :loading="outputLoading"
          @click="loadOutput"
        >
          {{ output === null ? '查看最近输出' : '刷新输出' }}
        </Button>
      </div>
      <pre v-if="output" class="output-text">{{ output }}</pre>
      <EmptyState
        v-else-if="output !== null"
        variant="inline"
        :title="outputRunning ? '没有输出' : '没有输出（server 未在运行）'"
      />
      <p v-if="outputError" class="output-error">{{ outputError }}</p>
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

.tools,
.server-output {
  display: flex;
  flex-direction: column;
  gap: var(--space-1-5);
  min-width: 0;
  padding-top: var(--space-3);
  border-top: 1px solid var(--stroke-1);
}

.tools-head {
  display: flex;
  align-items: center;
  gap: var(--space-1-5);
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  font-weight: var(--weight-medium);
  color: rgb(var(--text-2));
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
  color: rgb(var(--text-1));
  overflow-wrap: anywhere;
}

.output-hint {
  font-weight: var(--weight-regular);
  color: rgb(var(--text-3));
}

.output-load {
  margin-left: auto;
}

.output-text {
  max-height: 240px;
  margin: 0;
  padding: var(--space-2) var(--space-2-5);
  overflow: auto;
  border-radius: var(--radius-row);
  background: rgb(var(--selector-fill));
  font-family: var(--font-mono);
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  color: rgb(var(--text-2));
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.output-error {
  margin: 0;
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  color: rgb(var(--state-error-label));
}

.tool-description {
  display: -webkit-box;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  color: rgb(var(--text-3));
  overflow-wrap: anywhere;
}
</style>
