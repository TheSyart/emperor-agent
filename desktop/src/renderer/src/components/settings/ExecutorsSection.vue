<script setup lang="ts">
/** Minimal source controls. Hidden settings are round-tripped without edits. */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type {
  ExecutorConfig,
  ExecutorModelCatalog,
  ExecutorProfile,
  ExecutorProbe,
  ExecutorRuntimeFacts,
  NativeCapabilityStatus,
  NativeCapabilityEvidence,
} from '@emperor/core/runtime-contract'
import {
  executorIntroduction,
  executorSpecialties,
} from '@emperor/core/runtime-contract'
import { openExternal } from '../../api/backend'
import {
  listExecutors,
  configureExecutors,
  probeExecutor,
  listExecutorModels,
} from '../../api/delegations'
import {
  SettingsSection,
  TextField,
  Select,
  Switch,
  useSettingsHeader,
} from './ui'
import Button from '../ui/Button.vue'
import SettingsCard from './ui/SettingsCard.vue'
import StatusBadge from './ui/StatusBadge.vue'
import { DsChevronDown, DsRefresh } from '../icons/ds'
import ProviderLogo from '../ui/ProviderLogo.vue'
import SubagentAvatarPreview from '../ui/SubagentAvatarPreview.vue'
const config = ref<ExecutorConfig | null>(null),
  runtimes = ref<Record<string, ExecutorRuntimeFacts | undefined>>({}),
  editingSpecialties = ref<Record<string, boolean>>({}),
  specialtyText = ref<Record<string, string>>({}),
  specialtyErrors = ref<Record<string, string>>({}),
  probes = ref<Record<string, ExecutorProbe | null>>({}),
  probeErrors = ref<Record<string, string>>({}),
  selected = ref<Record<string, string>>({}),
  recovery = ref<Record<string, boolean>>({}),
  loading = ref(false),
  busy = ref(false),
  error = ref(''),
  saved = ref(''),
  reloadRequested = ref(false),
  stale = ref(false)
const catalogs = ref<Record<string, ExecutorModelCatalog | undefined>>({}),
  catalogBusy = ref<Record<string, boolean>>({}),
  modelEditor = ref<Record<string, boolean>>({}),
  modelText = ref<Record<string, string>>({})
let generation = 0,
  disposed = false
let runtimeTimer: ReturnType<typeof setInterval> | undefined
const localIntro =
  'Emperor 内置子智能体，可在独立子会话中并行处理任务，在主会话允许的工具与权限范围内执行，并向主智能体汇报结果。'
