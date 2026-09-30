<script setup lang="ts">
/**
 * GitHubGate — what the GitHub plugin's pages show until they can read:
 * the plugin is off (say so and link to it), or gh is missing, logged out
 * or failing (the Pull Request page's empty state, with re-check and
 * 前往诊断). Otherwise the default slot.
 *
 * Props: pluginOn; status (gh status, null while the first check runs);
 * busy (a check is running); subject (what the page reads, for the gh
 * install hint). Emits: retry.
 */
import { useRouter } from 'vue-router'
import type { PullRequestBrowserStatus } from '../../../api/pullRequests'
import Button from '../../ui/Button.vue'
import EmptyState from '../../settings/ui/EmptyState.vue'
import { useSettingsRoute } from '../../settings/useSettingsRoute'
import PullRequestUnavailable from '../pulls/PullRequestUnavailable.vue'
import { GITHUB_PLUGIN_LOCATION } from './githubModel'

defineProps<{
  pluginOn: boolean
  status: PullRequestBrowserStatus | null
  busy: boolean
  subject: string
}>()
const emit = defineEmits<{ retry: [] }>()

const router = useRouter()
const { openSettings } = useSettingsRoute()

function openPlugin(): void {
  void router.push(GITHUB_PLUGIN_LOCATION).catch(() => undefined)
}
</script>

<template>
  <EmptyState
    v-if="!pluginOn"
    title="GitHub 插件已停用"
    description="启用后，可以在这里查看 Issue 和 CI 运行记录。"
    data-github-disabled
  >
    <Button size="sm" variant="outline" @click="openPlugin">
      打开 GitHub 插件
    </Button>
  </EmptyState>
  <PullRequestUnavailable
    v-else-if="status && !status.available"
    :status="status"
    :busy="busy"
    :subject="subject"
    @retry="emit('retry')"
    @diagnose="openSettings('diagnostics')"
  />
  <p v-else-if="!status" class="hint" role="status">正在检查 GitHub CLI…</p>
  <slot v-else />
</template>

<style scoped>
.hint {
  margin: 0;
  padding-top: var(--space-1);
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  color: rgb(var(--label-tertiary));
}
</style>
