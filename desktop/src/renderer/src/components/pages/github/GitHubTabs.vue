<script setup lang="ts">
/**
 * GitHubTabs — Pull Request / Issue / CI, the strip the GitHub plugin adds
 * to the Pull Request page. Shown only while the plugin is on; each tab is
 * its own route, so deep links and back / forward keep working.
 *
 * Props: active (route name of the current page).
 */
import { useRouter } from 'vue-router'
import Tabs from '../../ui/Tabs.vue'

defineProps<{ active: 'pulls' | 'github-issues' | 'github-ci' }>()
const router = useRouter()

const TABS = [
  { id: 'pulls', label: 'Pull Request' },
  { id: 'github-issues', label: '议题' },
  { id: 'github-ci', label: 'CI' },
]

function select(name: string): void {
  void router.push({ name }).catch(() => undefined)
}
</script>

<template>
  <Tabs
    :model-value="active"
    :tabs="TABS"
    aria-label="GitHub"
    data-github-tabs
    @update:model-value="select"
  />
</template>
