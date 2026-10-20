<script setup lang="ts">
/**
 * GitBranchMenu — the 审查 pane's 「分支名 ▾」 button and every Git action
 * behind it (UI-S06): 切换分支 ▸ (the branch list), 新建分支… (a name box),
 * 获取 (fetch), 拉取 (pull), 推送 (push), 比较分支 ↗ (the provider's compare page) and the
 * worktree: 新建并进入, or 离开 / 安全删除 while in one. These are also the
 * writes the environment card's 「…」 menu used to hold.
 *
 * Writes keep the 审查 rules (useGitReview): they ask first, carry the
 * status revision and wait while the agent runs or a Git operation is
 * unfinished; the menu says why in its footer. The name box itself is never
 * disabled, only 创建.
 */
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  ArrowUpRight,
  ChevronDown,
  FolderGit2,
  GitBranch,
  GitBranchPlus,
  GitCompareArrows,
  LogOut,
  RefreshCw,
  Trash2,
} from 'lucide-vue-next'
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import Badge from '../ui/Badge.vue'
import Button from '../ui/Button.vue'
import Menu from '../ui/Menu.vue'
import MenuItem from '../ui/MenuItem.vue'
import Popover from '../ui/Popover.vue'
import TextField from '../ui/TextField.vue'
import { branchLabel } from './gitReviewModel'
import { injectGitReview } from './useGitReview'

const review = injectGitReview()
const {
  status,
  branches,
  activeWorktree,
  blockedReason,
  writesDisabled,
  writing,
  loading,
  compare,
  branchDraft,
} = review

const anchor = ref<HTMLElement | null>(null)
const nameField = ref<InstanceType<typeof TextField> | null>(null)
const actionsOpen = ref(false)
const branchesOpen = ref(false)
const createOpen = ref(false)

const label = computed(() => branchLabel(status.value))
const pullHint = computed(() =>
  status.value?.behind
    ? `拉取 ${status.value.behind} 个提交，只快进`
    : '只快进，不产生合并提交',
)
const pushHint = computed(() => {
  const current = status.value
  if (!current?.upstream) return '推送并设为上游分支'
  return current.ahead ? `推送 ${current.ahead} 个提交` : '与上游一致'
})
const compareHint = computed(() => {
  const link = compare.value
  return link.url === null ? link.reason : '在浏览器打开比较页'
})
const createHint = computed(
  () => blockedReason.value || '基于当前提交创建，不会切换过去',
)

// The menus open from a click, so focus may still sit on the trigger:
// Escape closes them wherever it is pressed (a modal answers it first).
function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing)
    return
  event.preventDefault()
  actionsOpen.value = false
  branchesOpen.value = false
  anchor.value?.querySelector('button')?.focus()
}
watch(
  () => actionsOpen.value || branchesOpen.value,
  (open) => {
    if (open) document.addEventListener('keydown', onKeydown)
    else document.removeEventListener('keydown', onKeydown)
  },
)
onBeforeUnmount(() => document.removeEventListener('keydown', onKeydown))

function showBranches(): void {
  branchesOpen.value = true
}

function showCreate(): void {
  createOpen.value = true
  void nextTick(() => nameField.value?.focus())
}

async function create(): Promise<void> {
  if (!branchDraft.value.trim() || writesDisabled.value) return
  if (await review.createBranch()) createOpen.value = false
}
</script>

