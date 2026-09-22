<script setup lang="ts">
/**
 * MemoryVersionList — Settings › 记忆 › 版本: one row card per snapshot
 * (label / path, target · reason · time, size badge, 「恢复」). Opening a
 * row loads the snapshot and shows what restoring it would change (current
 * → snapshot) as an inline diff. Restoring first snapshots the current file
 * (Core `pre_restore:*`), so it can be undone from this list.
 *
 * Props:
 * - versions: MemoryVersion[] (newest first, from memory.versions).
 * - loadVersion(id): MemoryVersionDetail loader.
 * - busy?: disables 「恢复」.
 * Emits: restore(id).
 */
import { ref, watch } from 'vue'
import Button from '../../ui/Button.vue'
import DiffBlock from '../../ui/DiffBlock.vue'
import { EmptyState, SettingsCard, StatusBadge } from '../ui'
import { formatBytes, versionDescription } from './memoryModel'
import type { MemoryVersion, MemoryVersionDetail } from '../../../types'

const props = withDefaults(
  defineProps<{
    versions: readonly MemoryVersion[]
    loadVersion: (id: string) => Promise<MemoryVersionDetail>
    busy?: boolean
  }>(),
  { busy: false },
)
const emit = defineEmits<{ restore: [id: string] }>()

const openId = ref('')
const details = ref<Record<string, MemoryVersionDetail>>({})
const loading = ref('')
const loadError = ref('')

// Any list change (save / restore / refresh) moves the current content.
watch(
  () => props.versions,
  () => {
    details.value = {}
    if (openId.value) void load(openId.value)
  },
)

async function load(id: string) {
  loading.value = id
  loadError.value = ''
  try {
    const detail = await props.loadVersion(id)
    details.value = { ...details.value, [id]: detail }
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : String(error)
  } finally {
    if (loading.value === id) loading.value = ''
  }
}

function setOpen(version: MemoryVersion, open: boolean) {
  openId.value = open ? version.id : ''
  if (open && !details.value[version.id]) void load(version.id)
}

function unchanged(detail: MemoryVersionDetail) {
  return detail.content.trimEnd() === detail.currentContent.trimEnd()
}
</script>

<template>
  <div class="memory-version-list">
    <EmptyState
      v-if="!versions.length"
      title="还没有版本快照"
      description="保存或恢复记忆文件时会自动留下快照。"
    />
    <SettingsCard
      v-for="version in versions"
      :key="version.id"
      expandable
      :open="openId === version.id"
      :title="version.label || version.relPath"
      :description="versionDescription(version)"
      :data-version-id="version.id"
      @update:open="setOpen(version, $event)"
    >
      <template #meta>
        <StatusBadge mono>{{ formatBytes(version.bytes) }}</StatusBadge>
      </template>
      <template #actions>
        <Button
          size="sm"
          variant="outline"
          :disabled="busy"
          :aria-label="`恢复 ${version.label || version.relPath}`"
          @click="emit('restore', version.id)"
        >
          恢复
        </Button>
      </template>

      <p class="meta">
        <span class="mono">{{ version.relPath }}</span>
        <span class="mono">{{ version.id }}</span>
      </p>
      <p v-if="loading === version.id" class="hint">加载快照中…</p>
      <p v-else-if="loadError && !details[version.id]" class="error">
        {{ loadError }}
      </p>
      <template v-else-if="details[version.id]">
        <p v-if="unchanged(details[version.id]!)" class="hint">
          当前内容与该版本一致。
        </p>
        <template v-else>
          <p class="hint">恢复后的变化（当前 → 此版本）</p>
          <DiffBlock
            :diffs="[
              {
                path: version.relPath,
                oldText: details[version.id]!.currentContent,
                newText: details[version.id]!.content,
              },
            ]"
            :max-lines="24"
          />
        </template>
      </template>
    </SettingsCard>
  </div>
</template>

<style scoped>
.memory-version-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-width: 0;
}

.meta {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1) var(--space-3);
  margin: 0;
  min-width: 0;
}

.mono {
  min-width: 0;
  font-family: var(--font-mono);
  font-size: var(--fs-xxxs);
  line-height: var(--lh-xxxs);
  color: rgb(var(--label-tertiary));
  overflow-wrap: anywhere;
}

.hint {
  margin: 0;
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  color: rgb(var(--label-tertiary));
}

.error {
  margin: 0;
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  color: rgb(var(--state-error-label));
}
</style>
