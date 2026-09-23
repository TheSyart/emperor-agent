<script setup lang="ts">
/**
 * McpAddDialog — 能力 › MCP 「添加」 (and the 探索 page's MCP entries): a
 * ui/Modal with two Tabs.
 * - 粘贴 JSON: paste any client's MCP config (Claude / Cursor `mcpServers`,
 *   VS Code `servers`, a single server, JSONC or a `"name": {…}` fragment).
 * - 表单: name + transport + URL / command, built into the same raw shape.
 * Both run the debounced dry-run (useMcpImportPreview) and show what will be
 * added / overwritten / skipped; 「导入」 performs the real import with the
 * chosen overwrite names, emits `imported(result)` and closes.
 *
 * Opened with `initialText` (a catalog entry's config) the paste tab starts
 * with it, so its dry-run preview shows before anything is written.
 *
 * Props: initialText? (JSON text for the paste tab).
 * v-model:open. Emits: imported(McpImportResult).
 */
import { computed, ref, watch } from 'vue'
import Button from '../../ui/Button.vue'
import Modal from '../../ui/Modal.vue'
import Tabs from '../../ui/Tabs.vue'
import type { TabItem } from '../../ui/blockTypes'
import type { McpImportResult } from '../../../api/mcp'
import { CodeEditor, Field } from '../ui'
import McpImportPreview from './McpImportPreview.vue'
import McpServerForm from './McpServerForm.vue'
import {
  buildMcpServerRaw,
  emptyMcpServerForm,
  type McpServerFormState,
} from './mcpModel'
import { useMcpImportPreview } from './useMcpImportPreview'

const props = withDefaults(defineProps<{ initialText?: string }>(), {
  initialText: '',
})
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ imported: [result: McpImportResult] }>()

const PASTE_PLACEHOLDER = `{
  "mcpServers": {
    "aihot": {
      "type": "http",
      "url": "https://aihot.news/api/mcp"
    }
  }
}`

const tabs: TabItem[] = [
  { id: 'paste', label: '粘贴 JSON' },
  { id: 'form', label: '表单' },
]

const tab = ref('paste')
const text = ref('')
const form = ref<McpServerFormState>(emptyMcpServerForm())
const formRaw = computed(() => buildMcpServerRaw(form.value))
const submitError = ref('')

const preview = useMcpImportPreview(() => {
  if (!open.value) return null
  if (tab.value === 'paste') return text.value.trim() ? text.value : null
  return formRaw.value
})
const { rows, warnings, error, pending, importing, importable, canImport } =
  preview

watch(open, (value) => {
  if (value) reset()
})

function reset() {
  tab.value = 'paste'
  text.value = props.initialText
  form.value = emptyMcpServerForm()
  submitError.value = ''
  preview.reset()
}

const idleHint = computed(() => {
  if (tab.value === 'paste')
    return '粘贴后会自动识别格式，并预览将要新增或覆盖的服务器。'
  return form.value.transport === 'stdio'
    ? '填写名称和启动命令后显示预览。'
    : '填写名称和服务地址后显示预览。'
})

const importLabel = computed(() =>
  importable.value > 1 ? `导入 ${importable.value} 个` : '导入',
)

async function submit() {
  if (!canImport.value) return
  submitError.value = ''
  try {
    const result = await preview.commit()
    emit('imported', result)
    open.value = false
  } catch (cause) {
    submitError.value =
      cause instanceof Error && cause.message ? cause.message : String(cause)
  }
}
</script>

<template>
  <Modal
    v-model:open="open"
    title="添加 MCP 服务器"
    :width="560"
    :close-on-mask="false"
  >
    <div class="mcp-add-dialog">
      <Tabs v-model="tab" :tabs="tabs" />

      <Field
        v-if="tab === 'paste'"
        label="配置 JSON"
        hint="支持 Claude / Cursor 的 mcpServers、VS Code 的 servers、单个 server 或 “名称”: {…} 片段，可带注释。"
      >
        <CodeEditor
          v-model="text"
          language="json"
          wrap
          :min-lines="8"
          :max-lines="14"
          :placeholder="PASTE_PLACEHOLDER"
          @save="submit"
        />
      </Field>
      <McpServerForm v-else v-model="form" />

      <section class="preview" aria-label="导入预览">
        <McpImportPreview
          :rows="rows"
          :warnings="warnings"
          :error="error"
          :pending="pending"
          :idle-hint="idleHint"
          @overwrite="preview.setOverwrite"
        />
      </section>
      <p v-if="submitError" class="submit-error" role="alert">
        {{ submitError }}
      </p>
    </div>

    <template #footer>
      <Button variant="outline" @click="open = false">取消</Button>
      <Button
        variant="primary"
        data-testid="mcp-import-submit"
        :disabled="!canImport"
        @click="submit"
      >
        {{ importing ? '正在导入…' : importLabel }}
      </Button>
    </template>
  </Modal>
</template>

<style scoped>
.mcp-add-dialog {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  min-width: 0;
  padding-bottom: var(--space-0-5);
}

.mcp-add-dialog > :first-child {
  margin-top: calc(var(--space-3) * -1);
  border-bottom: 1px solid var(--border-l2);
}

.preview {
  min-width: 0;
  padding-top: var(--space-3);
  border-top: 1px solid var(--border-l1);
}

.submit-error {
  margin: 0;
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  color: rgb(var(--state-error-label));
  overflow-wrap: anywhere;
}
</style>
