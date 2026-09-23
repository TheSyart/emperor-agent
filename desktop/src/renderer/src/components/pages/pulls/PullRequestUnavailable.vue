<script setup lang="ts">
/**
 * PullRequestUnavailable — the whole-page empty state while gh cannot be
 * used: not installed (manual install commands + 前往诊断, where the
 * environment tools only show gh's detected status and version — nothing
 * is installed from the app), not logged in (`gh auth login` hint), or
 * failing (its sanitized message). Every state can re-check.
 *
 * Props: status (reason / message / version); busy (a re-check is running).
 * Emits: retry, diagnose.
 */
import { computed } from 'vue'
import type { PullRequestBrowserStatus } from '../../../api/pullRequests'
import Button from '../../ui/Button.vue'
import EmptyState from '../../settings/ui/EmptyState.vue'
import { pullIcons } from './pullIcons'

const props = defineProps<{
  status: PullRequestBrowserStatus
  busy: boolean
}>()
const emit = defineEmits<{ retry: []; diagnose: [] }>()

const reason = computed(() => props.status.reason ?? 'gh_failed')
const icon = computed(() =>
  reason.value === 'gh_missing'
    ? pullIcons.missing
    : reason.value === 'gh_unauthenticated'
      ? pullIcons.login
      : pullIcons.failed,
)
const title = computed(() =>
  reason.value === 'gh_missing'
    ? '需要 GitHub CLI（gh）'
    : reason.value === 'gh_unauthenticated'
      ? 'GitHub CLI 尚未登录'
      : '无法连接 GitHub CLI',
)
</script>

<template>
  <div class="pr-unavailable" :data-reason="reason" role="status">
    <EmptyState variant="plain" :title="title">
      <template #icon>
        <span class="icon-well"><component :is="icon" :size="22" /></span>
      </template>
      <template #description>
        <span v-if="reason === 'gh_missing'" class="lines">
          <span>此页通过本机的 GitHub CLI 读取你的 Pull Request。</span>
          <span class="install">
            <span>macOS：<code>brew install gh</code></span>
            <span>Windows：<code>winget install GitHub.cli</code></span>
          </span>
        </span>
        <span v-else-if="reason === 'gh_unauthenticated'" class="lines">
          <span>在终端运行 <code>gh auth login</code> 登录 GitHub</span>
          <span v-if="status.version" class="version">
            gh {{ status.version }}
          </span>
        </span>
        <span v-else class="lines">
          <span>{{ status.message || 'GitHub CLI 操作失败。' }}</span>
        </span>
      </template>
      <Button
        v-if="reason === 'gh_missing'"
        size="sm"
        variant="primary"
        title="在诊断中查看 gh 的检测状态"
        @click="emit('diagnose')"
      >
        前往诊断
      </Button>
      <Button
        size="sm"
        variant="outline"
        :disabled="busy"
        @click="emit('retry')"
      >
        {{ reason === 'gh_failed' ? '重试' : busy ? '检测中…' : '重新检测' }}
      </Button>
    </EmptyState>
  </div>
</template>

<style scoped>
.pr-unavailable {
  display: grid;
  flex: 1;
  place-items: center;
  min-height: 0;
  padding: var(--space-8) var(--space-6);
}

.pr-unavailable :deep(.ds-empty-state) {
  max-width: 480px;
}

.pr-unavailable :deep(.ds-empty-state .title) {
  color: rgb(var(--label-primary));
  font-size: var(--fs-base);
  line-height: var(--lh-base);
  font-weight: 600;
}

.icon-well {
  display: inline-grid;
  place-items: center;
  width: calc(var(--space-8) + var(--space-3));
  height: calc(var(--space-8) + var(--space-3));
  margin-bottom: var(--space-1);
  border-radius: var(--radius-pill);
  background: var(--interactive-bg-hover);
  color: rgb(var(--label-secondary));
}

.lines {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-1-5);
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
}

.install {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-1);
  color: rgb(var(--label-secondary));
  white-space: nowrap;
}

.version {
  color: rgb(var(--label-caption));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
}

code {
  padding: 0 var(--space-1-5);
  border-radius: var(--radius-sm);
  background: var(--interactive-bg-hover);
  color: rgb(var(--label-primary));
  font: var(--font-code-small);
}
</style>