const addModelId = '__add_custom_model__'
const modelSourceNames = {
  cli: '本机发现',
  configuration: '本机配置',
  cache: '缓存',
  builtin: '内置参考',
  custom: '自定义',
}
function modelOptions(profile: ExecutorProfile) {
  const rows = new Map(
    (catalogs.value[profile.id]?.models ?? []).map((item) => [
      item.id,
      {
        value: item.id,
        label: item.id,
        description:
          modelSourceNames[item.source] +
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
    { value: '', label: '跟随本机 CLI', description: '沿用当前接入与默认模型' },
    ...rows.values(),
    {
      value: addModelId,
      label: '新增自定义模型…',
      description: '第三方模型 ID 或网关别名',
    },
  ]
}
function selectModel(profile: ExecutorProfile, id: string) {
  if (id === addModelId) {
    modelEditor.value[profile.id] = true
    modelText.value[profile.id] = ''
    return
  }
  if (id) profile.defaultModel = id
  else delete profile.defaultModel
  modelEditor.value[profile.id] = false
}
function modelError(profile: ExecutorProfile) {
  const text = (modelText.value[profile.id] ?? '').trim()
  if (!text) return '请输入模型 ID'
  if (text.length > 256) return '模型 ID 最多 256 字'
  if (
    [...text].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) ||
    text === addModelId
  )
    return '模型 ID 无效'
  if (
    (profile.customModels?.length ?? 0) >= 64 &&
    !profile.customModels?.includes(text)
  )
    return '最多保存 64 个自定义模型'
  return ''
}
function addModel(profile: ExecutorProfile) {
  if (modelError(profile)) return
  const id = modelText.value[profile.id]!.trim()
  profile.customModels = [...new Set([...(profile.customModels ?? []), id])]
  selectModel(profile, id)
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
      !disposed &&
      current &&
      JSON.stringify({
        path: current.executablePath,
        auth: current.authRef,
      }) === identity
    ) {
      catalogs.value[profile.id] = value
      if (refreshRuntime) {
        const result = await listExecutors()
        if (!disposed && result.config?.revision === config.value?.revision)
          runtimes.value = Object.fromEntries(
            result.profiles.map((entry) => [entry.profile.id, entry.runtime]),
          )
      }
    }
  } catch {
    if (!disposed)
      catalogs.value[profile.id] = {
        profileId: profile.id,
        models: catalogs.value[profile.id]?.models ?? [],
        configuredModel: null,
        provider: null,
        checkedAt: null,
        diagnostic: '模型列表暂不可读取，仍可保留当前选择或新增自定义模型。',
      }
  } finally {
    if (!disposed) catalogBusy.value[profile.id] = false
  }
}
function visibleCapabilities(profile: ExecutorProfile) {
  return (['search', 'imageGeneration'] as const).filter(
    (kind) => capability(profile, kind).status !== 'unsupported',
  )
}
function capabilityTone(value: NativeCapabilityStatus) {
  return (
    {
      available: 'ok',
      unavailable: 'error',
      verifying: 'accent',
      stale: 'warn',
      unverified: 'neutral',
      unsupported: 'neutral',
    } as const
  )[value]
}
function readinessTone(profile: ExecutorProfile) {
  if (!profile.enabled) return 'neutral'
  if (hasIssue(profile)) return 'warn'
  return probes.value[profile.id]?.status === 'available' ? 'ok' : 'neutral'
}
async function refreshFacts() {
  if (
    disposed ||
    loading.value ||
    busy.value ||
    document.hidden ||
    !document.hasFocus()
  )
    return
  try {
    const result = await listExecutors()
    if (disposed || loading.value || busy.value) return
    runtimes.value = Object.fromEntries(
      result.profiles.map((entry) => [entry.profile.id, entry.runtime]),
    )
    probes.value = Object.fromEntries(
      result.profiles.map((entry) => [entry.profile.id, entry.probe]),
    )
    if (
      result.config &&
      config.value &&
      result.config.revision !== config.value.revision
    ) {
      if (dirty.value) {
        stale.value = true
        reloadRequested.value = true
        error.value = '配置已在其他位置更新，你的修改已保留。'
      } else {
        config.value = clone(result.config)
        saved.value = JSON.stringify(config.value)
      }
    }
  } catch {
    /* Keep the last known runtime facts on transient failure. */
  }
}
const dirty = computed(
  () => config.value !== null && JSON.stringify(config.value) !== saved.value,
)
const rows = computed(() =>
  (['claude-code', 'codex'] as const).map((backend) => {
    const profiles =
      config.value?.profiles.filter((profile) => profile.backend === backend) ??
      []
    return {
      backend,
      name: backend === 'codex' ? 'Codex' : 'Claude Code',
      profiles,
      profile:
        profiles.find((profile) => profile.id === selected.value[backend]) ??
        profiles[0],
    }
  }),
)
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const message = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause)
const invalidSpecialties = computed(() =>
  Object.values(specialtyErrors.value).some(Boolean),
)
const capabilityLabels: Record<NativeCapabilityStatus, string> = {
  unverified: '未验证',
  verifying: '验证中',
  available: '已验证可用',
  unavailable: '不可用',
  unsupported: '当前接入不支持',
  stale: '验证已失效',
}
function editSpecialties(profile: ExecutorProfile) {
  editingSpecialties.value[profile.id] = !editingSpecialties.value[profile.id]
  specialtyText.value[profile.id] = executorSpecialties(profile).join('，')
}
function updateSpecialties(profile: ExecutorProfile, text: string) {
  specialtyText.value[profile.id] = text
  const items = text
    .split(/[,，、;；\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
  specialtyErrors.value[profile.id] =
    items.length > 6
      ? '最多 6 项专长'
      : items.some((s) => [...s].length > 24)
        ? '每项最多 24 字'
        : ''
  profile.specialties = items
}
function resetSpecialties(profile: ExecutorProfile) {
  delete profile.specialties
  specialtyText.value[profile.id] = executorSpecialties(profile).join('，')
  delete specialtyErrors.value[profile.id]
}
function capability(
  profile: ExecutorProfile,
  kind: 'search' | 'imageGeneration',
): NativeCapabilityEvidence {
  return (
    runtimes.value[profile.id]?.nativeCapabilities[kind] ?? {
      status:
        profile.backend === 'claude-code' && kind === 'imageGeneration'
          ? ('unsupported' as const)
          : ('unverified' as const),
    }
  )
}
function capabilityDetail(
  profile: ExecutorProfile,
  kind: 'search' | 'imageGeneration',
) {
  const fact = capability(profile, kind)
  return [
    fact.checkedAt ? new Date(fact.checkedAt).toLocaleString() : null,
    fact.searchMode === 'live'
      ? '实时搜索'
      : fact.searchMode === 'cached'
        ? '缓存搜索'
        : null,
  ]
    .filter(Boolean)
    .join(' · ')
}
function label(profile: ExecutorProfile) {
  if (!profile.enabled) return '已停用'
  if (loading.value) return '检测中…'
  if (probeErrors.value[profile.id]) return '检测失败'
  const probe = probes.value[profile.id]
  if (!probe) return '未检测'
  if (probe.diagnostic === 'executor version probe failed') return '检测失败'
  if (probe.diagnostic === 'AUTH_REQUIRED') return '需要登录配置'
  if (probe.diagnostic === 'AUTH_ROUTE_UNAVAILABLE') return '凭据不可用'
  return {
    available: '执行器就绪',
    missing: '未找到 CLI',
    needs_auth: '需要登录配置',
    incompatible: '版本不兼容',
    containment_unavailable: '运行环境不可用',
  }[probe.status]
}
function detail(profile: ExecutorProfile) {
  if (probeErrors.value[profile.id])
    return `检测失败：${probeErrors.value[profile.id]}`
  const probe = probes.value[profile.id]
  if (!probe) return ''
  if (probe.diagnostic === 'executor version probe failed')
    return 'CLI 版本检测失败，请检查可执行权限及本机运行环境后重试。'
  if (probe.diagnostic === 'AUTH_ROUTE_UNAVAILABLE')
    return '所选模型凭据不可读，请在模型设置检查原配置。'
  if (probe.status === 'needs_auth' || probe.diagnostic === 'AUTH_REQUIRED')
    return profile.authRef.kind === 'model-route'
      ? '所选模型凭据不可读，请在模型设置检查原配置。'
      : `请在终端运行 ${profile.backend === 'codex' ? 'codex login' : 'claude auth login'}。${profile.backend === 'claude-code' ? 'Emperor 需要可读取的 CLI 文件或环境变量认证；仅钥匙串登录不可用。官方订阅可运行 claude setup-token，并将令牌设为 CLAUDE_CODE_OAUTH_TOKEN；无需改用 API 计费。' : ''}配置完成后重新检测。`
  if (probe.status === 'missing')
    return '未找到 CLI，请检查本机安装或更正路径后保存。'
  if (probe.status === 'incompatible')
    return `CLI 版本不兼容：实际 ${probe.executableVersion ?? '未知'}，预期 ${profile.expectedVersion}。请检查本机 CLI 版本。`
  if (probe.status === 'containment_unavailable')
    return '本机运行环境不可用，请检查 CLI 运行环境后重试。'
  return ''
}
function hasIssue(profile: ExecutorProfile) {
  return (
    !!probeErrors.value[profile.id] ||
    (!!probes.value[profile.id] &&
      probes.value[profile.id]!.status !== 'available')
  )
}
async function load(forceProbe = false, discard = false) {
  if (loading.value || busy.value) return
  if (dirty.value && !discard) {
    reloadRequested.value = true
    return
  }
  const current = ++generation
  loading.value = true
  error.value = ''
  reloadRequested.value = false
  try {
    const result = await listExecutors()
    if (current !== generation) return
    config.value = clone(result.config)
    editingSpecialties.value = {}
    specialtyErrors.value = {}
    specialtyText.value = {}
    runtimes.value = Object.fromEntries(
      result.profiles.map((entry) => [entry.profile.id, entry.runtime]),
    )
    saved.value = JSON.stringify(config.value)
    for (const profile of config.value?.profiles ?? [])
      void loadModels(profile, forceProbe, false)
    stale.value = false
    probes.value = Object.fromEntries(
      result.profiles.map((entry) => [entry.profile.id, entry.probe]),
    )
    probeErrors.value = {}
    if (result.diagnostic)
      error.value = `${result.diagnostic}；请检查原配置后重新检测。`
    let didProbe = false
    await Promise.all(
      result.profiles
        .filter((entry) => forceProbe || !entry.probe?.localAuthChecked)
        .map(async (entry) => {
          const profile = config.value?.profiles.find(
            (profile) => profile.id === entry.profile.id,
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
            )
              probes.value[profile.id] = probe
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
          refreshed.profiles.map((entry) => [entry.profile.id, entry.runtime]),
        )
    }
  } catch (cause) {
    if (current === generation)
      error.value = `读取配置失败：${message(cause)}；请重新检测。`
  } finally {
    if (current === generation) loading.value = false
  }
}
async function installHelp(profile: ExecutorProfile) {
  try {
    await openExternal(
      profile.backend === 'codex'
        ? 'https://learn.chatgpt.com/docs/codex/cli'
        : 'https://code.claude.com/docs/en/setup',
    )
  } catch {
    error.value = '无法打开安装说明，请检查系统浏览器后重试。'
  }
}
async function save() {
  if (
    busy.value ||
    loading.value ||
    !config.value ||
    !dirty.value ||
    invalidSpecialties.value ||
    stale.value
  )
    return
  const current = ++generation,
    draft = clone(config.value)
  busy.value = true
  error.value = ''
  try {
    const result = await configureExecutors({
      expectedRevision: draft.revision,
      config: draft,
    })
    if (current !== generation) return
    config.value = clone(result)
    saved.value = JSON.stringify(config.value)
    const refreshed = await listExecutors()
    if (current !== generation) return
    if (refreshed.config?.revision !== result.revision) {
      stale.value = true
      reloadRequested.value = true
      error.value = '配置已在其他位置更新，请重新读取。'
      return
    }
    probes.value = Object.fromEntries(
      refreshed.profiles.map((entry) => [entry.profile.id, entry.probe]),
    )
    runtimes.value = Object.fromEntries(
      refreshed.profiles.map((entry) => [entry.profile.id, entry.runtime]),
    )
    probeErrors.value = {}
    reloadRequested.value = false
  } catch (cause) {
    if (current !== generation) return
    error.value = message(cause)
    if (error.value.includes('STALE_REVISION')) {
      stale.value = true
      reloadRequested.value = true
    }
  } finally {
    if (current === generation) busy.value = false
  }
}
useSettingsHeader({
  actions: () => [
    {
      id: 'detect-executors',
      label: loading.value ? '检测中…' : '重新检测',
      onClick: () => load(true),
      disabled: loading.value || busy.value,
      busy: loading.value,
    },
    {
      id: 'save-executors',
      label: '保存配置',
      kind: 'primary',
      onClick: save,
      disabled:
        busy.value ||
        loading.value ||
        !dirty.value ||
        stale.value ||
        invalidSpecialties.value,
      busy: busy.value,
    },
  ],
})
onMounted(() => {
  void load()
  runtimeTimer = setInterval(() => void refreshFacts(), 10000)
  window.addEventListener('focus', refreshFacts)
})
onBeforeUnmount(() => {
  disposed = true
  if (runtimeTimer) clearInterval(runtimeTimer)
  window.removeEventListener('focus', refreshFacts)
  generation++
})
</script>
<template>
  <SettingsSection intro="主会话统一派工；能力状态以当前模型与运行验证为准。">
    <p v-if="error" class="executor-error message" role="alert">{{ error }}</p>
    <p v-if="loading && !config" class="executor-note" role="status">
      正在读取子智能体配置…
    </p>
    <div v-if="reloadRequested" class="reload-notice message" role="status">
      <span>有未保存的修改。重新读取会丢弃这些修改。</span
      ><Button
        size="sm"
        variant="outline"
        data-discard-executor-edits
        :disabled="busy || loading"
        @click="load(true, true)"
        >丢弃修改并重新读取</Button
      >
    </div>
    <div class="agent-cards">
      <SettingsCard class="agent-card local-card" data-settings-agent="local">
        <template #leading><SubagentAvatarPreview /></template
        ><template #title><h3>本地</h3></template
        ><template #meta
          ><StatusBadge tone="accent">内置</StatusBadge></template
        >
        <template #description
          ><span>{{ localIntro }}</span></template
        >
        <div class="local-features">
          <span
            v-for="text in ['独立子会话', '并行分工', '进度汇报']"
            :key="text"
            ><i />{{ text }}</span
          >
        </div>
      </SettingsCard>
      <SettingsCard
        v-for="row in rows"
        :key="row.backend"
        class="agent-card external-card"
        :data-settings-agent="row.backend"
      >
        <template #leading
          ><ProviderLogo
            :icon-id="row.backend"
            :label="row.name"
            size="lg" /></template
        ><template #title
          ><h3>{{ row.name }}</h3></template
        >
        <template #meta
          ><StatusBadge
            class="readiness"
            :tone="row.profile ? readinessTone(row.profile) : 'neutral'"
            >{{
              row.profile ? label(row.profile) : loading ? '读取中…' : '未配置'
            }}</StatusBadge
          ></template
        >
        <template #description
          ><span data-executor-introduction>{{
            executorIntroduction(row.backend)
          }}</span></template
        >
        <template #actions
          ><Switch
            v-if="row.profile"
            v-model="row.profile.enabled"
            data-executor-enabled
            :disabled="busy || loading"
            :aria-label="`启用 ${row.name}`"
        /></template>
        <template v-if="row.profile">
          <div v-if="row.profiles.length > 1" class="profile-choice">
            <span>使用配置</span
            ><Select
              :model-value="row.profile.id"
              :options="row.profiles.map((p) => ({ value: p.id, label: p.id }))"
              size="sm"
              data-executor-profile
              :aria-label="`${row.name} 配置`"
              :disabled="busy || loading"
              @change="selected[row.backend] = $event"
            />
          </div>
          <div v-if="hasIssue(row.profile)" class="message recovery-message">
            <p role="status">{{ detail(row.profile) }}</p>
            <div class="inline-actions">
              <Button
                v-if="probes[row.profile.id]?.status === 'missing'"
                size="sm"
                variant="ghost"
                data-executor-install-help
                @click="installHelp(row.profile)"
                >安装说明</Button
              ><Button
                size="sm"
                variant="ghost"
                :disabled="busy || loading"
                @click="load(true)"
                >重试</Button
              ><Button
                size="sm"
                variant="ghost"
                data-executor-recovery
                @click="recovery[row.profile.id] = !recovery[row.profile.id]"
                >更正路径</Button
              >
            </div>
            <TextField
              v-if="recovery[row.profile.id]"
              v-model="row.profile.executablePath"
              :aria-label="`${row.name} 可执行文件路径`"
              :disabled="busy || loading"
              autocomplete="off"
            />
          </div>
          <div class="specialty-block">
            <div class="block-heading">
              <span>派工专长</span>
              <div class="inline-actions">
                <Button
                  v-if="editingSpecialties[row.profile.id]"
                  size="sm"
                  variant="ghost"
                  data-reset-specialties
                  :disabled="busy || loading"
                  @click="resetSpecialties(row.profile)"
                  >恢复默认</Button
                ><Button
                  size="sm"
                  variant="ghost"
                  data-edit-specialties
                  :disabled="busy || loading"
                  @click="editSpecialties(row.profile)"
                  >{{
                    editingSpecialties[row.profile.id] ? '收起编辑' : '编辑专长'
                  }}</Button
                >
              </div>
            </div>
            <div class="specialty-tags" data-specialties>
              <StatusBadge
                v-for="(text, i) in executorSpecialties(row.profile)"
                :key="i"
                class="specialty-tag"
                >{{ text }}</StatusBadge
              ><span
                v-if="!executorSpecialties(row.profile).length"
                class="muted"
                >未设置专长</span
              >
            </div>
            <div
              v-if="editingSpecialties[row.profile.id]"
              class="specialty-editor"
            >
              <TextField
                :model-value="specialtyText[row.profile.id]"
                data-specialty-input
                :aria-label="`${row.name} 专长`"
                :invalid="!!specialtyErrors[row.profile.id]"
                :disabled="busy || loading"
                placeholder="逗号分隔，最多 6 项，每项 24 字"
                @update:model-value="updateSpecialties(row.profile, $event)"
              />
              <p
                v-if="specialtyErrors[row.profile.id]"
                class="field-error"
                role="alert"
              >
                {{ specialtyErrors[row.profile.id] }}
              </p>
              <p v-else class="field-hint">
                专长用于派工偏好，可清空；不会启用额外工具。
              </p>
            </div>
          </div>
          <div class="runtime-summary">
            <div class="default-model-block">
              <div class="block-heading">
                <span>默认模型</span
                ><Button
                  size="sm"
                  variant="ghost"
                  data-refresh-models
                  :aria-label="`刷新 ${row.name} 模型`"
                  :disabled="catalogBusy[row.profile.id] || busy || loading"
                  @click="loadModels(row.profile, true)"
                  ><DsRefresh :size="12" />{{
                    catalogBusy[row.profile.id] ? '获取中…' : '刷新模型'
                  }}</Button
                >
              </div>
              <Select
                :model-value="row.profile.defaultModel ?? ''"
                :options="modelOptions(row.profile)"
                :aria-label="`${row.name} 默认模型`"
                data-default-model
                :disabled="busy || loading"
                @update:model-value="selectModel(row.profile, $event ?? '')"
              />
              <div
                v-if="modelEditor[row.profile.id]"
                class="custom-model-editor"
              >
                <TextField
                  v-model="modelText[row.profile.id]"
                  data-custom-model-input
                  :aria-label="`${row.name} 自定义模型 ID`"
                  :disabled="busy || loading"
                  placeholder="提供方的模型 ID，如 team/coder-v2"
                  autocomplete="off"
                  @keydown.enter.prevent="addModel(row.profile)"
                  @keydown.esc="modelEditor[row.profile.id] = false"
                />
                <div class="custom-model-actions">
                  <p
                    :class="
                      modelText[row.profile.id] && modelError(row.profile)
                        ? 'field-error'
                        : 'field-hint'
                    "
                  >
                    {{
                      modelText[row.profile.id] && modelError(row.profile)
                        ? modelError(row.profile)
                        : '添加后可复用，随顶部配置一起保存。'
                    }}
                  </p>
                  <div class="inline-actions">
                    <Button
                      size="sm"
                      variant="ghost"
                      @click="modelEditor[row.profile.id] = false"
                      >取消</Button
                    ><Button
                      size="sm"
                      variant="outline"
                      data-add-custom-model
                      :disabled="busy || loading || !!modelError(row.profile)"
                      @click="addModel(row.profile)"
                      >添加</Button
                    >
                  </div>
                </div>
              </div>
              <p class="field-hint">
                沿用本机 CLI 的连接与认证；更换模型后，下次派工生效。
              </p>
              <p
                v-if="catalogs[row.profile.id]?.diagnostic"
                class="field-hint"
                role="status"
              >
                {{ catalogs[row.profile.id]?.diagnostic }}
              </p>
            </div>
            <div class="model-line">
              <span>最近运行模型</span
              ><span
                class="model-value"
                data-reported-model
                :title="runtimes[row.profile.id]?.modelSource ?? ''"
                >{{ runtimes[row.profile.id]?.reportedModel ?? '未知' }}</span
              >
            </div>
            <div
              v-if="visibleCapabilities(row.profile).length"
              class="ability-list"
            >
              <div
                v-for="kind in visibleCapabilities(row.profile)"
                :key="kind"
                class="ability-item"
              >
                <span>{{ kind === 'search' ? '搜索' : '生图' }}</span
                ><StatusBadge
                  :tone="capabilityTone(capability(row.profile, kind).status)"
                  :data-native-capability="kind"
                  :data-status="capability(row.profile, kind).status"
                  :title="capabilityDetail(row.profile, kind)"
                  >{{
                    capabilityLabels[capability(row.profile, kind).status]
                  }}</StatusBadge
                >
              </div>
            </div>
          </div>
          <details class="agent-details">
            <summary><span>查看详情</span><DsChevronDown :size="14" /></summary>
            <div class="details-content">
              <dl>
                <div>
                  <dt>认证来源</dt>
                  <dd>
                    {{
                      row.profile.authRef.kind === 'managed-cli-login'
                        ? probes[row.profile.id]?.localAuthChecked
                          ? '本机登录配置可读'
                          : '本机 CLI 配置'
                        : '已有模型配置'
                    }}
                  </dd>
                </div>
                <div>
                  <dt>CLI 版本</dt>
                  <dd>
                    {{ probes[row.profile.id]?.executableVersion ?? '未知' }}
                  </dd>
                </div>
                <div>
                  <dt>配置模型</dt>
                  <dd>
                    {{
                      row.profile.defaultModel ??
                      catalogs[row.profile.id]?.configuredModel ??
                      runtimes[row.profile.id]?.configuredModel ??
                      '跟随本机 CLI'
                    }}
                  </dd>
                </div>
                <div>
                  <dt>模型来源</dt>
                  <dd>
                    {{ runtimes[row.profile.id]?.modelSource ?? '尚无运行报告'
                    }}<span v-if="runtimes[row.profile.id]?.provider">
                      · {{ runtimes[row.profile.id]?.provider }}</span
                    >
                  </dd>
                </div>
                <div>
                  <dt>提供方</dt>
                  <dd>{{ catalogs[row.profile.id]?.provider ?? '未知' }}</dd>
                </div>
                <div v-if="runtimes[row.profile.id]?.observedAt">
                  <dt>报告时间</dt>
                  <dd>
                    {{
                      new Date(
                        runtimes[row.profile.id]!.observedAt!,
                      ).toLocaleString()
                    }}
                  </dd>
                </div>
                <div>
                  <dt>模型列表</dt>
                  <dd>
                    {{
                      catalogs[row.profile.id]?.checkedAt
                        ? new Date(
                            catalogs[row.profile.id]!.checkedAt!,
                          ).toLocaleString()
                        : '尚未获取'
                    }}
                    · 候选与内置参考不代表账号已获授权
                  </dd>
                </div>
                <div>
                  <dt>宿主开放工具</dt>
                  <dd>
                    {{
                      runtimes[row.profile.id]?.hostAllowedTools?.join('、') ||
                      '未知'
                    }}
                  </dd>
                </div>
                <div>
                  <dt>运行时公布</dt>
                  <dd>
                    {{
                      runtimes[row.profile.id]?.advertisedTools?.join('、') ||
                      '未知'
                    }}
                  </dd>
                </div>
                <div>
                  <dt>实际调用</dt>
                  <dd>
                    {{
                      runtimes[row.profile.id]?.observedTools?.join('、') ||
                      '尚未观察到'
                    }}
                  </dd>
                </div>
                <div
                  v-for="kind in visibleCapabilities(row.profile)"
                  :key="kind"
                >
                  <dt>{{ kind === 'search' ? '搜索验证' : '生图验证' }}</dt>
                  <dd>
                    {{ capabilityDetail(row.profile, kind) || '尚无验证记录'
                    }}<span v-if="capability(row.profile, kind).runId">
                      · {{ capability(row.profile, kind).runId }}</span
                    >
                  </dd>
                </div>
              </dl>
              <div v-if="!hasIssue(row.profile)" class="connection-settings">
                <div class="block-heading">
                  <span>连接配置</span
                  ><Button
                    size="sm"
                    variant="ghost"
                    data-executor-recovery
                    @click="
                      recovery[row.profile.id] = !recovery[row.profile.id]
                    "
                    >更正路径</Button
                  >
                </div>
                <TextField
                  v-if="recovery[row.profile.id]"
                  v-model="row.profile.executablePath"
                  :aria-label="`${row.name} 可执行文件路径`"
                  :disabled="busy || loading"
                />
              </div>
            </div>
          </details>
        </template>
      </SettingsCard>
    </div>
  </SettingsSection>
</template>
<style scoped>
.agent-cards {
  display: flex;
  flex-direction: column;
  gap: var(--space-3-5);
  padding-top: var(--space-3);
}
.agent-card.ds-settings-card {
  background: rgb(var(--bg-layer-2));
  border-color: var(--border-l2);
  box-shadow: none;
}
.agent-card :deep(.head) {
  align-items: flex-start;
  padding: var(--space-4) var(--space-4) var(--space-3-5);
  gap: var(--space-3);
}
.agent-card :deep(.leading) {
  margin-top: calc(var(--space-0-5) / 2);
}
.agent-card :deep(.head-text) {
  gap: var(--space-2);
}
.agent-card :deep(.title) {
  overflow: visible;
  white-space: normal;
}
.agent-card h3 {
  font-size: var(--fs-s);
  line-height: 22px;
  font-weight: 600;
  letter-spacing: 0.05px;
}
.agent-card :deep(.title-line) {
  gap: var(--space-2);
}
.agent-card :deep(.description) {
  font-size: var(--fs-xs);
  line-height: 21px;
  color: rgb(var(--label-secondary));
  text-wrap: pretty;
}
.agent-card :deep(.actions) {
  padding-top: var(--space-0-5);
}
.agent-card .readiness {
  font-size: var(--fs-xxxs);
  padding: calc(var(--space-0-5) / 2) var(--space-2);
  line-height: 16px;
}
.agent-card :deep(.body[data-after-head]) {
  margin: 0 var(--space-4);
  padding: var(--space-3) 0 var(--space-3);
  gap: var(--space-3);
  border-color: var(--border-l1);
}
.local-card :deep(.body[data-after-head]) {
  border-top: none;
  padding-top: 0;
}
.local-features {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2-5) var(--space-5);
  color: rgb(var(--label-tertiary));
  font-size: var(--fs-xxs);
  line-height: 20px;
  padding-left: calc(var(--space-8) + var(--space-5));
}
.local-features span {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
}
.local-features i {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: rgb(var(--accent-fill));
}
.block-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  color: rgb(var(--label-tertiary));
  font-size: var(--fs-xxs);
  line-height: 20px;
  min-height: 22px;
}
.inline-actions {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  flex-wrap: wrap;
}
.inline-actions .ds-button {
  gap: var(--space-1);
  font-size: var(--fs-xxs);
  min-height: 24px;
  height: auto;
  padding: var(--space-0-5) var(--space-1);
}
.specialty-tags {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1-5);
  margin-top: var(--space-2);
  min-width: 0;
}
.specialty-tag.ds-status-badge {
  flex: 0 1 auto;
  font-size: var(--fs-xxs);
  font-weight: 400;
  border-radius: var(--radius-sm);
  padding: var(--space-0-5) var(--space-2);
  min-height: 24px;
  line-height: 18px;
  white-space: normal;
  overflow-wrap: anywhere;
  background: var(--interactive-bg-hover);
  color: rgb(var(--label-secondary));
  overflow: visible;
}
.specialty-editor {
  display: flex;
  flex-direction: column;
  gap: var(--space-1-5);
  margin-top: var(--space-2-5);
}
.field-hint,
.field-error {
  font-size: var(--fs-xxs);
  line-height: 20px;
  color: rgb(var(--label-tertiary));
}
.field-error {
  color: rgb(var(--state-error-label));
}
.runtime-summary {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.default-model-block {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.default-model-choice {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  min-width: 0;
}
.default-model-choice > span {
  flex: none;
  font-size: var(--fs-xxs);
  color: rgb(var(--label-tertiary));
}
.default-model-choice .ds-select {
  flex: 1;
  width: 0;
  height: 30px;
  border-radius: var(--radius-row);
  background: var(--interactive-bg-hover);
}
.custom-model-editor {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-2-5);
  border: 1px solid var(--border-l1);
  border-radius: var(--radius-row);
}
.custom-model-actions {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  flex-wrap: wrap;
  gap: var(--space-2);
}
.custom-model-actions > p {
  flex: 1;
  min-width: 140px;
}
.custom-model-actions .inline-actions {
  flex: none;
}
.model-pending {
  color: rgb(var(--label-tertiary));
}
.model-line {
  display: flex;
  align-items: baseline;
  gap: var(--space-4);
  min-width: 0;
  font-size: var(--fs-xxs);
  line-height: 20px;
}
.model-line > span:first-child {
  color: rgb(var(--label-tertiary));
  white-space: nowrap;
  flex: none;
}
.model-value {
  min-width: 0;
  overflow-wrap: anywhere;
  color: rgb(var(--label-secondary));
  font-family: 'SFMono-Regular', Menlo, 'PingFang SC', monospace;
  font-size: var(--fs-xxs);
}
.ability-list {
  display: flex;
  gap: var(--space-3) var(--space-5);
  flex-wrap: wrap;
}
.ability-item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  color: rgb(var(--label-tertiary));
  font-size: var(--fs-xxs);
  line-height: 20px;
}
.ability-item .ds-status-badge {
  font-size: var(--fs-xxxs);
  min-height: 21px;
  font-weight: 450;
  line-height: 17px;
  border-radius: var(--radius-sm);
  padding: var(--space-0-5) var(--space-2);
  white-space: normal;
  overflow-wrap: anywhere;
}
.agent-details {
  border-top: calc(var(--space-0-5) / 2) solid var(--border-l1);
  padding-top: var(--space-2-5);
  min-width: 0;
}
.agent-details summary {
  display: flex;
  justify-content: space-between;
  align-items: center;
  list-style: none;
  color: rgb(var(--label-tertiary));
  font-size: var(--fs-xxs);
  line-height: 20px;
  cursor: pointer;
}
.agent-details summary::-webkit-details-marker {
  display: none;
}
.agent-details summary:hover {
  color: rgb(var(--label-primary));
}
.agent-details summary svg {
  transition: transform var(--duration-ds) var(--ease-in-out);
}
.agent-details[open] summary svg {
  transform: rotate(180deg);
}
.details-content {
  padding-top: var(--space-3);
  display: flex;
  flex-direction: column;
  gap: var(--space-3-5);
  font-size: var(--fs-xxs);
  line-height: 20px;
}
.details-content dl {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin: 0;
}
.details-content dl > div {
  display: grid;
  grid-template-columns: 90px minmax(0, 1fr);
  gap: var(--space-3);
}
.details-content dt {
  color: rgb(var(--label-tertiary));
}
.details-content dd {
  margin: 0;
  min-width: 0;
  overflow-wrap: anywhere;
  color: rgb(var(--label-secondary));
}
.connection-settings {
  border-top: calc(var(--space-0-5) / 2) solid var(--border-l1);
  padding-top: var(--space-2);
}
.connection-settings .ds-text-field {
  margin-top: var(--space-2);
}
.message {
  border-radius: var(--radius-row);
  padding: var(--space-3) var(--space-3);
  font-size: var(--fs-xxs);
  line-height: 20px;
  margin-bottom: var(--space-3);
}
.agent-card .message {
  margin-bottom: 0;
}
.recovery-message {
  background: rgb(var(--state-warn-soft));
  color: rgb(var(--state-warn-label));
}
.recovery-message .inline-actions {
  margin: var(--space-2) 0 0;
}
.recovery-message .ds-text-field {
  margin-top: var(--space-2);
}
.error-message {
  background: rgb(var(--state-error-soft));
  color: rgb(var(--state-error-label));
}
.discard-message {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2-5);
  background: var(--interactive-bg-hover);
  color: rgb(var(--label-secondary));
}
.muted {
  color: rgb(var(--label-tertiary));
  font-size: var(--fs-xxs);
  line-height: 20px;
}
.profile-choice {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--space-3);
  font-size: var(--fs-xxs);
  color: rgb(var(--label-tertiary));
}
.profile-choice .ds-select {
  width: 170px;
}
@container executor-section (max-width:460px) {
  .settings-layout {
    flex-direction: column;
  }
  .settings-header {
    padding: var(--space-2-5) var(--space-3-5) var(--space-2-5)
      calc(var(--space-4) + var(--space-0-5));
  }
  .settings-options {
    padding: 0 calc(var(--space-4) + var(--space-0-5))
      calc(var(--space-4) + var(--space-0-5));
  }
  .agent-card :deep(.head) {
    padding: var(--space-3-5) var(--space-3);
    gap: var(--space-2-5);
  }
  .agent-card :deep(.body[data-after-head]) {
    margin: 0 var(--space-3);
    padding-bottom: var(--space-3);
  }
  .profile-choice {
    flex-direction: column;
    align-items: stretch;
  }
  .profile-choice .ds-select {
    width: 100%;
  }
  .local-features {
    padding-left: 0;
    gap: var(--space-2) var(--space-3-5);
  }
  .details-content dl > div {
    grid-template-columns: 80px minmax(0, 1fr);
    gap: var(--space-2);
  }
  .ability-list {
    gap: var(--space-2) var(--space-4);
  }
  .agent-card :deep(.title-line) {
    gap: var(--space-1);
  }
  .agent-card :deep(.head-text) {
    gap: var(--space-1-5);
  }
  .agent-card .readiness {
    font-size: var(--fs-xxxs);
  }
}

.agent-cards {
  container-type: inline-size;
  container-name: executor-section;
}
.executor-error {
  color: rgb(var(--state-error-label));
}
.executor-note {
  color: rgb(var(--label-tertiary));
  font-size: var(--fs-xxs);
}
.reload-notice {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-2-5);
  background: var(--interactive-bg-hover);
}
.default-model-block > .ds-select {
  width: 100%;
  height: 32px;
  border-radius: var(--radius-row);
  background: var(--interactive-bg-hover);
}
.default-model-block > .block-heading .ds-button {
  font-size: var(--fs-xxs);
  min-height: 24px;
  padding: var(--space-0-5) var(--space-1);
}
</style>
