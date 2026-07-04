<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import {
  AlertCircle,
  CheckCircle2,
  CircleDashed,
  RefreshCcw,
  TriangleAlert,
} from 'lucide-vue-next'
import { core } from '../../api/http'
import { useAppContext } from '../../composables/useAppContext'
import type { DiagnosticsPayload } from '../../types'
import {
  diagnosticRows,
  type DiagnosticTone,
} from './diagnosticsPanelModel'

const ctx = useAppContext()
const diagnostics = ref<DiagnosticsPayload | null>(ctx.boot.value?.diagnostics || null)
const loading = ref(false)
const error = ref('')

const groups = computed(() => diagnosticRows(diagnostics.value || ctx.boot.value?.diagnostics || null))
const rootPath = computed(() => diagnostics.value?.root || ctx.boot.value?.diagnostics?.root || '')

onMounted(() => {
  void refresh()
})

async function refresh() {
  if (loading.value) return
  loading.value = true
  error.value = ''
  try {
    diagnostics.value = await core<DiagnosticsPayload>('diagnostics.get')
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
</script>

<template>
  <section class="main-view view-readable settings-simple-view diagnostics-view">
    <header class="view-head">
      <div class="min-w-0">
        <h1>诊断</h1>
        <p>{{ rootPath || '当前 CoreApi 运行环境' }}</p>
      </div>
      <button class="tool-button asset-button refresh-action" :disabled="loading" title="刷新" @click="refresh">
        <RefreshCcw class="action-icon" :size="16" />
        <span>{{ loading ? '刷新中' : '刷新' }}</span>
      </button>
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

        <section v-for="group in groups" :key="group.id" class="diagnostics-group">
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
