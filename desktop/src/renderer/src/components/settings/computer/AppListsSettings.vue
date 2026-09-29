<script setup lang="ts">
/**
 * AppListsSettings — the user's own app lists (spec 01 §4.4, §5.2), added
 * to the built-in ones:
 * - 保护：the Agent never sees or controls these apps (password managers,
 *   banking clients…);
 * - 高风险：every input is confirmed in scoped mode (terminals, script tools);
 * - 敏感：structure only — no field values, no screenshots.
 *
 * Props: lists (current), busy. Emits: change(kind, next list).
 */
import { ref } from 'vue'
import Button from '../../ui/Button.vue'
import { SettingsGroup, SettingsRow, TextField } from '../ui'

type ListKind = 'protected' | 'highRisk' | 'sensitive'

const props = defineProps<{
  lists: Readonly<Record<ListKind, readonly string[]>>
  busy: boolean
}>()
const emit = defineEmits<{ change: [kind: ListKind, next: string[]] }>()

const ROWS: ReadonlyArray<{
  kind: ListKind
  title: string
  description: string
}> = [
  {
    kind: 'protected',
    title: '保护的应用',
    description:
      'Agent 看不到也不能操作这些应用，例如密码管理器、网银客户端。系统授权界面与 Emperor 自身已内置保护。',
  },
  {
    kind: 'highRisk',
    title: '高风险应用',
    description:
      '逐项授权时，每次输入都要单独确认。终端与脚本类应用已内置在名单中。',
  },
  {
    kind: 'sensitive',
    title: '敏感应用',
    description: '只获取界面结构，不读取输入框内容，也不截图。',
  },
]

const APP_IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/
const drafts = ref<Record<ListKind, string>>({
  protected: '',
  highRisk: '',
  sensitive: '',
})
const errors = ref<Record<ListKind, string>>({
  protected: '',
  highRisk: '',
  sensitive: '',
})

function add(kind: ListKind): void {
  const id = drafts.value[kind].trim()
  errors.value[kind] = ''
  if (!APP_IDENTITY.test(id)) {
    errors.value[kind] = '请输入应用的 bundle ID，例如 com.example.App'
    return
  }
  if (props.lists[kind].includes(id)) {
    drafts.value[kind] = ''
    return
  }
  emit('change', kind, [...props.lists[kind], id])
  drafts.value[kind] = ''
}

function remove(kind: ListKind, id: string): void {
  emit(
    'change',
    kind,
    props.lists[kind].filter((item) => item !== id),
  )
}
</script>

<template>
  <SettingsGroup
    title="应用名单"
    description="在内置名单之外，追加你自己的应用。按 bundle ID 识别（可在“关于本机 › 系统报告”或应用的 Info.plist 中找到）。"
  >
    <SettingsRow
      v-for="row in ROWS"
      :key="row.kind"
      :title="row.title"
      :data-app-list="row.kind"
    >
      <template #description>
        <span>{{ row.description }}</span>
        <span
          v-if="lists[row.kind].length"
          class="app-chips"
          role="list"
          :aria-label="row.title"
        >
          <span
            v-for="id in lists[row.kind]"
            :key="id"
            class="app-chip"
            role="listitem"
          >
            {{ id }}
            <button
              type="button"
              class="app-chip-remove"
              :disabled="busy"
              :aria-label="`从${row.title}中移除 ${id}`"
              @click="remove(row.kind, id)"
            >
              ×
            </button>
          </span>
        </span>
        <span v-if="errors[row.kind]" class="app-error" role="alert">{{
          errors[row.kind]
        }}</span>
      </template>
      <form class="app-add" @submit.prevent="add(row.kind)">
        <TextField
          v-model="drafts[row.kind]"
          class="app-input"
          size="sm"
          monospace
          :invalid="errors[row.kind] !== ''"
          :aria-label="`添加到${row.title}`"
          placeholder="com.example.App"
          spellcheck="false"
          autocomplete="off"
        />
        <Button
          size="sm"
          variant="outline"
          type="submit"
          :disabled="busy || drafts[row.kind].trim() === ''"
          >添加</Button
        >
      </form>
    </SettingsRow>
  </SettingsGroup>
</template>

<style scoped>
.app-chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
  margin-top: var(--space-1);
}

.app-chip {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  padding: 0 var(--space-1-5);
  border: 1px solid var(--border-l2);
  border-radius: var(--radius-row);
  color: rgb(var(--label-secondary));
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
}

.app-chip-remove {
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
}

.app-chip-remove:hover:not(:disabled) {
  color: rgb(var(--danger));
}

.app-error {
  display: block;
  margin-top: var(--space-0-5);
  color: rgb(var(--danger));
}

.app-add {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
}

.app-input {
  width: calc(var(--space-4) * 11);
}
</style>
