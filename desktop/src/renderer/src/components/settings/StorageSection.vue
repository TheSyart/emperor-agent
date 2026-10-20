<script setup lang="ts">
/**
 * Settings › 高级 › 存储 (KRN-12) — 「清理」 and what Emperor Home holds.
 * - 清理 (first: the one thing to decide here): after a confirm, Core's
 *   retention sweep (`storage.clean`, the same one that runs after every
 *   start); the line under it says what it freed, and the sizes below are
 *   measured again. Conversations, attachments and settings are never part
 *   of it.
 * - 占用: the total, then one row per category Core measures
 *   (`storage.usage`: allocated bytes, the way `du` counts them).
 * Header action: 刷新 (measure again). A failed request shows one Notice.
 */
import { computed, onMounted, ref } from 'vue'
import Button from '../ui/Button.vue'
import { confirm } from '../ui/confirm'
import { core } from '../../api/http'
import { shortenHomePaths } from './diagnostics/diagnosticsModel'
import {
  STORAGE_CATEGORY_TEXT,
  cleanSummary,
  formatStorageBytes,
  type StorageUsage,
} from './storage/storageModel'
import {
  Notice,
  refreshAction,
  SettingsGroup,
  SettingsRow,
  SettingsSection,
  useSettingsHeader,
} from './ui'

const CLEAN_DESCRIPTION =
  '删除 30 天没有变化、且不属于任何会话的溢出文件，到期的「最近删除」会话，记忆版本索引之外的快照，以及会话已删除的委派留下的隔离目录和临时文件。对话、附件与设置不受影响。'

const usage = ref<StorageUsage | null>(null)
const loading = ref(false)
const cleaning = ref(false)
const failure = ref<{ title: string; detail: string } | null>(null)
const summary = ref('')

const rows = computed(() =>
  (usage.value?.categories ?? []).map((item) => ({
    id: item.id,
    ...STORAGE_CATEGORY_TEXT[item.id],
    size: formatStorageBytes(item.bytes),
  })),
)

const usageDescription = computed(() =>
  usage.value
    ? `Emperor Home（${shortenHomePaths(usage.value.root)}）在磁盘上占用的空间。`
    : '正在计算 Emperor Home 在磁盘上占用的空间…',
)

async function load(): Promise<void> {
  loading.value = true
  try {
    usage.value = await core('storage.usage')
    if (failure.value?.title === '没能读取存储占用') failure.value = null
  } catch (cause) {
    failure.value = { title: '没能读取存储占用', detail: message(cause) }
  } finally {
    loading.value = false
  }
}

async function clean(): Promise<void> {
  if (cleaning.value) return
  if (
    !(await confirm({
      title: '清理不再需要的文件？',
      body: CLEAN_DESCRIPTION,
      confirmLabel: '清理',
    }))
  )
    return
  cleaning.value = true
  try {
    const result = await core('storage.clean')
    usage.value = result.usage
    summary.value = cleanSummary(result.report)
    failure.value = null
  } catch (cause) {
    failure.value = { title: '清理失败', detail: message(cause) }
  } finally {
    cleaning.value = false
  }
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

useSettingsHeader({
  actions: () => [
    refreshAction(() => load(), { label: '重新计算占用', busy: loading.value }),
  ],
})

onMounted(() => void load())
</script>

<template>
  <SettingsSection>
    <Notice
      v-if="failure"
      class="storage-notice"
      tone="error"
      :title="failure.title"
      :description="failure.detail"
    />
    <SettingsGroup title="清理" data-group="storage-clean">
      <SettingsRow title="清理不再需要的文件" :description="CLEAN_DESCRIPTION">
        <Button
          size="sm"
          variant="secondary"
          data-storage-clean
          :loading="cleaning"
          :disabled="cleaning"
          @click="clean"
        >
          清理
        </Button>
      </SettingsRow>
      <p v-if="summary" class="summary" role="status" data-storage-summary>
        {{ summary }}
      </p>
    </SettingsGroup>
    <SettingsGroup
      title="占用"
      :description="usageDescription"
      data-group="storage-usage"
    >
      <SettingsRow title="合计" data-storage-category="total">
        <span class="size total">{{
          usage ? formatStorageBytes(usage.total) : '—'
        }}</span>
      </SettingsRow>
      <SettingsRow
        v-for="row in rows"
        :key="row.id"
        :title="row.title"
        :description="row.description"
        :data-storage-category="row.id"
      >
        <span class="size">{{ row.size }}</span>
      </SettingsRow>
    </SettingsGroup>
  </SettingsSection>
</template>

<style scoped>
.storage-notice {
  margin-bottom: var(--space-4);
}

.size {
  font-size: var(--fs-s);
  line-height: var(--lh-s);
  font-variant-numeric: tabular-nums;
  color: rgb(var(--text-2));
  white-space: nowrap;
}

.size.total {
  font-weight: var(--weight-semibold);
  color: rgb(var(--text-1));
}

.summary {
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  color: rgb(var(--text-2));
}
</style>
