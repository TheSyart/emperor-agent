<script setup lang="ts">
/**
 * Settings › 记忆 — native section. Top: the collapsed 「上下文概览」 card
 * (context / history / compaction / runtime / maintenance facts). Then a
 * Segmented switch over 长期 / 用户档案 / 情景 / Watchlist / 版本; the
 * editor tabs take the remaining height (MemoryEditorPane + fill
 * CodeEditor, ⌘S saves), 版本 lists snapshots with an inline diff and
 * 「恢复」. The header carries refresh plus the active tab's actions
 * (保存; Watchlist also 「手动检查」).
 *
 * Data: `boot.memory` (memory.get) for 长期 / 情景 / Watchlist / 版本 and
 * `configContent` (config.get → memory/profile/USER.local.md) for 用户档案.
 */
import { computed, ref, watch } from 'vue'
import { useAppContext } from '../../composables/useAppContext'
import Button from '../ui/Button.vue'
import {
  DefinitionList,
  EmptyState,
  Segmented,
  Select,
  SettingsGroup,
  SettingsRow,
  SettingsSection,
  StatusBadge,
  type SelectOption,
  type SettingsHeaderAction,
} from './ui'
import { refreshAction, useSettingsHeader } from './settingsHeader'
import MemoryContextOverview from './memory/MemoryContextOverview.vue'
import MemoryEditorPane from './memory/MemoryEditorPane.vue'
import MemoryVersionList from './memory/MemoryVersionList.vue'
import {
  MEMORY_TABS,
  USER_PROFILE_PATH,
  WATCHLIST_PATH,
  episodeDate,
  isBuildContext,
  longTermContent,
  longTermNote,
  longTermPath,
  onboardingLabel,
  onboardingTone,
  sortedEpisodes,
  watchlistFacts,
  type MemoryTab,
} from './memory/memoryModel'

const ctx = useAppContext()
const tab = ref<MemoryTab>('long_term')
const busy = ref(false)

const memory = computed(() => ctx.boot.value?.memory || null)
const build = computed(() => isBuildContext(memory.value))

async function act(task: () => Promise<void>) {
  busy.value = true
  try {
    await ctx.runSafely(task)
  } finally {
    busy.value = false
  }
}

// ── 长期 ────────────────────────────────────────────────────────────────
const longTermSource = computed(() => longTermContent(memory.value))
const longTermDraft = ref('')
watch(
  longTermSource,
  (value) => {
    longTermDraft.value = value
  },
  { immediate: true },
)
const longTermDirty = computed(
  () => !build.value && longTermDraft.value !== longTermSource.value,
)

function saveLongTerm() {
  if (build.value) return
  return act(() => ctx.saveMemory(longTermDraft.value))
}

// ── 用户档案 ────────────────────────────────────────────────────────────
const profileDraft = ref('')
const profileLoaded = ref(Boolean(ctx.configContent.value))
watch(
  () => ctx.configContent.value,
  (value) => {
    profileDraft.value = value
  },
  { immediate: true },
)
const profileDirty = computed(
  () => profileDraft.value !== ctx.configContent.value,
)
const onboarding = computed(() => ctx.boot.value?.profileOnboarding)

function loadProfile() {
  return act(async () => {
    await ctx.loadConfig()
    profileLoaded.value = true
  })
}

function saveProfile() {
  return act(() => ctx.saveConfig(profileDraft.value))
}

// ── 情景 ────────────────────────────────────────────────────────────────
const episodes = computed(() => sortedEpisodes(memory.value))
const episodeOptions = computed<SelectOption[]>(() =>
  episodes.value.map((path) => ({
    value: episodeDate(path),
    label: episodeDate(path),
  })),
)
const episode = ref<{ date: string; content: string } | null>(null)
const episodeDraft = ref('')
const episodeLoading = ref(false)
const episodeDirty = computed(
  () => Boolean(episode.value) && episodeDraft.value !== episode.value?.content,
)
const episodeChoice = computed({
  get: () => episode.value?.date ?? '',
  set: (date: string) => {
    void openEpisode(date)
  },
})

