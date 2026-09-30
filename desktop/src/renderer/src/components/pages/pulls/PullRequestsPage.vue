<script setup lang="ts">
/**
 * PullRequestsPage — the /pulls/:owner?/:repo?/:number? full page: PageShell
 * (title + the refresh action PullRequestBrowser publishes) around the
 * list / detail browser. Read-only: browsing, checks, files and diffs of the
 * account's open Pull Requests through the signed GitHub CLI.
 *
 * While the GitHub plugin is on, the page is titled GitHub and carries the
 * plugin's Pull Request / Issue / CI tabs; turning the plugin off takes the
 * tabs away and leaves the Pull Request browser as it was.
 *
 * Unlike the other full pages this one is a two-pane workspace, so the shell
 * runs in its `fill` layout: no 880px column cap and no outer scroll — the
 * header stays put and the panes below scroll on their own.
 */
import { computed } from 'vue'
import { useAppContext } from '../../../composables/useAppContext'
import GitHubTabs from '../github/GitHubTabs.vue'
import { githubPluginOn } from '../github/githubModel'
import PageShell from '../PageShell.vue'
import PullRequestBrowser from './PullRequestBrowser.vue'

const ctx = useAppContext()
const pluginOn = computed(() => githubPluginOn(ctx.boot.value?.plugins ?? []))
</script>

<template>
  <PageShell :title="pluginOn ? 'GitHub' : 'Pull Request'" fill>
    <template v-if="pluginOn" #tabs>
      <GitHubTabs active="pulls" />
    </template>
    <PullRequestBrowser />
  </PageShell>
</template>
