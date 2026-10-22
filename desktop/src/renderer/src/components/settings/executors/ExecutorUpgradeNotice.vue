<script setup lang="ts">
/**
 * The top of 设置 › 子智能体 for versions (AGT-13), one Notice at a time:
 *
 * - an upgrade that failed: why (no write permission names the folder;
 *   Emperor never asks for admin rights), the same command to run in
 *   Terminal, 复制命令 · 重新检测 · 查看过程;
 * - otherwise new versions: 「Claude Code 和 Codex 有新版本」 with what
 *   changes, 稍后 · 全部升级 (the confirmation comes first).
 *
 * Props: profileId? (only that executor's failure: the detail page).
 * Emits: recheck(profileId).
 */
import { computed, ref } from 'vue'
import Button from '../../ui/Button.vue'
import { writeClipboard } from '../../ui/useCopyFeedback'
import { Notice } from '../ui'
import ExecutorUpgradeProgress from './ExecutorUpgradeProgress.vue'
import { useExecutorUpgrades } from './executorUpgrades'
import { failedRun, failureContent, noticeContent } from './upgradeText'

const props = defineProps<{ profileId?: string }>()
const emit = defineEmits<{ recheck: [profileId: string] }>()

const upgrades = useExecutorUpgrades()
const failures = computed(() =>
  (upgrades.versions.value?.upgrades ?? [])
    .filter((run) => !props.profileId || run.profileId === props.profileId)
    .filter((run) => {
      const version = upgrades.versionOf(run.profileId)
      return version?.enabled && failedRun(version, run)
    }),
)
const found = computed(() =>
  props.profileId || failures.value.length
    ? null
    : noticeContent(upgrades.versions.value),
)
const copied = ref<string | null>(null)
const logs = ref<Record<string, boolean>>({})
async function copy(command: string | null, profileId: string) {
  if (command && (await writeClipboard(command))) copied.value = profileId
}
</script>

<template>
  <Notice
    v-for="run in failures"
    :key="run.profileId"
    tone="error"
    :title="failureContent(run).title"
    data-upgrade-failed
    :data-profile="run.profileId"
  >
    <span class="line">{{ failureContent(run).body }}</span>
    <code
      v-if="failureContent(run).command"
      class="command"
      data-upgrade-manual
      >{{ failureContent(run).command }}</code
    >
    <ExecutorUpgradeProgress
      v-if="logs[run.profileId]"
      class="failure-log"
      :log="run.log"
      show-log
    />
    <template #actions>
      <Button
        v-if="failureContent(run).command"
        size="sm"
        variant="secondary"
        data-upgrade-copy
        @click="copy(failureContent(run).command, run.profileId)"
        >{{ copied === run.profileId ? '已复制' : '复制命令' }}</Button
      ><Button
        size="sm"
        variant="secondary"
        data-upgrade-recheck
        @click="emit('recheck', run.profileId)"
        >重新检测</Button
      ><Button
        size="sm"
        variant="ghost"
        data-upgrade-show-log
        :aria-expanded="!!logs[run.profileId]"
        @click="logs[run.profileId] = !logs[run.profileId]"
        >{{ logs[run.profileId] ? '收起过程' : '查看过程' }}</Button
      >
    </template>
  </Notice>
  <Notice
    v-if="found"
    tone="accent"
    :title="found.title"
    :description="found.body"
    data-upgrade-notice
  >
    <template #actions>
      <Button
        size="sm"
        variant="ghost"
        data-upgrade-later
        @click="upgrades.dismiss()"
        >稍后</Button
      ><Button
        size="sm"
        variant="primary"
        data-upgrade-all
        @click="upgrades.ask(found.profileIds)"
        >{{ found.action }}</Button
      >
    </template>
  </Notice>
</template>

<style scoped>
.line {
  display: block;
}

.command {
  display: block;
  margin-top: var(--space-2);
  overflow-x: auto;
  padding: var(--space-1-5) var(--space-2);
  border-radius: var(--r-xs);
  background: rgb(var(--surface-sunken));
  color: rgb(var(--text-1));
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  white-space: nowrap;
}

.failure-log {
  margin-top: var(--space-2);
}
</style>
