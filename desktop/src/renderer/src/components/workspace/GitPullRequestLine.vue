<script setup lang="ts">
/**
 * GitPullRequestLine — the 审查 pane's Pull Request area, one line (UI-S06):
 * the current branch's PR number and state, 「在 Pull Request 页查看」 (the
 * app's Pull Request page, at that PR) and ↗ to its GitHub page, where it is
 * merged or closed. Without a PR the line still links to the page; when the
 * GitHub CLI cannot read PRs the line is one hint and nothing to click.
 */
import { GitPullRequest, SquareArrowOutUpRight } from 'lucide-vue-next'
import { computed, inject } from 'vue'
import { routerKey } from 'vue-router'
import Badge from '../ui/Badge.vue'
import IconButton from '../ui/IconButton.vue'
import LinkButton from '../ui/LinkButton.vue'
import { pullRequestRoute, pullRequestStateLabel } from './gitReviewModel'
import { injectGitReview } from './useGitReview'

const review = injectGitReview()
const { pullRequest, pullRequestError } = review
// The Pull Request page lives in the app's router (absent in unit mounts).
const router = inject(routerKey, null)

const state = computed(() => {
  if (pullRequestError.value) return 'unavailable'
  return pullRequest.value ? 'open' : 'none'
})
const stateLabel = computed(() =>
  pullRequest.value ? pullRequestStateLabel(pullRequest.value) : '',
)
const stateTone = computed(() => {
  const label = stateLabel.value
  if (label === '可合并') return 'ok'
  if (label === '有冲突') return 'error'
  return 'neutral'
})

function openPage(): void {
  const route = pullRequest.value && pullRequestRoute(pullRequest.value.url)
  void router
    ?.push(route ? { name: 'pulls', params: route } : { name: 'pulls' })
    .catch(() => undefined)
}
</script>

<template>
  <div class="pr-line" data-pr-line :data-state="state">
    <GitPullRequest :size="14" class="pr-icon" aria-hidden="true" />
    <span v-if="state === 'unavailable'" class="pr-text pr-hint">{{
      pullRequestError
    }}</span>
    <template v-else>
      <span v-if="pullRequest" class="pr-text">
        <span class="pr-number">#{{ pullRequest.number }}</span>
        <Badge :tone="stateTone">{{ stateLabel }}</Badge>
      </span>
      <span v-else class="pr-text pr-hint">当前分支没有 Pull Request</span>
      <LinkButton class="pr-link" @click="openPage"
        >在 Pull Request 页查看</LinkButton
      >
      <IconButton
        v-if="pullRequest"
        size="xs"
        label="在 GitHub 打开"
        tooltip="在 GitHub 合并或关闭"
        @click="review.openUrl(pullRequest.url)"
      >
        <SquareArrowOutUpRight :size="12" />
      </IconButton>
    </template>
  </div>
</template>

<style scoped>
.pr-line {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  height: var(--row-h);
  padding: 0 var(--space-0-5);
  font: var(--weight-regular) var(--type-caption) var(--font-sans);
}

.pr-icon {
  flex: none;
  color: rgb(var(--text-3));
}

.pr-text {
  display: inline-flex;
  flex: 1;
  align-items: center;
  gap: var(--space-1-5);
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
}

.pr-number {
  color: rgb(var(--text-1));
  font-variant-numeric: tabular-nums;
}

.pr-hint {
  display: block;
  color: rgb(var(--text-3));
  text-overflow: ellipsis;
}

.pr-link {
  flex: none;
  white-space: nowrap;
}
</style>
