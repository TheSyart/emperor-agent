<script setup lang="ts">
/**
 * PullRequestsPage — the /pulls/:owner?/:repo?/:number? full page: PageShell
 * (title + the refresh action PullRequestBrowser publishes) around the
 * list / detail browser. Read-only: browsing, checks, files and diffs of the
 * account's open Pull Requests through the signed GitHub CLI.
 *
 * Unlike the other full pages this one is a two-pane workspace, so the shell
 * runs in its `fill` layout: no 880px column cap and no outer scroll — the
 * header stays put and the panes below scroll on their own.
 */
import PageShell from '../PageShell.vue'
import PullRequestBrowser from './PullRequestBrowser.vue'
</script>

<template>
  <PageShell title="Pull Request" fill>
    <PullRequestBrowser />
  </PageShell>
</template>
