<script setup lang="ts">
/**
 * McpKeyValueRows — editable key / value pairs for the 表单 tab (HTTP
 * request headers, stdio environment variables): one row per pair with two
 * compact TextFields and a remove button, plus an 「添加」 ghost button.
 *
 * Props:
 * - modelValue (v-model): McpKeyValueRow[].
 * - name: what one pair is (「请求头」 / 「环境变量」), used in labels.
 * - keyPlaceholder?, valuePlaceholder?.
 */
import Button from '../../ui/Button.vue'
import IconButton from '../../ui/IconButton.vue'
import { DsClose, DsPlus } from '../../icons/ds'
import { TextField } from '../ui'
import type { McpKeyValueRow } from './mcpModel'

withDefaults(
  defineProps<{
    name: string
    keyPlaceholder?: string
    valuePlaceholder?: string
  }>(),
  { keyPlaceholder: 'KEY', valuePlaceholder: 'value' },
)

const rows = defineModel<McpKeyValueRow[]>({ default: () => [] })
let nextId = 0

function add() {
  nextId = Math.max(nextId, ...rows.value.map((row) => row.id)) + 1
  rows.value = [...rows.value, { id: nextId, key: '', value: '' }]
}

function update(id: number, patch: Partial<Omit<McpKeyValueRow, 'id'>>) {
  rows.value = rows.value.map((row) =>
    row.id === id ? { ...row, ...patch } : row,
  )
}

function remove(id: number) {
  rows.value = rows.value.filter((row) => row.id !== id)
}
</script>

<template>
  <div class="mcp-key-value-rows">
    <div v-for="(row, index) in rows" :key="row.id" class="pair">
      <TextField
        size="sm"
        monospace
        :model-value="row.key"
        :placeholder="keyPlaceholder"
        :aria-label="`${name} ${index + 1} 名称`"
        @update:model-value="(value: string) => update(row.id, { key: value })"
      />
      <TextField
        size="sm"
        monospace
        :model-value="row.value"
        :placeholder="valuePlaceholder"
        :aria-label="`${name} ${index + 1} 值`"
        @update:model-value="
          (value: string) => update(row.id, { value: value })
        "
      />
      <IconButton :label="`移除${name} ${index + 1}`" @click="remove(row.id)">
        <DsClose :size="14" />
      </IconButton>
    </div>
    <div class="add">
      <Button size="sm" variant="ghost" @click="add">
        <template #icon><DsPlus :size="14" /></template>
        添加{{ name }}
      </Button>
    </div>
  </div>
</template>

<style scoped>
.mcp-key-value-rows {
  display: flex;
  flex-direction: column;
  gap: var(--space-1-5);
  min-width: 0;
}

.pair {
  display: grid;
  grid-template-columns: minmax(0, 2fr) minmax(0, 3fr) auto;
  align-items: center;
  gap: var(--space-1-5);
  min-width: 0;
}

.add {
  display: flex;
  margin-left: calc(var(--space-2-5) * -1);
}
</style>
