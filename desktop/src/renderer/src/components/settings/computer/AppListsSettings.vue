<script setup lang="ts">
/**
 * AppListsSettings — the user's own app lists (spec 01 §4.4, §5.2), added
 * to the built-in ones:
 * - 保护 (不让 Emperor 操作的应用): the Agent never sees or controls these
 *   apps (password managers, banking clients…);
 * - 高风险: apps that run commands (terminals, script tools): marked on the
 *   confirmation card; their ordinary input runs like any other;
 * - 敏感 (不截图的应用): structure only — no field values, no screenshots.
 * Each list shows its apps as chips (× removes one); 添加 asks for a bundle
 * ID in a dialog (AppIdDialog).
 *
 * Props: lists (current), busy, kinds (which lists to show, in order).
 * Emits: change(kind, next list).
 */
import { computed, ref } from 'vue'
import Button from '../../ui/Button.vue'
import { SettingsGroup, SettingsRow } from '../ui'
import AppIdDialog from './AppIdDialog.vue'

type ListKind = 'protected' | 'highRisk' | 'sensitive'

const props = withDefaults(
  defineProps<{
    lists: Readonly<Record<ListKind, readonly string[]>>
    busy: boolean
    kinds?: readonly ListKind[]
  }>(),
  { kinds: () => ['protected', 'highRisk', 'sensitive'] },
)
const emit = defineEmits<{ change: [kind: ListKind, next: string[]] }>()

const ROWS: Readonly<Record<ListKind, { title: string; description: string }>> =
  {
    protected: {
      title: '不让 Emperor 操作的应用',
      description:
        'Emperor 看不到也不能操作这些应用，例如密码管理器、网银客户端。系统授权界面与 Emperor 自身已内置保护。',
    },
    highRisk: {
      title: '高风险应用',
      description:
        '能执行命令的应用，例如终端：确认卡上会特别提示，普通输入照常自动进行。终端与脚本类应用已内置在名单中。',
    },
    sensitive: {
      title: '不截图的应用',
      description: '只读取界面结构，不读取输入框内容，也不截图。',
    },
  }

const rows = computed(() =>
  props.kinds.map((kind) => ({ kind, ...ROWS[kind] })),
)
const adding = ref<ListKind | null>(null)
const dialogOpen = computed({
  get: () => adding.value !== null,
  set: (value: boolean) => {
    if (!value) adding.value = null
  },
})

function add(id: string): void {
  const kind = adding.value
  if (!kind || props.lists[kind].includes(id)) return
  emit('change', kind, [...props.lists[kind], id])
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
    description="在内置名单之外追加你自己的应用，按 bundle ID 识别。"
  >
    <SettingsRow
      v-for="row in rows"
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
      </template>
      <Button
        size="sm"
        variant="outline"
        :disabled="busy"
        :aria-label="`添加到${row.title}`"
        @click="adding = row.kind"
        >添加</Button
      >
    </SettingsRow>
  </SettingsGroup>
  <AppIdDialog
    v-model:open="dialogOpen"
    :title="adding ? `添加到${ROWS[adding].title}` : ''"
    :busy="busy"
    @save="add"
  />
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
</style>
