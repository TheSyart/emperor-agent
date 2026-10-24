/**
 * 设置 › 子智能体's versions and 升级 (AGT-13), one copy for the window:
 * read from Core (`executors.versions`) when the settings open (the nav
 * dot) and when 子智能体 opens (which also asks npm, at most once a
 * minute), kept current by Core's `executor_upgrade` events (an upgrade
 * as it goes, or the versions after a check). The confirmation dialog's state lives here
 * too, so the main page and the detail pages share it. Loaded with the
 * settings, never at startup. 退回 (VER-03) to the last good version runs
 * through the same events, after its own confirmation.
 */
import { computed, ref } from 'vue'
import type {
  ExecutorProbe,
  ExecutorUpgradeView,
  ExecutorVersionView,
  ExecutorVersionsView,
} from '@emperor/core/runtime-contract'
import { onCoreEvent } from '../../../api/backend'
import { core } from '../../../api/http'
import { pushToast } from '../../ui/toasts'
import { attentionNeeded, executorTitle, runVerb } from './upgradeText'

const versions = ref<ExecutorVersionsView | null>(null)
const error = ref('')
/** The profiles the confirmation is open for (null: closed). */
const asking = ref<string[] | null>(null)
/** The profile 退回's confirmation is open for (null: closed). */
const askingRollback = ref<string | null>(null)
/** Runs this window saw going: their success gets a toast once. */
const watched = new Set<string>()
const probeListeners = new Set<
  (profileId: string, probe: ExecutorProbe) => void
>()
let unsubscribe: (() => void) | null = null

const message = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause)
const key = (run: ExecutorUpgradeView) => `${run.profileId}:${run.startedAt}`

function adoptRun(run: ExecutorUpgradeView) {
  const current = versions.value
  if (current)
    versions.value = {
      ...current,
      upgrades: [
        ...current.upgrades.filter((u) => u.profileId !== run.profileId),
        run,
      ],
    }
  if (run.state === 'waiting' || run.state === 'running') watched.add(key(run))
  else if (watched.delete(key(run)) && run.state === 'succeeded')
    pushToast(
      `${executorTitle(run.backend)} 已${runVerb(run)}到 ${run.installed ?? run.target}`,
      {
        tone: 'ok',
      },
    )
}

function follow() {
  if (unsubscribe) return
  unsubscribe = onCoreEvent((event) => {
    const data = event as {
      event?: unknown
      versions?: ExecutorVersionsView
      upgrade?: ExecutorUpgradeView
      probe?: ExecutorProbe
    } | null
    if (data?.event !== 'executor_upgrade') return
    if (Array.isArray(data.versions?.executors)) versions.value = data.versions!
    if (data.upgrade) {
      adoptRun(data.upgrade)
      if (data.probe)
        for (const listener of probeListeners)
          listener(data.upgrade.profileId, data.probe)
    }
  })
}

/** `refresh`: true asks npm now (检查更新); 'auto' when 子智能体 opens. */
async function load(refresh?: boolean | 'auto'): Promise<void> {
  follow()
  try {
    const next = await core(
      'executors.versions',
      refresh === undefined ? {} : { refresh },
    )
    if (next && Array.isArray(next.executors)) {
      versions.value = next
      for (const run of next.upgrades)
        if (run.state === 'waiting' || run.state === 'running')
          watched.add(key(run))
    }
    error.value = ''
  } catch (cause) {
    error.value = `检查版本失败：${message(cause)}`
  }
}

function versionOf(profileId: string | undefined): ExecutorVersionView | null {
  return (
    versions.value?.executors.find((v) => v.profileId === profileId) ?? null
  )
}
function runOf(profileId: string | undefined): ExecutorUpgradeView | null {
  return versions.value?.upgrades.find((u) => u.profileId === profileId) ?? null
}

/** After the confirmation: one after the other (Core runs one at a time). */
async function upgrade(profileIds: readonly string[]): Promise<void> {
  asking.value = null
  for (const profileId of profileIds) {
    const target = versionOf(profileId)?.target
    if (!target) continue
    try {
      const { upgrade: run } = await core('executors.upgrade', {
        profileId,
        target,
      })
      adoptRun(run)
      error.value = ''
    } catch (cause) {
      error.value = `没有开始升级：${message(cause)}`
    }
  }
}

/** 退回 after its confirmation: to the version offered, the last good one. */
async function rollback(profileId: string): Promise<void> {
  askingRollback.value = null
  const target = versionOf(profileId)?.rollback?.target
  if (!target) return
  try {
    const { upgrade: run } = await core('executors.rollback', {
      profileId,
      target,
    })
    adoptRun(run)
    error.value = ''
  } catch (cause) {
    error.value = `没有开始退回：${message(cause)}`
  }
}

async function cancel(profileId: string): Promise<void> {
  const verb = runVerb(runOf(profileId))
  try {
    const { upgrade: run } = await core('executors.cancelUpgrade', {
      profileId,
    })
    if (run) adoptRun(run)
  } catch (cause) {
    error.value = `取消${verb}失败：${message(cause)}`
  }
}

/** 稍后. */
async function dismiss(): Promise<void> {
  if (versions.value) versions.value = { ...versions.value, dismissed: true }
  try {
    const next = await core('executors.dismissUpgrades', {})
    if (next && Array.isArray(next.executors)) versions.value = next
  } catch {
    // Shown again next time; nothing else depends on it.
  }
}

/** A probe Core took after an upgrade (the settings page adopts it). */
function onProbe(listener: (profileId: string, probe: ExecutorProbe) => void) {
  probeListeners.add(listener)
  return () => probeListeners.delete(listener)
}

const attention = computed(() => attentionNeeded(versions.value))

export function useExecutorUpgrades() {
  return {
    versions,
    error,
    asking,
    askingRollback,
    attention,
    load,
    versionOf,
    runOf,
    upgrade,
    rollback,
    cancel,
    dismiss,
    onProbe,
    ask: (profileIds: string[]) => {
      asking.value = profileIds
    },
    askRollback: (profileId: string) => {
      askingRollback.value = profileId
    },
  }
}

/** Tests: start from nothing. */
export function resetExecutorUpgrades(): void {
  unsubscribe?.()
  unsubscribe = null
  versions.value = null
  error.value = ''
  asking.value = null
  askingRollback.value = null
  watched.clear()
  probeListeners.clear()
}
