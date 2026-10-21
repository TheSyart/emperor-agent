/**
 * State of 设置 › 子智能体 (AGT-10), shared by its main page and the 高级
 * and 详情 sub pages. Every change is saved at once — there is no 保存配置:
 * changes queue in order, each saved on top of the last saved revision, and
 * a failed save puts the page back on what is saved and says why. Probes,
 * model catalogs and runtime facts come from Core as before.
 */
import {
  computed,
  inject,
  onBeforeUnmount,
  onMounted,
  provide,
  ref,
  type InjectionKey,
} from 'vue'
import type {
  ClaudeSignInView,
  ExecutorConfig,
  ExecutorModelCatalog,
  ExecutorProbe,
  ExecutorProfile,
  ExecutorRuntimeFacts,
} from '@emperor/core/runtime-contract'
import { onCoreEvent } from '../../../api/backend'
import { core } from '../../../api/http'
import {
  cancelExecutorSignIn,
  clearExecutorCredential,
  configureExecutors,
  dismissExecutorNotice,
  listExecutorModels,
  listExecutors,
  probeExecutor,
  signInExecutor,
  signOutExecutor,
} from '../../../api/delegations'
import { modelSourceName, type ExecutorFacts } from './executorText'

/** The model picker's 新增自定义模型… entry. */
export const ADD_CUSTOM_MODEL = '__add_custom_model__'

type Backend = ExecutorProfile['backend']
type ListResult = Awaited<ReturnType<typeof listExecutors>>

/** A configured model a local subagent may run on. */
export interface ModelChoice {
  value: string
  label: string
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const message = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause)

