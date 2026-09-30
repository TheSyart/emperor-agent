/**
 * Whether the GitHub plugin's pages can read right now: the plugin is on
 * (the boot plugin list, which the plugins page keeps current) and gh is
 * installed and logged in (the Pull Request page's status check). A read
 * that fails because gh went away re-checks, so the page falls back to its
 * empty state instead of repeating the error.
 */
import { computed, shallowRef, watch } from 'vue'
import {
  getPullRequestStatus,
  pullRequestErrorInfo,
  type PullRequestBrowserStatus,
} from '../../../api/pullRequests'
import { useAppContext } from '../../../composables/useAppContext'
import { githubPluginOn } from './githubModel'

export function useGitHubAccess() {
  const ctx = useAppContext()
  const pluginOn = computed(() => githubPluginOn(ctx.boot.value?.plugins ?? []))
  const status = shallowRef<PullRequestBrowserStatus | null>(null)
  const busy = shallowRef(false)
  const ready = computed(
    () => pluginOn.value && status.value?.available === true,
  )

  let seq = 0
  async function checkStatus(): Promise<void> {
    const id = ++seq
    busy.value = true
    try {
      const next = await getPullRequestStatus()
      if (id === seq) status.value = next
    } catch (error) {
      // IPC / bridge failure: shown like a gh failure (retryable).
      if (id === seq)
        status.value = {
          available: false,
          reason: 'gh_failed',
          message: pullRequestErrorInfo(error).message,
        }
    } finally {
      if (id === seq) busy.value = false
    }
  }

  /** The message for a failed read; re-checks gh when it went away. */
  function failure(error: unknown): string {
    const info = pullRequestErrorInfo(error)
    if (info.kind === 'unavailable') void checkStatus()
    return info.message
  }

  watch(
    pluginOn,
    (on) => {
      if (on) void checkStatus()
    },
    { immediate: true },
  )

  return { pluginOn, status, busy, ready, checkStatus, failure }
}