async function openEpisode(date: string) {
  if (!date) return
  episodeLoading.value = true
  try {
    await ctx.runSafely(async () => {
      const data = await ctx.loadEpisode(date)
      episode.value = data
      episodeDraft.value = data.content
    })
  } finally {
    episodeLoading.value = false
  }
}

function saveEpisode() {
  const current = episode.value
  if (!current) return
  const content = episodeDraft.value
  return act(async () => {
    await ctx.saveEpisode(current.date, content)
    episode.value = { date: current.date, content }
  })
}

watch(episodes, (list) => {
  const current = episode.value
  if (current && !list.some((path) => episodeDate(path) === current.date))
    episode.value = null
})

// ── Watchlist ───────────────────────────────────────────────────────────
const watchlistSource = computed(() => memory.value?.watchlist?.content || '')
const watchlistDraft = ref('')
watch(
  watchlistSource,
  (value) => {
    watchlistDraft.value = value
  },
  { immediate: true },
)
const watchlistDirty = computed(
  () => watchlistDraft.value !== watchlistSource.value,
)
const decisionFacts = computed(() =>
  watchlistFacts(memory.value?.watchlist?.lastDecision),
)

function saveWatchlist() {
  return act(() => ctx.saveWatchlist(watchlistDraft.value))
}

function checkWatchlist() {
  return act(async () => {
    await ctx.checkWatchlist()
    await ctx.refreshMemory(false)
  })
}

// ── 版本 ────────────────────────────────────────────────────────────────
const versions = computed(() => memory.value?.versions?.versions || [])

function restoreVersion(id: string) {
  return act(async () => {
    await ctx.restoreMemoryVersion(id)
    await ctx.refreshMemory(false)
  })
}

// ── tabs / header ───────────────────────────────────────────────────────
watch(
  tab,
  (value) => {
    if (value === 'profile' && !profileLoaded.value) void loadProfile()
    if (value === 'episodes' && !episode.value && episodes.value[0])
      void openEpisode(episodeDate(episodes.value[0]))
  },
  { immediate: true },
)

function refresh() {
  return act(async () => {
    await ctx.refreshMemory(true)
    if (tab.value === 'profile') await ctx.loadConfig()
  })
}

function saveAction(
  onClick: () => unknown,
  dirty: boolean,
  disabled = false,
): SettingsHeaderAction {
  return {
    id: 'save',
    label: '保存',
    kind: 'primary',
    disabled: disabled || busy.value || !dirty,
    title: dirty ? '保存（⌘S）' : '没有未保存的修改',
    onClick,
  }
}

useSettingsHeader({
  actions: () => {
    const actions: SettingsHeaderAction[] = [
      refreshAction(() => refresh(), { title: '刷新记忆' }),
    ]
    if (!memory.value) return actions
    // Build project memory is read-only: no save at all.
    if (tab.value === 'long_term' && !build.value)
      actions.push(saveAction(saveLongTerm, longTermDirty.value))
    else if (tab.value === 'profile')
      actions.push(saveAction(saveProfile, profileDirty.value))
    else if (tab.value === 'episodes')
      actions.push(saveAction(saveEpisode, episodeDirty.value, !episode.value))
    else if (tab.value === 'watchlist')
      actions.push(
        {
          id: 'check-watchlist',
          label: '手动检查',
          kind: 'secondary',
          disabled: busy.value,
          onClick: checkWatchlist,
        },
        saveAction(saveWatchlist, watchlistDirty.value),
      )
    return actions
  },
})
</script>

