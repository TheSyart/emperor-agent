<script setup lang="ts">
/**
 * 设置 › 子智能体 (AGT-10): the conclusion first, details on demand.
 *
 * - The main page: one card with the three subagents (本地, Claude Code,
 *   Codex — status, model, on/off; a missing sign-in fills the row with its
 *   reason and 登录 Claude Code, AGT-12, which Core runs and the user
 *   finishes in the browser, FIX-11) and one card with the three task
 *   settings (同时运行, 改代码的位置, 费用上限), then 高级.
 * - Sub pages: 高级 (turns, run time, 开发环境, 排查) and each external
 *   subagent's 详情 (status, sign-in, model, specialties, capabilities in
 *   plain words).
 *
 * Every change is saved at once (executors/useExecutorSettings.ts); the
 * header keeps only 重新检测.
 *
 * Versions (AGT-13): opening the page asks npm what is new (at most once a
 * minute). A new version shows at the top (「Claude Code 和 Codex 有新版
 * 本」 · 稍后 · 全部升级), as 「本机 x · 可升级到 y」 and 升级 on its row,
 * and as a dot on 子智能体 in the nav; 升级 asks first
 * (ExecutorUpgradeDialog), then runs in the row (升级中, a bar, 查看过程,
 * 取消) and ends in a toast or a failure notice with the command to copy.
 */
