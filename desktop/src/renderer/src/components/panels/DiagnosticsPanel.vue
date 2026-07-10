<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import {
  AlertCircle,
  CheckCircle2,
  CircleDashed,
  FolderOpen,
  RefreshCcw,
  TriangleAlert,
} from 'lucide-vue-next'
import { core } from '../../api/http'
import { openPath } from '../../api/backend'
import { useAppContext } from '../../composables/useAppContext'
import type { DiagnosticsPayload } from '../../types'
import { diagnosticRows, type DiagnosticTone } from './diagnosticsPanelModel'

const ctx = useAppContext()
const diagnostics = ref<DiagnosticsPayload | null>(
  ctx.boot.value?.diagnostics || null,
)
const loading = ref(false)
const error = ref('')

const groups = computed(() =>
  diagnosticRows(diagnostics.value || ctx.boot.value?.diagnostics || null),
)
const rootPath = computed(
  () => diagnostics.value?.root || ctx.boot.value?.diagnostics?.root || '',
)
const dataRootPath = computed(
  () =>
    diagnostics.value?.paths?.stateRoot ||
    ctx.boot.value?.diagnostics?.paths?.stateRoot ||
    '',
)
const activeProjectPath = computed(() => {
  const current = diagnostics.value || ctx.boot.value?.diagnostics || null
  const workspaceRoot = current?.workspacePolicy?.workspaceRoot || ''
  if (!workspaceRoot || workspaceRoot === current?.paths?.runtimeRoot) return ''
  return workspaceRoot
})

onMounted(() => {
  void refresh()
})

async function refresh() {
  if (loading.value) return
  loading.value = true
  error.value = ''
  try {
    const nextDiagnostics = await core('diagnostics.get')
    let contextExplanation
    try {
      contextExplanation = await core('memory.explainContext')
    } catch {
      // Diagnostics still has value even when no active prompt snapshot exists.
    }
    diagnostics.value = {
      ...nextDiagnostics,
      ...(contextExplanation ? { contextExplanation } : {}),
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    loading.value = false
  }
}

function toneIcon(tone: DiagnosticTone) {
  if (tone === 'ok') return CheckCircle2
  if (tone === 'warn') return TriangleAlert
  if (tone === 'error') return AlertCircle
  return CircleDashed
}

async function revealPath(target: string) {
  if (!target) return
  error.value = ''
  try {
    await openPath(target)
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  }
}
</script>

<template>
  <section
    class="main-view view-readable settings-simple-view diagnostics-view"
  >
    <header class="view-head">
      <div class="min-w-0">
        <h1>诊断</h1>
        <p>{{ rootPath || '当前 CoreApi 运行环境' }}</p>
      </div>
      <div class="view-head-actions">
        <button
          v-if="dataRootPath"
          class="tool-button asset-button refresh-action"
          title="打开全局数据目录"
          @click="revealPath(dataRootPath)"
        >
          <FolderOpen class="action-icon" :size="16" />
          <span>数据目录</span>
        </button>
        <button
          v-if="activeProjectPath"
          class="tool-button asset-button refresh-action"
          title="打开当前项目目录"
          @click="revealPath(activeProjectPath)"
        >
          <FolderOpen class="action-icon" :size="16" />
          <span>项目目录</span>
        </button>
        <button
          class="tool-button asset-button refresh-action"
          :disabled="loading"
          title="刷新"
          @click="refresh"
        >
          <RefreshCcw class="action-icon" :size="16" />
          <span>{{ loading ? '刷新中' : '刷新' }}</span>
        </button>
      </div>
    </header>

    <div class="view-body">
      <div class="settings-list diagnostics-list">
        <div v-if="error" class="settings-row diagnostics-row tone-error">
          <AlertCircle :size="18" />
          <div>
            <strong>诊断请求失败</strong>
            <span>{{ error }}</span>
          </div>
          <code>error</code>
        </div>

        <section
          v-for="group in groups"
          :key="group.id"
          class="diagnostics-group"
        >
          <div class="diagnostics-group-head">
            <strong>{{ group.title }}</strong>
            <span>{{ group.rows.length }} 项</span>
          </div>
          <div class="diagnostics-group-rows">
            <div
              v-for="row in group.rows"
              :key="row.id"
              class="settings-row diagnostics-row"
              :class="`tone-${row.tone}`"
              :title="row.path || row.detail"
            >
              <component :is="toneIcon(row.tone)" :size="18" />
              <div>
                <strong>{{ row.label }}</strong>
                <span>{{ row.detail }}</span>
              </div>
              <code>{{ row.value }}</code>
            </div>
          </div>
        </section>
      </div>
    </div>
  </section>
</template>