<template>
  <SettingsSection fill>
    <MemoryContextOverview class="overview" :memory="memory" />
    <div class="tabs">
      <Segmented
        v-model="tab"
        :options="MEMORY_TABS"
        size="md"
        block
        aria-label="记忆类型"
      />
    </div>

    <EmptyState
      v-if="!memory"
      title="暂无记忆数据"
      description="本地 Agent 服务就绪后会显示长期记忆、情景记忆与版本快照。"
    />
    <SettingsGroup v-else fill :data-tab="tab">
      <MemoryEditorPane
        v-if="tab === 'long_term'"
        v-model="longTermDraft"
        :path="longTermPath(memory)"
        :note="longTermNote(memory)"
        :readonly="build"
        :dirty="longTermDirty"
        placeholder="写下 Agent 应长期记住的偏好、约定与事实。"
        @save="saveLongTerm"
      />

      <MemoryEditorPane
        v-else-if="tab === 'profile'"
        v-model="profileDraft"
        :path="USER_PROFILE_PATH"
        note="用户偏好与档案；保存后刷新 Agent 上下文。"
        :dirty="profileDirty"
        @save="saveProfile"
      >
        <SettingsRow
          class="interview"
          title="个人档案访谈"
          description="由 Agent 通过几个问题补全称呼、偏好与工作方式。"
          dense
          :divider="false"
        >
          <StatusBadge :tone="onboardingTone(onboarding?.status)" dot>
            {{ onboardingLabel(onboarding?.status) }}
          </StatusBadge>
          <Button
            v-if="onboarding?.canStart"
            size="sm"
            variant="outline"
            @click="ctx.runSafely(() => ctx.startProfileInterview())"
          >
            {{ onboarding.status === 'skipped' ? '重新开始' : '开始访谈' }}
          </Button>
        </SettingsRow>
      </MemoryEditorPane>

      <template v-else-if="tab === 'episodes'">
        <EmptyState
          v-if="!episodes.length"
          title="还没有情景记忆"
          description="每天的对话摘要会按日期写入情景记忆。"
        />
        <MemoryEditorPane
          v-else-if="episode"
          v-model="episodeDraft"
          :path="`情景记忆 · ${episode.date}.md`"
          note="按日期保存的情景记忆；保存后刷新记忆统计。"
          :dirty="episodeDirty"
          @save="saveEpisode"
        >
          <template #toolbar>
            <Select
              v-model="episodeChoice"
              :options="episodeOptions"
              size="sm"
              aria-label="选择日期"
              :disabled="episodeLoading"
            />
          </template>
        </MemoryEditorPane>
        <EmptyState
          v-else
          :title="episodeLoading ? '加载情景记忆中…' : '选择一个日期'"
          variant="plain"
          compact
        >
          <Select
            v-if="!episodeLoading"
            v-model="episodeChoice"
            :options="episodeOptions"
            size="sm"
            aria-label="选择日期"
          />
        </EmptyState>
      </template>

      <MemoryEditorPane
        v-else-if="tab === 'watchlist'"
        v-model="watchlistDraft"
        :path="WATCHLIST_PATH"
        note="Scheduler 会周期检查 Watchlist；「手动检查」立即让模型判断是否需要主动执行。"
        :dirty="watchlistDirty"
        placeholder="- [ ] 需要持续关注的事项"
        @save="saveWatchlist"
      >
        <DefinitionList
          v-if="decisionFacts.length"
          class="decision"
          :items="decisionFacts"
        />
      </MemoryEditorPane>

      <MemoryVersionList
        v-else
        :versions="versions"
        :load-version="ctx.loadMemoryVersion"
        :busy="busy"
        @restore="restoreVersion"
      />
    </SettingsGroup>
  </SettingsSection>
</template>

<style scoped>
.overview {
  margin-top: var(--space-1);
}

.tabs {
  padding-top: var(--space-3);
}

.interview {
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--border-l1);
  border-radius: var(--radius-row);
  background: rgb(var(--bg-layer-2));
}

.decision {
  padding: var(--space-2-5) var(--space-3);
  border: 1px solid var(--border-l1);
  border-radius: var(--radius-row);
  background: rgb(var(--bg-layer-2));
}
</style>