<template>
  <span ref="anchor" class="branch-anchor">
    <button
      type="button"
      class="branch-button"
      data-branch-menu
      aria-haspopup="menu"
      :aria-expanded="actionsOpen"
      :title="`当前分支：${label}`"
      @click="actionsOpen = !actionsOpen"
    >
      <GitBranch :size="14" class="branch-icon" aria-hidden="true" />
      <span class="branch-name">{{ label }}</span>
      <Badge v-if="activeWorktree" data-worktree-badge>worktree</Badge>
      <ChevronDown :size="12" class="branch-icon" aria-hidden="true" />
    </button>
  </span>

  <Menu
    v-model:open="actionsOpen"
    :anchor="anchor"
    placement="bottom"
    align="start"
    :width="256"
    dense
    label="Git 操作"
  >
    <MenuItem
      data-action="switch-branch"
      :disabled="writesDisabled"
      :description="label"
      @select="showBranches"
    >
      切换分支
      <template #icon><GitBranch :size="15" /></template>
    </MenuItem>
    <MenuItem
      data-action="create-branch"
      description="基于当前提交"
      @select="showCreate"
    >
      新建分支…
      <template #icon><GitBranchPlus :size="15" /></template>
    </MenuItem>
    <MenuItem variant="separator" />
    <MenuItem
      data-action="fetch"
      :disabled="!status || writing || loading"
      description="获取远端的最新引用"
      @select="review.fetchRemote"
    >
      获取
      <template #icon><RefreshCw :size="15" /></template>
    </MenuItem>
    <MenuItem
      data-action="pull"
      :disabled="writesDisabled"
      :description="pullHint"
      @select="review.pull"
    >
      拉取
      <template #icon><ArrowDownToLine :size="15" /></template>
    </MenuItem>
    <MenuItem
      data-action="push"
      :disabled="writesDisabled"
      :description="pushHint"
      @select="review.push"
    >
      推送
      <template #icon><ArrowUpFromLine :size="15" /></template>
    </MenuItem>
    <MenuItem variant="separator" />
    <MenuItem
      data-action="compare"
      :disabled="!compare.url"
      :description="compareHint"
      @select="review.openUrl(compare.url)"
    >
      比较分支
      <template #icon><GitCompareArrows :size="15" /></template>
      <template #trailing>
        <ArrowUpRight v-if="compare.url" :size="14" class="trailing" />
      </template>
    </MenuItem>
    <MenuItem variant="separator" />
    <template v-if="activeWorktree">
      <MenuItem
        data-action="exit-worktree"
        :disabled="writesDisabled"
        description="回到项目目录，保留它的目录和分支"
        @select="review.exitWorktree('keep')"
      >
        离开 worktree
        <template #icon><LogOut :size="15" /></template>
      </MenuItem>
      <MenuItem
        data-action="remove-worktree"
        danger
        :disabled="writesDisabled"
        description="有修改或未推送的提交时会拒绝"
        @select="review.exitWorktree('remove')"
      >
        安全删除 worktree
        <template #icon><Trash2 :size="15" /></template>
      </MenuItem>
    </template>
    <MenuItem
      v-else
      data-action="enter-worktree"
      :disabled="writesDisabled"
      description="在临时目录和分支里隔离改动"
      @select="review.enterWorktree"
    >
      新建并进入 worktree
      <template #icon><FolderGit2 :size="15" /></template>
    </MenuItem>
    <template v-if="blockedReason" #footer>
      <p class="menu-note">{{ blockedReason }}</p>
    </template>
  </Menu>

  <Menu
    v-model:open="branchesOpen"
    :anchor="anchor"
    placement="bottom"
    align="start"
    :width="256"
    dense
    label="切换分支"
  >
    <MenuItem variant="label">分支</MenuItem>
    <MenuItem
      v-for="branch in branches"
      :key="branch.name"
      :selected="branch.name === status?.branch"
      :disabled="branch.name !== status?.branch && writesDisabled"
      :description="branch.upstream ?? undefined"
      @select="review.switchBranch(branch.name)"
    >
      {{ branch.name }}
    </MenuItem>
    <template v-if="blockedReason" #footer>
      <p class="menu-note">{{ blockedReason }}</p>
    </template>
  </Menu>

  <Popover
    v-model:open="createOpen"
    :anchor="anchor"
    label="新建分支"
    align="start"
    :width="280"
  >
    <form class="new-branch" @submit.prevent="create">
      <TextField
        ref="nameField"
        v-model="branchDraft"
        size="sm"
        monospace
        placeholder="新分支名称"
        aria-label="新分支名称"
        @keydown.enter.prevent="create"
      />
      <p class="menu-note">{{ createHint }}</p>
      <div class="new-branch-actions">
        <Button size="sm" @click="createOpen = false">取消</Button>
        <Button
          size="sm"
          variant="primary"
          type="submit"
          :disabled="!branchDraft.trim() || writesDisabled"
          >创建</Button
        >
      </div>
    </form>
  </Popover>
</template>

<style scoped>
.branch-anchor {
  display: inline-flex;
  min-width: 0;
}

.branch-button {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1-5);
  min-width: 0;
  height: var(--control-sm);
  padding: 0 var(--space-2);
  border: none;
  border-radius: var(--r-sm);
  outline: none;
  background: transparent;
  color: rgb(var(--text-1));
  font: var(--weight-medium) var(--type-footnote) var(--font-sans);
  cursor: pointer;
  transition: background-color var(--motion-fast) var(--ease-standard);
}

.branch-button:hover {
  background: var(--surface-hover);
}

.branch-button[aria-expanded='true'] {
  background: var(--surface-active);
}

.branch-button:focus-visible {
  box-shadow: inset 0 0 0 2px rgb(var(--focus-ring) / 0.55);
}

.branch-icon {
  flex: none;
  color: rgb(var(--text-3));
}

.branch-name {
  min-width: 0;
  overflow: hidden;
  font-family: var(--font-mono);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.trailing {
  flex: none;
  color: rgb(var(--text-3));
}

.menu-note {
  margin: 0;
  padding: var(--space-1) var(--space-2-5);
  color: rgb(var(--text-3));
  font: var(--weight-regular) var(--type-caption) var(--font-sans);
}

.new-branch {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.new-branch .menu-note {
  padding: 0;
}

.new-branch-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-1-5);
}
</style>
