<script setup lang="ts">
/**
 * Settings › 诊断 — the CoreApi runtime report as grouped rows: 服务, 路径
 * (the global data root and the bound project open in the file manager),
 * 环境工具 (environment probe), 配置 and 上下文. Every row keeps its text on
 * the left (paths wrap) and a state-colored StatusBadge on the right. The
 * one header refresh re-reads diagnostics + the context explanation and
 * re-detects the environment (forceRefresh).
 */
import { computed, onMounted, ref } from 'vue'
import IconButton from '../ui/IconButton.vue'
import { DsFolderOpen, DsWarning } from '../icons/ds'
import { SettingsGroup, SettingsRow, SettingsSection, StatusBadge } from './ui'
import { refreshAction, useSettingsHeader } from './settingsHeader'
import { core } from '../../api/http'
import { openPath } from '../../api/backend'
import { useAppContext } from '../../composables/useAppContext'
import type { DiagnosticsPayload } from '../../types'
import EnvironmentToolsGroup from './diagnostics/EnvironmentToolsGroup.vue'
import {
  OPENABLE_DIAGNOSTIC_PATHS,
  diagnosticSettingsGroups,
  type DiagnosticGroup,
  type DiagnosticRow,
  type DiagnosticTone,
} from './diagnostics/diagnosticsModel'
import type { EnvironmentStatusPayload } from './diagnostics/environmentModel'

const ctx = useAppContext()
const diagnostics = ref<DiagnosticsPayload | null>(
  ctx.boot.value?.diagnostics || null,
)
const loading = ref(false)
const error = ref('')
const environment = ref<EnvironmentStatusPayload | null>(null)
const environmentLoading = ref(false)
const environmentError = ref('')

const current = computed(
  () => diagnostics.value || ctx.boot.value?.diagnostics || null,
)
/** Row groups with the environment probe slotted in after 路径. */
const blocks = computed<Array<DiagnosticGroup | { id: 'environment' }>>(() => {
  const groups = diagnosticSettingsGroups(current.value)
  const at = groups.findIndex(
    (group) => !['services', 'paths'].includes(group.id),
  )
  const split = at < 0 ? groups.length : at
  return [
    ...groups.slice(0, split),
    { id: 'environment' },
    ...groups.slice(split),
  ]
})
const rootPath = computed(() => current.value?.root || '')

useSettingsHeader({
  actions: () => [
    refreshAction(() => refresh(), {
      label: '刷新诊断',
      title: '刷新诊断并重新检测环境',
      busy: loading.value || environmentLoading.value,
    }),
  ],
})

onMounted(() => void refresh())

async function refresh() {
  await Promise.all([refreshDiagnostics(), refreshEnvironment()])
}

async function refreshDiagnostics() {
  if (loading.value) return
  loading.value = true
  error.value = ''
  try {
    const next = await core('diagnostics.get')
    let contextExplanation
    try {
      contextExplanation = await core('memory.explainContext')
    } catch {
      // Diagnostics still has value when no prompt snapshot exists yet.
    }
    diagnostics.value = {
      ...next,
      ...(contextExplanation ? { contextExplanation } : {}),
    }
  } catch (cause) {
    error.value = messageOf(cause)
  } finally {
    loading.value = false
  }
}

async function refreshEnvironment() {
  if (environmentLoading.value) return
  environmentLoading.value = true
  environmentError.value = ''
  try {
    environment.value = await core('environment.getStatus', {
      forceRefresh: true,
    })
  } catch (cause) {
    environmentError.value = messageOf(cause)
  } finally {
    environmentLoading.value = false
  }
}

async function reveal(target: string) {
  if (!target) return
  error.value = ''
  try {
    await openPath(target)
  } catch (cause) {
    error.value = messageOf(cause)
  }
}

function badgeTone(tone: DiagnosticTone) {
  return tone === 'muted' ? 'neutral' : tone
}

function openable(row: DiagnosticRow) {
  return Boolean(row.path) && OPENABLE_DIAGNOSTIC_PATHS.has(row.id)
}

/** Path rows show the path itself (plus the explanation when it differs). */
function showPath(row: DiagnosticRow, groupId: string) {
  return groupId === 'paths' && Boolean(row.path)
}

function messageOf(cause: unknown): string {
  const value = cause as { message?: unknown }
  return typeof value?.message === 'string' ? value.message : String(cause)
}
</script>

<template>
  <SettingsSection>
    <template v-if="rootPath" #intro>
      当前 CoreApi 运行环境 · <code class="intro-path">{{ rootPath }}</code>
    </template>

    <div v-if="error" class="diag-alert" role="alert">
      <DsWarning :size="16" class="alert-glyph" />
      <span><strong>诊断请求失败</strong> {{ error }}</span>
    </div>

    <template v-for="block in blocks" :key="block.id">
      <EnvironmentToolsGroup
        v-if="!('rows' in block)"
        :status="environment"
        :loading="environmentLoading"
        :error="environmentError"
      />
      <SettingsGroup
        v-else
        :title="block.title"
        :description="`${block.rows.length} 项`"
        :data-group="block.id"
      >
        <SettingsRow
          v-for="row in block.rows"
          :key="row.id"
          dense
          :title="row.label"
          :data-row="row.id"
        >
          <template #description>
            <template v-if="showPath(row, block.id)">
              <code class="path" :title="row.path">{{ row.path }}</code>
              <span v-if="row.detail !== row.path" class="detail">
                {{ row.detail }}
              </span>
            </template>
            <span v-else class="detail clamp" :title="row.detail">
              {{ row.detail }}
            </span>
          </template>
          <StatusBadge
            :tone="badgeTone(row.tone)"
            dot
            class="value"
            :title="row.value"
          >
            {{ row.value }}
          </StatusBadge>
          <IconButton
            v-if="openable(row)"
            :label="`打开${row.label}`"
            @click="reveal(row.path || '')"
          >
            <DsFolderOpen :size="16" />
          </IconButton>
        </SettingsRow>
      </SettingsGroup>
    </template>
  </SettingsSection>
</template>

<style scoped>
.intro-path {
  font: var(--font-code-small);
  overflow-wrap: anywhere;
}

.diag-alert {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  margin-top: var(--space-2);
  padding: var(--space-2-5) var(--space-3);
  border-radius: var(--radius-row);
  background: rgb(var(--state-error-soft));
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  color: rgb(var(--state-error-label));
  overflow-wrap: anywhere;
}

.alert-glyph {
  flex: none;
  margin-top: var(--space-0-5);
}

.path {
  display: block;
  font: var(--font-code-small);
  color: rgb(var(--label-secondary));
  overflow-wrap: anywhere;
}

.detail {
  display: block;
}

/* Long traces (effective config, context plan) stay 3 lines; the full text
   is the tooltip. */
.clamp {
  display: -webkit-box;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
}

/* Right-aligned value badge: never wider than the control column. */
.value {
  max-width: 200px;
}
</style>