import {
  computed,
  defineAsyncComponent,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from 'vue'
import type { ExecutorProfile } from '@emperor/core/runtime-contract'
import Avatar from '../ui/Avatar.vue'
import Badge from '../ui/Badge.vue'
import Button from '../ui/Button.vue'
import IconButton from '../ui/IconButton.vue'
import SubagentAvatarPreview from '../ui/SubagentAvatarPreview.vue'
import { DsChevronRight } from '../icons/ds'
import {
  Notice,
  Select,
  SettingsGroup,
  SettingsLinkRow,
  SettingsRow,
  SettingsSection,
  Switch,
  useSettingsHeader,
} from './ui'
import { useSettingsPages } from './settingsHeader'
import ClaudeSignInNotice from './executors/ClaudeSignInNotice.vue'
import ExecutorAdvancedPage from './executors/ExecutorAdvancedPage.vue'
import ExecutorDetailPage from './executors/ExecutorDetailPage.vue'
import ExecutorUpgradeDialog from './executors/ExecutorUpgradeDialog.vue'
import ExecutorUpgradeNotice from './executors/ExecutorUpgradeNotice.vue'
import ExecutorUpgradeProgress from './executors/ExecutorUpgradeProgress.vue'
import {
  executorName,
  hasIssue,
  needsSignIn,
  readyLead,
  rowReady,
  rowSummary,
  statusLabel,
  statusTone,
} from './executors/executorText'
import { useExecutorUpgrades } from './executors/executorUpgrades'
import {
  activeRun,
  failedRun,
  rowUpgradeLine,
  runningLine,
  upgradeOffered,
} from './executors/upgradeText'
import { provideExecutorSettings } from './executors/useExecutorSettings'

// 使用 API Key (AGT-12) loads when it is opened.
const ClaudeApiKeyDialog = defineAsyncComponent(
  () => import('./ClaudeApiKeyDialog.vue'),
)

const s = provideExecutorSettings()
const { config, rows, models, busy, loading, apiKeyDialog } = s
const { page, open: openPage } = useSettingsPages({
  advanced: '高级',
  'claude-code': 'Claude Code',
  codex: 'Codex',
})

const detailBackend = computed(() =>
  page.value === 'claude-code' || page.value === 'codex' ? page.value : null,
)

// ── 本地子智能体 ────────────────────────────────────────────────────────

const localModel = computed(() => config.value?.localSubagentModel ?? '')
const localModelOptions = computed(() => {
  const options = [
    { value: '', label: '跟随对话', description: '使用当前对话的模型' },
    ...models.value.map((choice) => ({ ...choice })),
  ]
  if (
    localModel.value &&
    !models.value.some((choice) => choice.value === localModel.value)
  )
    options.push({
      value: localModel.value,
      label: `${localModel.value}（已删除）`,
      description: '这条模型配置已删除，暂时按对话的模型运行',
    })
  return options
})
const localSummary = computed(() => {
  if (!localModel.value) return '使用当前对话的模型，始终可用'
  const choice = models.value.find((c) => c.value === localModel.value)
  return choice
    ? `使用「${choice.label}」，始终可用`
    : '选定的模型已删除，暂时使用当前对话的模型'
})
function setLocalModel(value: string | null | undefined) {
  void s.change((draft) => {
    if (value) draft.localSubagentModel = value
    else delete draft.localSubagentModel
  })
}

// ── Claude Code / Codex ────────────────────────────────────────────────

function signInNeeded(profile: ExecutorProfile | undefined) {
  return !!profile && needsSignIn(profile, s.factsOf(profile))
}
function showsModel(profile: ExecutorProfile | undefined) {
  return (
    !!profile?.enabled &&
    !signInNeeded(profile) &&
    !hasIssue(s.factsOf(profile))
  )
}
/** 登录 Claude Code running, or failed, for the row's profile (FIX-11). */
const claudeSignIn = computed(() => {
  const profile = s.rowOf('claude-code').profile
  const signIn = s.signIn.value
  return profile && signIn?.profileId === profile.id
    ? { profile, signIn }
    : null
})
function setEnabled(profile: ExecutorProfile, on: boolean) {
  void s.changeProfile(profile.id, (p) => {
    p.enabled = on
  })
}
function setModel(profile: ExecutorProfile, id: string | null | undefined) {
  void s.changeProfile(profile.id, (p) => {
    if (id) p.defaultModel = id
    else delete p.defaultModel
  })
}

// ── 版本与升级 (AGT-13) ───────────────────────────────────────────────

const upgrades = useExecutorUpgrades()
const now = ref(Date.now())
const logOpen = ref<Record<string, boolean>>({})
const runOf = (profile: ExecutorProfile) => upgrades.runOf(profile.id)
const upgrading = (profile: ExecutorProfile | undefined) =>
  !!profile?.enabled && activeRun(upgrades.runOf(profile.id))
/** The line under the name: while it upgrades, then with the version. */
function summaryOf(profile: ExecutorProfile): {
  text: string
  highlight?: string
} {
  const facts = s.factsOf(profile)
  const run = runOf(profile)
  if (profile.enabled && activeRun(run))
    return { text: runningLine(run, now.value) }
  const version = upgrades.versionOf(profile.id)
  return version && rowReady(profile, facts)
    ? rowUpgradeLine(readyLead(profile, facts), version, run, now.value)
    : { text: rowSummary(profile, facts) }
}
function offers(profile: ExecutorProfile) {
  return (
    profile.enabled &&
    upgradeOffered(upgrades.versionOf(profile.id), runOf(profile))
  )
}
/** 重新检测 after the command in Terminal: probe, then the versions again. */
async function recheckUpgrade(profileId: string) {
  const profile = config.value?.profiles.find((p) => p.id === profileId)
  if (profile) await s.recheck(profile)
  await upgrades.load()
}
let ticking: ReturnType<typeof setInterval> | undefined
let stopProbes: (() => void) | undefined
onMounted(() => {
  void upgrades.load('auto')
  ticking = setInterval(() => {
    now.value = Date.now()
  }, 1000)
  // The probe Core took after an upgrade: the row and the models follow.
  stopProbes = upgrades.onProbe((profileId, probe) => {
    const profile = config.value?.profiles.find((p) => p.id === profileId)
    if (!profile) return
    s.keySaved(profile, probe)
    void s.loadModels(profile, true)
  })
})
onBeforeUnmount(() => {
  clearInterval(ticking)
  stopProbes?.()
})
// Installed versions come from the probes: read again once they are in.
watch(loading, (isLoading, wasLoading) => {
  if (wasLoading && !isLoading) void upgrades.load()
})

// ── 子任务 ────────────────────────────────────────────────────────────

const concurrencyOptions = [1, 2, 3, 4].map((n) => ({
  value: String(n),
  label: `${n} 个`,
}))
const workspace = computed(
  () => config.value?.defaultWorkspace ?? 'isolated-worktree',
)
const workspaceOptions = [
  {
    value: 'isolated-worktree',
    label: '独立工作树',
    description: '验证后再合并回项目',
  },
  {
    value: 'shared-exclusive',
    label: '当前工作区',
    description: '直接改项目，期间主会话不能同时改',
  },
]
const workspaceDescription = computed(() =>
  workspace.value === 'shared-exclusive'
    ? 'Claude Code、Codex 直接改当前工作区；改完之前，主会话不能同时修改文件'
    : 'Claude Code、Codex 在独立的 Git 工作树里改，你看过差异后再应用到项目',
)
const budgetOptions = computed(() => {
  const current = config.value?.limits.estimatedBudgetUsd ?? 10
  return [...new Set([1, 2, 5, 10, current])]
    .sort((a, b) => a - b)
    .map((n) => ({ value: String(n), label: `$${n}` }))
})
function setConcurrency(value: string | null | undefined) {
  const n = Number(value)
  if (!Number.isInteger(n) || n < 1 || n > 4) return
  void s.change((draft) => {
    draft.limits.globalConcurrency = n
  })
}
function setWorkspace(value: string | null | undefined) {
  void s.change((draft) => {
    if (value === 'shared-exclusive') draft.defaultWorkspace = value
    else delete draft.defaultWorkspace
  })
}
function setBudget(value: string | null | undefined) {
  const n = Number(value)
  if (!(n > 0 && n <= 10)) return
  void s.change((draft) => {
    draft.limits.estimatedBudgetUsd = n
  })
}

/** Acknowledge the upgrade notice: any save clears it (AGT-05). */
function dismissNotice() {
  void s.change((draft) => {
    delete draft.upgradeNotice
  })
}

useSettingsHeader({
  actions: () => [
    {
      id: 'detect-executors',
      label: loading.value ? '检测中…' : '重新检测',
      onClick: () => s.load(true),
      disabled: busy.value,
      busy: loading.value,
    },
  ],
})
</script>

<template>
  <SettingsSection
    v-if="page === null"
    intro="Emperor 可以把子任务交给本地子智能体，或交给你电脑上已登录的 Claude Code、Codex。主任务、权限和验证始终由 Emperor 负责。"
  >
    <Notice
      v-if="s.error.value"
      tone="error"
      :title="s.error.value"
      data-executor-error
    />
    <p v-if="loading && !config" class="executor-note" role="status">
      正在读取子智能体配置…
    </p>
    <Notice
      v-if="config?.upgradeNotice === 'external-default-off'"
      tone="info"
      title="Claude Code 和 Codex 现在默认关闭"
      data-executor-upgrade-notice
    >
      它们会使用你自己的订阅额度或 API
      计费。升级前它们按旧版默认开启，你没有改过这项设置，所以已关闭；需要时在下面打开，第一次把任务交给它们前会在对话里征得你的同意。
      <template #actions>
        <Button
          size="sm"
          variant="secondary"
          data-dismiss-upgrade-notice
          :disabled="busy"
          @click="dismissNotice"
          >知道了</Button
        >
      </template>
    </Notice>

    <Notice
      v-if="s.signInNotice.value"
      tone="info"
      title="Claude Code 现在用它自己的登录"
      data-claude-sign-in-notice
    >
      请点「登录 Claude Code」登录一次。之前在 Emperor
      里设置的令牌已删除；Emperor 不读取、不保存你的 Claude 登录。
      <template #actions>
        <Button
          size="sm"
          variant="secondary"
          data-dismiss-sign-in-notice
          @click="s.dismissSignInNotice()"
          >知道了</Button
        >
      </template>
    </Notice>
    <ClaudeSignInNotice
      v-if="claudeSignIn"
      :sign-in="claudeSignIn.signIn"
      :busy="busy"
      @cancel="s.cancelSignIn()"
      @recheck="s.recheck(claudeSignIn.profile)"
    />
    <Notice
      v-if="upgrades.error.value"
      tone="error"
      :title="upgrades.error.value"
      data-upgrade-error
    />
    <ExecutorUpgradeNotice @recheck="recheckUpgrade" />

    <SettingsGroup title="可用的子智能体" data-executor-list>
      <SettingsRow
        title="本地子智能体"
        :description="localSummary"
        data-settings-agent="local"
      >
        <template #leading><SubagentAvatarPreview :size="28" /></template>
        <Select
          :model-value="localModel"
          :options="localModelOptions"
          size="sm"
          data-local-model
          aria-label="本地子智能体使用的模型"
          :disabled="!config || busy"
          @update:model-value="setLocalModel"
        />
      </SettingsRow>
      <SettingsRow
        v-for="row in rows"
        :key="row.backend"
        :title="executorName(row.backend)"
        :data-settings-agent="row.backend"
        :data-needs-sign-in="signInNeeded(row.profile) || undefined"
      >
        <template #leading
          ><Avatar
            kind="logo"
            :icon-id="row.backend"
            :label="executorName(row.backend)"
            :size="28"
        /></template>
        <template #badge
          ><Badge v-if="upgrading(row.profile)" class="readiness" tone="accent"
            >升级中</Badge
          ><Badge
            v-else
            class="readiness"
            :tone="
              row.profile
                ? statusTone(row.profile, s.factsOf(row.profile))
                : 'neutral'
            "
            >{{
              row.profile
                ? statusLabel(row.profile, s.factsOf(row.profile))
                : loading
                  ? '读取中…'
                  : '未配置'
            }}</Badge
          ></template
        >
        <template #description
          ><span v-if="row.profile" data-executor-summary
            >{{ summaryOf(row.profile).text
            }}<template v-if="summaryOf(row.profile).highlight"
              >{{ ' · '
              }}<span class="offer" data-upgrade-offer>{{
                summaryOf(row.profile).highlight
              }}</span></template
            ></span
          ><span v-else data-executor-summary
            >没有这个子智能体的配置</span
          ></template
        >
        <template v-if="row.profile && upgrading(row.profile)" #below
          ><ExecutorUpgradeProgress
            :log="runOf(row.profile)?.log ?? []"
            bar
            :show-log="!!logOpen[row.profile.id]"
        /></template>
        <div class="row-controls">
          <Button
            v-if="row.profile && offers(row.profile)"
            size="sm"
            variant="secondary"
            data-executor-upgrade
            @click="upgrades.ask([row.profile.id])"
            >{{
              failedRun(upgrades.versionOf(row.profile.id), runOf(row.profile))
                ? '重试'
                : '升级'
            }}</Button
          >
          <template v-if="row.profile && upgrading(row.profile)">
            <Button
              size="sm"
              variant="ghost"
              data-upgrade-show-log
              :aria-expanded="!!logOpen[row.profile.id]"
              @click="logOpen[row.profile.id] = !logOpen[row.profile.id]"
              >{{ logOpen[row.profile.id] ? '收起过程' : '查看过程' }}</Button
            ><Button
              size="sm"
              variant="ghost"
              data-upgrade-cancel
              @click="upgrades.cancel(row.profile.id)"
              >取消</Button
            >
          </template>
          <Button
            v-if="row.profile && signInNeeded(row.profile)"
            size="sm"
            variant="secondary"
            data-claude-sign-in-start
            :disabled="busy || s.tokenBusy.value || s.signingIn.value"
            @click="s.startSignIn(row.profile)"
            >登录 Claude Code</Button
          >
          <Select
            v-else-if="row.profile && showsModel(row.profile)"
            :model-value="row.profile.defaultModel ?? ''"
            :options="s.modelOptionsOf(row.profile)"
            size="sm"
            data-row-model
            :aria-label="`${executorName(row.backend)} 默认模型`"
            :disabled="busy"
            @update:model-value="setModel(row.profile, $event)"
          />
          <Switch
            v-if="row.profile"
            :model-value="row.profile.enabled"
            data-executor-enabled
            :aria-label="`启用 ${executorName(row.backend)}`"
            :disabled="busy"
            @update:model-value="setEnabled(row.profile, $event)"
          />
          <IconButton
            :label="`${executorName(row.backend)} 详情`"
            size="sm"
            data-executor-details
            @click="openPage(row.backend)"
            ><DsChevronRight :size="16"
          /></IconButton>
        </div>
      </SettingsRow>
    </SettingsGroup>

    <SettingsGroup v-if="config" title="子任务" data-executor-task-settings>
      <SettingsRow
        title="同时运行"
        description="Claude Code 和 Codex 合计；超过后排队等候"
      >
        <Select
          :model-value="String(config.limits.globalConcurrency)"
          :options="concurrencyOptions"
          size="sm"
          data-global-concurrency
          aria-label="同时运行的子任务数"
          :disabled="busy"
          @update:model-value="setConcurrency"
        />
      </SettingsRow>
      <SettingsRow title="改代码的位置" :description="workspaceDescription">
        <Select
          :model-value="workspace"
          :options="workspaceOptions"
          size="sm"
          data-default-workspace
          aria-label="改代码的位置"
          :disabled="busy"
          @update:model-value="setWorkspace"
        />
      </SettingsRow>
      <SettingsRow
        title="单个任务的费用上限"
        description="按 API 计费时的估算费用；订阅额度不计费用"
      >
        <Select
          :model-value="String(config.limits.estimatedBudgetUsd)"
          :options="budgetOptions"
          size="sm"
          data-task-budget
          aria-label="单个任务的费用上限"
          :disabled="busy"
          @update:model-value="setBudget"
        />
      </SettingsRow>
      <SettingsLinkRow
        title="高级"
        description="最多轮数、运行时长、开发环境与排查"
        data-executor-advanced-link
        @click="openPage('advanced')"
      />
    </SettingsGroup>
  </SettingsSection>
  <ExecutorAdvancedPage v-else-if="page === 'advanced'" />
  <ExecutorDetailPage
    v-else-if="detailBackend"
    :backend="detailBackend"
    @recheck-upgrade="recheckUpgrade"
  />
  <ExecutorUpgradeDialog
    v-if="upgrades.asking.value"
    :profile-ids="upgrades.asking.value"
    @close="upgrades.asking.value = null"
  />
  <ClaudeApiKeyDialog
    v-if="apiKeyDialog"
    :profile-id="apiKeyDialog.id"
    @close="apiKeyDialog = null"
    @saved="
      (probe) => {
        if (apiKeyDialog) s.keySaved(apiKeyDialog, probe)
        apiKeyDialog = null
      }
    "
  />
</template>

<style scoped>
.executor-note {
  margin: 0;
  font-size: var(--fs-xs);
  color: rgb(var(--text-3));
}
.row-controls {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.readiness {
  font-size: var(--fs-xxxs);
}
.offer {
  color: rgb(var(--accent));
  white-space: nowrap;
}
</style>