export function createExecutorSettings() {
  const config = ref<ExecutorConfig | null>(null)
  /** The last configuration Core confirmed. */
  let saved: ExecutorConfig | null = null
  const runtimes = ref<Record<string, ExecutorRuntimeFacts | undefined>>({})
  const probes = ref<Record<string, ExecutorProbe | null>>({})
  const probeErrors = ref<Record<string, string>>({})
  const consents = ref<Record<string, 'always' | null>>({})
  const catalogs = ref<Record<string, ExecutorModelCatalog | undefined>>({})
  const catalogBusy = ref<Record<string, boolean>>({})
  const selected = ref<Record<string, string>>({})
  const models = ref<ModelChoice[]>([])
  const loading = ref(false)
  const saving = ref(false)
  const tokenBusy = ref(false)
  /** The Claude profile 使用 API Key is open for (AGT-12). */
  const apiKeyDialog = ref<ExecutorProfile | null>(null)
  /**
   * 登录 Claude Code (FIX-11): the one Core is running, or the last one that
   * failed (its reason and the command for Terminal) until it is retried or
   * a check finds the sign-in. Core pushes the changes (`executor_sign_in`).
   */
  const signIn = ref<ClaudeSignInView | null>(null)
  const signingIn = computed(() => signIn.value?.state === 'running')
  /** Sign-ins (by `startedAt`) that already ended: a late reply is ignored. */
  const endedSignIns = new Set<number>()
  /**
   * Counts the sign-ins this page saw start: a list read asked before the
   * latest one cannot say that it ended.
   */
  let signInEpoch = 0
  /** Once after the upgrade that deleted a saved Claude token (AGT-12). */
  const signInNotice = ref(false)
  const error = ref('')
  let generation = 0
  let disposed = false
  /** Changes not yet confirmed, applied in order on top of `saved`. */
  const pending: Array<(draft: ExecutorConfig) => void> = []
  let queue: Promise<void> = Promise.resolve()

  // Controls wait for a read, not for saves: changes queue behind a save.
  const busy = computed(() => loading.value)

  const rows = computed(() =>
    (['claude-code', 'codex'] as const).map((backend) => {
      const profiles =
        config.value?.profiles.filter((p) => p.backend === backend) ?? []
      return {
        backend,
        profiles,
        profile:
          profiles.find((p) => p.id === selected.value[backend]) ?? profiles[0],
      }
    }),
  )

  function rowOf(backend: Backend) {
    return rows.value.find((row) => row.backend === backend)!
  }

  function factsOf(profile: ExecutorProfile): ExecutorFacts {
    return {
      probe: probes.value[profile.id] ?? null,
      ...(probeErrors.value[profile.id]
        ? { probeError: probeErrors.value[profile.id] }
        : {}),
      ...(runtimes.value[profile.id]
        ? { runtime: runtimes.value[profile.id] }
        : {}),
      consent: consents.value[profile.id] ?? null,
      loading: loading.value && !probes.value[profile.id],
    }
  }

  /** A profile's default-model choices: what Core found, the custom ones, the current one. */
  function modelOptionsOf(profile: ExecutorProfile, withAdd = false) {
    const rows = new Map(
      (catalogs.value[profile.id]?.models ?? []).map((item) => [
        item.id,
        {
          value: item.id,
          label: item.id,
          description:
            modelSourceName(item.source) +
            (item.name !== item.id ? ' · ' + item.name : ''),
        },
      ]),
    )
    for (const id of profile.customModels ?? [])
      rows.set(id, { value: id, label: id, description: '自定义' })
    if (profile.defaultModel && !rows.has(profile.defaultModel))
      rows.set(profile.defaultModel, {
        value: profile.defaultModel,
        label: profile.defaultModel,
        description: '当前配置',
      })
    return [
      {
        value: '',
        label: '跟随本机 CLI',
        description: '沿用它自己的接入与默认模型',
      },
      ...rows.values(),
      ...(withAdd
        ? [
            {
              value: ADD_CUSTOM_MODEL,
              label: '新增自定义模型…',
              description: '第三方模型 ID 或网关别名',
            },
          ]
        : []),
    ]
  }

  /** A sign-in as Core reports it: running and failed stay on the page. */
  function adoptSignIn(next: ClaudeSignInView | null | undefined) {
    if (!next) return
    if (next.state !== 'running') endedSignIns.add(next.startedAt)
    else if (endedSignIns.has(next.startedAt)) return
    else if (signIn.value?.startedAt !== next.startedAt) signInEpoch++
    signIn.value =
      next.state === 'running' || next.state === 'failed' ? next : null
  }

  /** `epoch`: {@link signInEpoch} when the list was asked for. */
  function adoptFacts(result: ListResult, epoch: number) {
    signInNotice.value = result.signInNotice === true
    if (result.signIn) adoptSignIn(result.signIn)
    else if (signingIn.value && epoch === signInEpoch) {
      // It ended while the page did not hear: ask claude what it says now.
      const ended = signIn.value
      signIn.value = null
      const profile = config.value?.profiles.find(
        (p) => p.id === ended?.profileId,
      )
      if (profile) void recheck(profile)
    }
    runtimes.value = Object.fromEntries(
      result.profiles.map((entry) => [entry.profile.id, entry.runtime]),
    )
    probes.value = Object.fromEntries(
      result.profiles.map((entry) => [entry.profile.id, entry.probe]),
    )
    consents.value = Object.fromEntries(
      result.profiles.map((entry) => [entry.profile.id, entry.consent ?? null]),
    )
  }

  function adoptConfig(next: ExecutorConfig) {
    saved = clone(next)
    const view = clone(next)
    for (const change of pending) change(view)
    config.value = view
  }

  async function loadModelChoices() {
    try {
      const result = await core('model.getConfig')
      if (disposed) return
      models.value = (result?.models ?? []).map((entry) => ({
        value: entry.entryId,
        label: entry.displayName || entry.effectiveDisplayName || entry.modelId,
      }))
    } catch {
      // The choice keeps 跟随对话 and the saved id; the list is a convenience.
    }
  }

  async function loadModels(
    profile: ExecutorProfile,
    refresh = false,
    refreshRuntime = refresh,
  ) {
    if (catalogBusy.value[profile.id]) return
    catalogBusy.value[profile.id] = true
    const identity = JSON.stringify({
      path: profile.executablePath,
      auth: profile.authRef,
    })
    try {
      const value = await listExecutorModels({
        profileId: profile.id,
        ...(refresh ? { refresh: true } : {}),
      })
      const current = config.value?.profiles.find((p) => p.id === profile.id)
      if (
        disposed ||
        !current ||
        JSON.stringify({
          path: current.executablePath,
          auth: current.authRef,
        }) !== identity
      )
        return
      catalogs.value[profile.id] = value
      if (refreshRuntime) {
        const result = await listExecutors()
        if (!disposed && result.config?.revision === config.value?.revision)
          runtimes.value = Object.fromEntries(
            result.profiles.map((entry) => [entry.profile.id, entry.runtime]),
          )
      }
    } catch {
      if (!disposed)
        catalogs.value[profile.id] = {
          profileId: profile.id,
          models: catalogs.value[profile.id]?.models ?? [],
          configuredModel: null,
          provider: null,
          checkedAt: null,
          diagnostic: '模型列表暂时读不到，仍可保留当前选择或新增自定义模型。',
        }
    } finally {
      if (!disposed) catalogBusy.value[profile.id] = false
    }
  }

  async function load(forceProbe = false) {
    if (loading.value) return
    const current = ++generation
    loading.value = true
    error.value = ''
    try {
      const epoch = signInEpoch
      const result = await listExecutors()
      if (current !== generation) return
      pending.length = 0
      if (result.config) adoptConfig(result.config)
      else config.value = null
      adoptFacts(result, epoch)
      probeErrors.value = {}
      for (const profile of config.value?.profiles ?? [])
        void loadModels(profile, forceProbe, false)
      if (result.diagnostic)
        error.value = `${result.diagnostic}；请检查原配置后重新检测。`
      let didProbe = false
      await Promise.all(
        result.profiles
          .filter((entry) => forceProbe || !entry.probe?.localAuthChecked)
          .map(async (entry) => {
            const profile = config.value?.profiles.find(
              (p) => p.id === entry.profile.id,
            )
            if (!profile) return
            const key = JSON.stringify(profile)
            try {
              didProbe = true
              const probe = await probeExecutor({ profileId: profile.id })
              if (
                current === generation &&
                JSON.stringify(
                  config.value?.profiles.find((p) => p.id === profile.id),
                ) === key
              ) {
                probes.value[profile.id] = probe
                if (probe.status === 'available') clearFailedSignIn(profile)
              }
            } catch (cause) {
              if (current === generation)
                probeErrors.value[profile.id] = message(cause)
            }
          }),
      )
      if (didProbe && current === generation) {
        const refreshed = await listExecutors()
        if (current === generation)
          runtimes.value = Object.fromEntries(
            refreshed.profiles.map((entry) => [
              entry.profile.id,
              entry.runtime,
            ]),
          )
      }
    } catch (cause) {
      if (current === generation)
        error.value = `读取子智能体配置失败：${message(cause)}；请重新检测。`
    } finally {
      if (current === generation) loading.value = false
    }
  }

  async function saveNext() {
    if (disposed || !saved || pending.length === 0) return
    const count = pending.length
    const draft = clone(saved)
    for (const change of pending.slice(0, count)) change(draft)
    if (JSON.stringify(draft) === JSON.stringify(saved)) {
      pending.splice(0, count)
      return
    }
    const current = generation
    saving.value = true
    error.value = ''
    try {
      const result = await configureExecutors({
        expectedRevision: draft.revision,
        config: draft,
      })
      if (disposed || current !== generation) return
      pending.splice(0, count)
      adoptConfig(result)
      // Enabling or re-pointing an executor changes what Core can tell.
      const epoch = signInEpoch
      const refreshed = await listExecutors()
      if (disposed || current !== generation) return
      if (refreshed.config?.revision === saved?.revision) {
        adoptFacts(refreshed, epoch)
        probeErrors.value = {}
      }
    } catch (cause) {
      if (disposed || current !== generation) return
      pending.length = 0
      const text = message(cause)
      const code = (cause as { code?: unknown } | null)?.code
      if (code === 'STALE_REVISION' || /STALE_REVISION/.test(text)) {
        await load()
        error.value = '子智能体设置已在别处更新，已重新读取，请再改一次。'
      } else {
        if (saved) config.value = clone(saved)
        error.value = `保存失败：${text}`
      }
    } finally {
      if (current === generation) saving.value = false
    }
  }

  /** Apply a change now and save it (in order with the others). */
  function change(apply: (draft: ExecutorConfig) => void): Promise<void> {
    if (!config.value || !saved) return Promise.resolve()
    pending.push(apply)
    apply(config.value)
    queue = queue.then(saveNext, saveNext)
    return queue
  }

  function changeProfile(
    profileId: string,
    apply: (profile: ExecutorProfile) => void,
  ): Promise<void> {
    return change((draft) => {
      const profile = draft.profiles.find((p) => p.id === profileId)
      if (profile) apply(profile)
    })
  }

  async function refreshFacts() {
    if (
      disposed ||
      busy.value ||
      saving.value ||
      pending.length > 0 ||
      document.hidden ||
      !document.hasFocus()
    )
      return
    try {
      const epoch = signInEpoch
      const result = await listExecutors()
      if (disposed || busy.value || saving.value || pending.length > 0) return
      adoptFacts(result, epoch)
      if (
        result.config &&
        config.value &&
        result.config.revision !== config.value.revision
      )
        adoptConfig(result.config)
    } catch {
      // Keep the last known facts on a transient failure.
    }
  }

  function keySaved(profile: ExecutorProfile, probe: ExecutorProbe) {
    probes.value[profile.id] = probe
    delete probeErrors.value[profile.id]
    // 「读取不到认证」 no longer holds; 刷新模型 lists the account's models.
    const catalog = catalogs.value[profile.id]
    if (catalog) catalogs.value[profile.id] = { ...catalog, diagnostic: null }
  }

  async function clearKey(profile: ExecutorProfile) {
    if (tokenBusy.value) return
    tokenBusy.value = true
    error.value = ''
    try {
      probes.value[profile.id] = (
        await clearExecutorCredential({ profileId: profile.id })
      ).probe
    } catch (cause) {
      error.value = `移除 API Key 失败：${message(cause)}`
    } finally {
      tokenBusy.value = false
    }
  }

  /** A failed sign-in's notice goes once claude is signed in after all. */
  function clearFailedSignIn(profile: ExecutorProfile) {
    if (
      signIn.value?.state === 'failed' &&
      signIn.value.profileId === profile.id
    )
      signIn.value = null
  }

  /**
   * 登录 Claude Code (FIX-11): Core starts claude's own `auth login`; the
   * user signs in in the browser and Core pushes the result.
   */
  async function startSignIn(
    profile: ExecutorProfile,
    method: 'claude-ai' | 'console' = 'claude-ai',
  ) {
    if (tokenBusy.value || signingIn.value) return
    tokenBusy.value = true
    error.value = ''
    try {
      adoptSignIn(
        (await signInExecutor({ profileId: profile.id, method })).signIn,
      )
    } catch (cause) {
      error.value = `没有开始登录：${message(cause)}`
    } finally {
      tokenBusy.value = false
    }
  }

  /** 取消: Core ends claude's sign-in. */
  async function cancelSignIn() {
    const running = signIn.value
    if (!running || running.state !== 'running') return
    try {
      const result = await cancelExecutorSignIn({
        profileId: running.profileId,
      })
      endedSignIns.add(running.startedAt)
      if (signIn.value?.startedAt === running.startedAt)
        signIn.value = result.signIn?.state === 'failed' ? result.signIn : null
    } catch (cause) {
      error.value = `取消登录失败：${message(cause)}`
    }
  }

  /** 重新检测 (after the command in Terminal, or any time): ask claude again. */
  async function recheck(profile: ExecutorProfile) {
    try {
      const probe = await probeExecutor({ profileId: profile.id })
      if (disposed) return
      keySaved(profile, probe)
      if (probe.status === 'available') clearFailedSignIn(profile)
    } catch (cause) {
      if (!disposed) probeErrors.value[profile.id] = message(cause)
    }
  }

  /** What Core pushes while 登录 Claude Code runs and when it ends. */
  function onSignInEvent(event: unknown) {
    const data = event as {
      event?: unknown
      signIn?: ClaudeSignInView
      probe?: ExecutorProbe
    } | null
    if (data?.event !== 'executor_sign_in' || !data.signIn || disposed) return
    const profile = config.value?.profiles.find(
      (p) => p.id === data.signIn!.profileId,
    )
    if (profile && data.probe) keySaved(profile, data.probe)
    adoptSignIn(data.signIn)
    // Signed in, but the check that followed did not answer: ask again.
    if (profile && data.signIn.state === 'signed-in' && !data.probe)
      void recheck(profile)
  }

  async function signOut(profile: ExecutorProfile) {
    if (tokenBusy.value) return
    tokenBusy.value = true
    error.value = ''
    try {
      probes.value[profile.id] = (
        await signOutExecutor({ profileId: profile.id })
      ).probe
      clearFailedSignIn(profile)
    } catch (cause) {
      error.value = `退出登录失败：${message(cause)}`
    } finally {
      tokenBusy.value = false
    }
  }

  async function dismissSignInNotice() {
    signInNotice.value = false
    try {
      await dismissExecutorNotice({ notice: 'claude-sign-in' })
    } catch {
      // Shown again next time; nothing else depends on it.
    }
  }

  /**
   * Emperor is in front again: after a failed sign-in the user may have run
   * the command in Terminal, so that profile is checked first.
   */
  function onFocus() {
    const failed = signIn.value?.state === 'failed' ? signIn.value : null
    const profile =
      failed && config.value?.profiles.find((p) => p.id === failed.profileId)
    if (profile) void recheck(profile)
    else void refreshFacts()
  }

  let timer: ReturnType<typeof setInterval> | undefined
  let unsubscribe: (() => void) | undefined
  onMounted(() => {
    unsubscribe = onCoreEvent(onSignInEvent)
    void load()
    void loadModelChoices()
    timer = setInterval(() => void refreshFacts(), 10_000)
    window.addEventListener('focus', onFocus)
  })
  onBeforeUnmount(() => {
    disposed = true
    unsubscribe?.()
    if (timer) clearInterval(timer)
    window.removeEventListener('focus', onFocus)
    generation++
  })

  return {
    config,
    rows,
    rowOf,
    factsOf,
    runtimes,
    probes,
    catalogs,
    catalogBusy,
    selected,
    models,
    loading,
    saving,
    busy,
    tokenBusy,
    apiKeyDialog,
    signIn,
    signingIn,
    signInNotice,
    error,
    modelOptionsOf,
    load,
    loadModels,
    change,
    changeProfile,
    keySaved,
    clearKey,
    startSignIn,
    cancelSignIn,
    recheck,
    signOut,
    dismissSignInNotice,
  }
}

export type ExecutorSettings = ReturnType<typeof createExecutorSettings>

const KEY: InjectionKey<ExecutorSettings> = Symbol('executor-settings')

export function provideExecutorSettings(): ExecutorSettings {
  const settings = createExecutorSettings()
  provide(KEY, settings)
  return settings
}

export function useExecutorSettings(): ExecutorSettings {
  const settings = inject(KEY)
  if (!settings) throw new Error('useExecutorSettings outside 设置 › 子智能体')
  return settings
}
