<script setup lang="ts">
/**
 * McpServerForm — the 「表单」 tab of the add dialog: 名称, transport
 * (HTTP / SSE / stdio Segmented), then URL + optional request headers for
 * remote servers or command + args + optional environment variables for
 * stdio. A field's error shows once it was left (blur); until the form is
 * valid the dialog shows no preview and keeps 「导入」 disabled. The dialog
 * turns the state into raw import JSON with buildMcpServerRaw.
 *
 * Props: modelValue (v-model) — McpServerFormState.
 */
import { computed, reactive } from 'vue'
import { Field, Segmented, TextField, type SegmentedOption } from '../ui'
import McpKeyValueRows from './McpKeyValueRows.vue'
import {
  validateMcpServerForm,
  type McpServerFormErrors,
  type McpServerFormState,
  type McpTransportKind,
} from './mcpModel'

const form = defineModel<McpServerFormState>({ required: true })

const transports: SegmentedOption<McpTransportKind>[] = [
  { value: 'http', label: 'HTTP' },
  { value: 'sse', label: 'SSE' },
  { value: 'stdio', label: 'stdio' },
]

const TRANSPORT_HINTS: Record<McpTransportKind, string> = {
  http: 'Streamable HTTP；连接失败时自动回退到 SSE。',
  sse: '旧版 SSE 端点（URL 通常以 /sse 结尾）。',
  stdio: '在本机启动一个进程，通过标准输入输出通信。',
}

const touched = reactive<Record<keyof McpServerFormErrors, boolean>>({
  name: false,
  url: false,
  command: false,
})

const errors = computed(() => validateMcpServerForm(form.value))

function errorOf(field: keyof McpServerFormErrors) {
  return touched[field] ? errors.value[field] : undefined
}

function patch(next: Partial<McpServerFormState>) {
  form.value = { ...form.value, ...next }
}

const remote = computed(() => form.value.transport !== 'stdio')
</script>

<template>
  <div class="mcp-server-form">
    <Field
      label="名称"
      required
      hint="Agent 看到的工具名为 mcp_<名称>_<工具>"
      :error="errorOf('name')"
    >
      <TextField
        :model-value="form.name"
        monospace
        placeholder="aihot"
        autocomplete="off"
        @update:model-value="(value: string) => patch({ name: value })"
        @blur="touched.name = true"
      />
    </Field>
    <div class="transport">
      <span class="label">传输方式</span>
      <Segmented
        :model-value="form.transport"
        :options="transports"
        aria-label="传输方式"
        @update:model-value="
          (value: McpTransportKind | undefined) =>
            patch({ transport: value ?? 'http' })
        "
      />
      <p class="hint">{{ TRANSPORT_HINTS[form.transport] }}</p>
    </div>

    <template v-if="remote">
      <Field label="服务地址" required :error="errorOf('url')">
        <TextField
          :model-value="form.url"
          type="url"
          monospace
          placeholder="https://example.com/mcp"
          autocomplete="off"
          @update:model-value="(value: string) => patch({ url: value })"
          @blur="touched.url = true"
        />
      </Field>
      <div class="pairs">
        <span class="label">请求头 <em>可选</em></span>
        <McpKeyValueRows
          :model-value="form.headers"
          name="请求头"
          key-placeholder="Authorization"
          value-placeholder="Bearer …"
          @update:model-value="(rows) => patch({ headers: rows })"
        />
      </div>
    </template>

    <template v-else>
      <Field label="启动命令" required :error="errorOf('command')">
        <TextField
          :model-value="form.command"
          monospace
          placeholder="npx"
          autocomplete="off"
          @update:model-value="(value: string) => patch({ command: value })"
          @blur="touched.command = true"
        />
      </Field>
      <Field label="参数" hint="用空格分隔；包含空格的参数请加引号。">
        <TextField
          :model-value="form.args"
          monospace
          placeholder="-y @modelcontextprotocol/server-everything"
          autocomplete="off"
          @update:model-value="(value: string) => patch({ args: value })"
        />
      </Field>
      <div class="pairs">
        <span class="label">环境变量 <em>可选</em></span>
        <McpKeyValueRows
          :model-value="form.env"
          name="环境变量"
          key-placeholder="API_KEY"
          value-placeholder="value 或 ${ENV_NAME}"
          @update:model-value="(rows) => patch({ env: rows })"
        />
      </div>
    </template>
  </div>
</template>

<style scoped>
.mcp-server-form {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  min-width: 0;
}

.transport,
.pairs {
  display: flex;
  flex-direction: column;
  gap: var(--space-1-5);
  min-width: 0;
}

.label {
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  font-weight: 500;
  color: rgb(var(--label-primary));
}

.label em {
  margin-left: var(--space-1-5);
  font-size: var(--fs-xxs);
  font-style: normal;
  font-weight: 400;
  color: rgb(var(--label-tertiary));
}

.transport > .ds-segmented {
  align-self: flex-start;
}

.hint {
  margin: 0;
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  color: rgb(var(--label-tertiary));
}
</style>
