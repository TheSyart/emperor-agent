<script setup lang="ts">
/**
 * ChangesPill — 「N 个文件已更改 +A −D」 above the composer docks: the git
 * change total of the Build session's workspace (a workspace total, not a
 * per-turn ledger), read from the shared workspace snapshot. Hidden for
 * plain chats and a clean tree; click opens the 审查 pane.
 *
 * Props: sessionId (the viewed session), build (it is a Build session bound
 * to a project — only then does the pill poll the snapshot).
 */
import { FileDiff } from 'lucide-vue-next'
import { computed, onActivated, onDeactivated, ref } from 'vue'
import Tooltip from '../ui/Tooltip.vue'
import { useWorkspaceSnapshot } from '../workspace/useWorkspaceSnapshot'
import { requestWorkspace } from '../workspace/workspaceState'
import { isGitStatus } from '../workspace/workspaceTypes'

const props = defineProps<{ sessionId: string; build: boolean }>()

/** Kept-alive conversations stop polling while cached. */
const activated = ref(true)
onActivated(() => {
  activated.value = true
})
onDeactivated(() => {
  activated.value = false
})
const workspace = useWorkspaceSnapshot({
  active: () => props.build && activated.value,
})

const summary = computed(() => {
  const snapshot = workspace.snapshot.value
  if (!props.build || snapshot?.sessionId !== props.sessionId) return null
  if (!isGitStatus(snapshot.git)) return null
  const changes = snapshot.git.summary
  return changes.changedFiles > 0 ? changes : null
})

function openReview(): void {
  requestWorkspace({ pane: 'review' })
}
</script>

<template>
  <div v-if="summary" class="changes-dock">
    <Tooltip label="工作区总改动">
      <button
        type="button"
        class="changes-pill"
        :aria-label="`${summary.changedFiles} 个文件已更改，新增 ${summary.additions} 行，删除 ${summary.deletions} 行，打开审查`"
        @click="openReview"
      >
        <FileDiff :size="14" class="lead" aria-hidden="true" />
        <span class="files">{{ summary.changedFiles }} 个文件已更改</span>
        <span class="added">+{{ summary.additions }}</span>
        <span class="deleted">−{{ summary.deletions }}</span>
      </button>
    </Tooltip>
  </div>
</template>

<style scoped>
.changes-dock {
  display: flex;
  box-sizing: border-box;
  width: calc(100% - 2 * var(--composer-clearance) - 4 * var(--dock-inset));
  max-width: calc(var(--composer-card-max) - 4 * var(--dock-inset));
  margin: 0 auto;
}

.changes-pill {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1-5);
  height: var(--space-7);
  padding: 0 var(--space-3) 0 var(--space-2-5);
  border: 1px solid var(--border-l1);
  border-radius: var(--radius-pill);
  background: rgb(var(--tip-fill));
  color: rgb(var(--label-secondary));
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  white-space: nowrap;
  cursor: pointer;
}

.changes-pill:hover {
  background: var(--interactive-bg-hover-solid);
  color: rgb(var(--label-primary));
}

.changes-pill:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px rgb(var(--focus-ring) / 0.5);
}

.lead {
  flex: none;
  color: rgb(var(--label-tertiary));
}

.added,
.deleted {
  font-family: var(--font-mono);
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  font-variant-numeric: tabular-nums;
}

.added {
  color: rgb(var(--state-ok-label));
}

.deleted {
  color: rgb(var(--state-error-label));
}
</style>
