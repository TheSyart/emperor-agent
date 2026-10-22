<script setup lang="ts">
/**
 * DiagnosticsExportDialog — 导出诊断包 (REL-01). Opening it asks main to
 * stage the bundle; the dialog lists every file of the zip (what it is,
 * how big) and what the bundle never holds, and writes nothing until
 * 导出…. Main then asks where to save it. After the export: the file name
 * and folder, 在访达中显示 and 完成. Closing a bundle that was not exported
 * tells main to throw it away.
 *
 * Props: open (v-model).
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import {
  discardDiagnosticsBundle,
  exportDiagnosticsBundle,
  prepareDiagnosticsBundle,
  revealDiagnosticsBundle,
  type DiagnosticsBundleView,
} from '../../../api/diagnosticsBundle'
import Button from '../../ui/Button.vue'
import Modal from '../../ui/Modal.vue'
import Spinner from '../../ui/Spinner.vue'
import { formatStorageBytes } from '../storage/storageModel'

const open = defineModel<boolean>('open', { default: false })

const bundle = ref<DiagnosticsBundleView | null>(null)
const preparing = ref(false)
const exporting = ref(false)
const error = ref('')
const done = ref<{ name: string; location: string } | null>(null)
let closed = false

const total = computed(() =>
  formatStorageBytes(
    (bundle.value?.entries ?? []).reduce((sum, entry) => sum + entry.bytes, 0),
  ),
)

async function prepare(): Promise<void> {
  preparing.value = true
  error.value = ''
  bundle.value = null
  done.value = null
  try {
    const staged = await prepareDiagnosticsBundle()
    bundle.value = staged
    if (closed) release()
  } catch (cause) {
    error.value = messageOf(cause)
  } finally {
    preparing.value = false
  }
}

async function exportBundle(): Promise<void> {
  if (!bundle.value || exporting.value) return
  exporting.value = true
  error.value = ''
  try {
    const result = await exportDiagnosticsBundle(bundle.value.id)
    if (result.ok) done.value = { name: result.name, location: result.location }
  } catch (cause) {
    error.value = messageOf(cause)
  } finally {
    exporting.value = false
  }
}

async function reveal(): Promise<void> {
  if (!bundle.value) return
  error.value = ''
  try {
    await revealDiagnosticsBundle(bundle.value.id)
  } catch (cause) {
    error.value = messageOf(cause)
  }
}

/** A staged bundle that was not exported is thrown away in main. */
function release(): void {
  const staged = bundle.value
  if (!staged || done.value) return
  bundle.value = null
  void discardDiagnosticsBundle(staged.id)
}

function close(): void {
  closed = true
  release()
  open.value = false
}

watch(
  open,
  (value, before) => {
    if (value) {
      closed = false
      void prepare()
    } else if (before) close()
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  closed = true
  release()
})

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
</script>

<template>
  <Modal v-model:open="open" title="导出诊断包" :width="520">
    <div class="export-dialog" data-testid="diagnostics-export-dialog">
      <template v-if="done">
        <p class="result" role="status">
          <span
            >已导出 <strong>{{ done.name }}</strong></span
          >
          <span class="where">保存在 {{ done.location }}</span>
        </p>
        <p class="lead">反馈问题时附上这个文件即可；它只在你的电脑上。</p>
      </template>
      <template v-else>
        <p class="lead">
          诊断包是一个 zip 文件，只保存在你选择的位置，Emperor
          不会上传。确认下面的内容后再导出。
        </p>
        <div v-if="preparing" class="loading">
          <Spinner size="sm" /> 正在整理诊断包…
        </div>
        <template v-else-if="bundle">
          <ul class="entries" aria-label="诊断包内容">
            <li
              v-for="entry in bundle.entries"
              :key="entry.path"
              class="entry"
              :data-entry="entry.path"
            >
              <span class="path">{{ entry.path }}</span>
              <span class="title">{{ entry.title }}</span>
              <span class="size">{{ formatStorageBytes(entry.bytes) }}</span>
            </li>
          </ul>
          <p class="summary">
            共 {{ bundle.entries.length }} 个文件，约 {{ total }}（压缩前）
          </p>
          <p class="excluded" data-testid="bundle-excluded">
            <span class="excluded-label">不包含</span>
            {{ bundle.excluded.join('、') }}
          </p>
        </template>
      </template>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <div class="actions">
        <template v-if="done">
          <Button variant="secondary" data-action="reveal" @click="reveal"
            >在访达中显示</Button
          >
          <Button variant="primary" data-action="done" @click="close"
            >完成</Button
          >
        </template>
        <template v-else>
          <Button variant="secondary" data-action="cancel" @click="close"
            >取消</Button
          >
          <Button
            variant="primary"
            data-action="export"
            :disabled="!bundle || preparing"
            :loading="exporting"
            @click="exportBundle"
            >导出…</Button
          >
        </template>
      </div>
    </div>
  </Modal>
</template>

<style scoped>
.export-dialog {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  min-width: 0;
}

.lead {
  margin: 0;
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  color: rgb(var(--text-2));
}

.loading {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--fs-xs);
  color: rgb(var(--text-3));
}

.entries {
  display: flex;
  flex-direction: column;
  max-height: 280px;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  list-style: none;
  border-radius: var(--radius-cell);
  background: rgb(var(--surface-sunken));
  box-shadow: inset 0 0 0 0.5px var(--hairline);
}

.entry {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 0 var(--space-3);
  padding: var(--space-2) var(--space-3);
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
}

.entry + .entry {
  box-shadow: inset 0 0.5px 0 var(--hairline);
}

.path {
  min-width: 0;
  font-family: var(--font-mono);
  color: rgb(var(--text-1));
  overflow-wrap: anywhere;
}

.size {
  grid-row: 1 / span 2;
  grid-column: 2;
  align-self: center;
  color: rgb(var(--text-3));
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.title {
  grid-column: 1;
  color: rgb(var(--text-2));
  overflow-wrap: anywhere;
}

.summary,
.excluded {
  margin: 0;
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  color: rgb(var(--text-2));
}

.excluded-label {
  margin-right: var(--space-1);
  font-weight: var(--weight-medium);
  color: rgb(var(--text-1));
}

.result {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  margin: 0;
  font-size: var(--fs-s);
  line-height: var(--lh-s);
  color: rgb(var(--text-1));
  overflow-wrap: anywhere;
}

.result strong {
  font-weight: var(--weight-medium);
}

.where {
  font-size: var(--fs-xs);
  color: rgb(var(--text-2));
}

.error {
  margin: 0;
  font-size: var(--fs-xs);
  color: rgb(var(--state-error-label));
  overflow-wrap: anywhere;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: var(--space-2);
}
</style>
