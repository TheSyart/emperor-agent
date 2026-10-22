<script setup lang="ts">
/**
 * Settings › 记忆 (UI-S07). The main page: the collapsed 「上下文概览」 card,
 * then a Segmented switch over the two editors, 长期记忆 and 用户档案 (each
 * a MemoryEditorPane + fill CodeEditor, ⌘S saves). The editor toolbar's
 * 「历史」 opens the version list (sub page `history`: snapshots with an
 * inline diff and 「恢复」). 情景记忆 and Watchlist, which few people edit,
 * are sub pages one menu away (header 「更多」). The header carries the
 * open editor's 保存 (Watchlist also 「手动检查」); there is no refresh:
 * memory reloads by itself after every turn.
 *
 * Drafts (ui/useDirtyGuard): every editor keeps its draft while the user
 * switches tabs or sub pages; a background reload only replaces a draft
 * nobody edited. Leaving the section or closing settings with an edited
 * draft asks first (the guard SettingsModal provides).
 *
 * Data: `boot.memory` (memory.get) for 长期 / 情景 / Watchlist / 历史 and
 * `configContent` (config.get → memory/profile/USER.local.md) for 用户档案.
 */
import { computed, ref, watch } from 'vue'
import { useAppContext } from '../../composables/useAppContext'
import { DsMore } from '../icons/ds'
import Button from '../ui/Button.vue'
import { useDirtyGuard, useDraft } from '../ui/useDirtyGuard'
import {
  DefinitionList,
  EmptyState,
  Segmented,
  Select,
  SettingsGroup,
  SettingsRow,
  SettingsSection,
  Badge,
  type SelectOption,
  type SettingsHeaderAction,
} from './ui'
import { useSettingsHeader, useSettingsPages } from './settingsHeader'
import MemoryContextOverview from './memory/MemoryContextOverview.vue'
import MemoryEditorPane from './memory/MemoryEditorPane.vue'
import MemoryVersionList from './memory/MemoryVersionList.vue'
import {
  MEMORY_PAGES,
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
const { page, open: openPage } = useSettingsPages(MEMORY_PAGES)

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

// ── 长期记忆 ────────────────────────────────────────────────────────────
const longTerm = useDraft(() => longTermContent(memory.value))
const longTermDirty = computed(() => !build.value && longTerm.dirty.value)

function saveLongTerm() {
  if (build.value) return
  return act(() => ctx.saveMemory(longTerm.text.value))
}

// ── 用户档案 ────────────────────────────────────────────────────────────
const profile = useDraft(() => ctx.configContent.value)
const profileLoaded = ref(Boolean(ctx.configContent.value))
const onboarding = computed(() => ctx.boot.value?.profileOnboarding)

function loadProfile() {
  return act(async () => {
    await ctx.loadConfig()
    profileLoaded.value = true
  })
}

function saveProfile() {
  return act(() => ctx.saveConfig(profile.text.value))
}

// ── 情景记忆 (sub page) ─────────────────────────────────────────────────
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

// ── Watchlist (sub page) ────────────────────────────────────────────────
const watchlist = useDraft(() => memory.value?.watchlist?.content || '')
const decisionFacts = computed(() =>
  watchlistFacts(memory.value?.watchlist?.lastDecision),
)

function saveWatchlist() {
  return act(() => ctx.saveWatchlist(watchlist.text.value))
}

function checkWatchlist() {
  return act(async () => {
    await ctx.checkWatchlist()
    await ctx.refreshMemory(false)
  })
}

// ── 历史 (sub page) ─────────────────────────────────────────────────────
const versions = computed(() => memory.value?.versions?.versions || [])

function restoreVersion(id: string) {
  return act(async () => {
    await ctx.restoreMemoryVersion(id)
    await ctx.refreshMemory(false)
  })
}

// ── unsaved edits ───────────────────────────────────────────────────────
useDirtyGuard('长期记忆', longTermDirty)
useDirtyGuard('用户档案', profile.dirty)
useDirtyGuard('情景记忆', episodeDirty)
useDirtyGuard('Watchlist', watchlist.dirty)

// ── tabs / header ───────────────────────────────────────────────────────
watch(
  [tab, page],
  ([value, current]) => {
    if (current === null && value === 'profile' && !profileLoaded.value)
      void loadProfile()
    if (current === 'episodes' && !episode.value && episodes.value[0])
      void openEpisode(episodeDate(episodes.value[0]))
  },
  { immediate: true },
)

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
    const actions: SettingsHeaderAction[] = []
    if (!memory.value) return actions
    if (page.value === 'episodes')
      actions.push(saveAction(saveEpisode, episodeDirty.value, !episode.value))
    else if (page.value === 'watchlist')
      actions.push(
        {
          id: 'check-watchlist',
          label: '手动检查',
          kind: 'secondary',
          disabled: busy.value,
          onClick: checkWatchlist,
        },
        saveAction(saveWatchlist, watchlist.dirty.value),
      )
    else if (page.value === null) {
      // Build project memory is read-only: no save at all.
      if (tab.value === 'long_term' && !build.value)
        actions.push(saveAction(saveLongTerm, longTermDirty.value))
      else if (tab.value === 'profile')
        actions.push(saveAction(saveProfile, profile.dirty.value))
      actions.push({
        id: 'more',
        label: '更多',
        kind: 'icon',
        icon: DsMore,
        menu: [
          {
            id: 'episodes',
            label: MEMORY_PAGES.episodes,
            description: '每天的对话摘要',
            onSelect: () => openPage('episodes'),
          },
          {
            id: 'watchlist',
            label: MEMORY_PAGES.watchlist,
            description: '定时检查的关注事项',
            onSelect: () => openPage('watchlist'),
          },
        ],
      })
    }
    return actions
  },
})
</script>

<template>
  <SettingsSection fill>
    <EmptyState
      v-if="!memory"
      title="暂无记忆数据"
      description="本地 Agent 服务就绪后会显示长期记忆、用户档案与版本历史。"
      framed
    />

    <SettingsGroup v-else-if="page === 'history'" plain data-page="history">
      <MemoryVersionList
        :versions="versions"
        :load-version="ctx.loadMemoryVersion"
        :busy="busy"
        @restore="restoreVersion"
      />
    </SettingsGroup>

    <SettingsGroup
      v-else-if="page === 'episodes'"
      fill
      plain
      data-page="episodes"
    >
      <EmptyState
        v-if="!episodes.length"
        title="还没有情景记忆"
        description="每天的对话摘要会按日期写入情景记忆。"
        framed
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
        variant="inline"
      >
        <Select
          v-if="!episodeLoading"
          v-model="episodeChoice"
          :options="episodeOptions"
          size="sm"
          aria-label="选择日期"
        />
      </EmptyState>
    </SettingsGroup>

    <SettingsGroup
      v-else-if="page === 'watchlist'"
      fill
      plain
      data-page="watchlist"
    >
      <MemoryEditorPane
        v-model="watchlist.text.value"
        :path="WATCHLIST_PATH"
        note="定时任务会周期检查 Watchlist；「手动检查」立即让模型判断是否需要主动执行。"
        :dirty="watchlist.dirty.value"
        placeholder="- [ ] 需要持续关注的事项"
        @save="saveWatchlist"
      >
        <DefinitionList
          v-if="decisionFacts.length"
          class="decision"
          :items="decisionFacts"
        />
      </MemoryEditorPane>
    </SettingsGroup>

    <template v-else>
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
      <SettingsGroup fill plain :data-tab="tab">
        <MemoryEditorPane
          v-if="tab === 'long_term'"
          v-model="longTerm.text.value"
          :path="longTermPath(memory)"
          :note="longTermNote(memory)"
          :readonly="build"
          :dirty="longTermDirty"
          placeholder="写下 Agent 应长期记住的偏好、约定与事实。"
          @save="saveLongTerm"
        >
          <template #toolbar>
            <Button
              size="sm"
              variant="ghost"
              data-testid="memory-history"
              @click="openPage('history')"
              >历史</Button
            >
          </template>
        </MemoryEditorPane>

        <MemoryEditorPane
          v-else
          v-model="profile.text.value"
          :path="USER_PROFILE_PATH"
          note="用户偏好与档案；保存后刷新 Agent 上下文。"
          :dirty="profile.dirty.value"
          @save="saveProfile"
        >
          <template #toolbar>
            <Button
              size="sm"
              variant="ghost"
              data-testid="memory-history"
              @click="openPage('history')"
              >历史</Button
            >
          </template>
          <SettingsRow
            class="interview"
            title="个人档案访谈"
            description="由 Agent 通过几个问题补全称呼、偏好与工作方式。"
            dense
            :divider="false"
          >
            <Badge
              :tone="onboardingTone(onboarding?.status)"
              variant="dot-label"
            >
              {{ onboardingLabel(onboarding?.status) }}
            </Badge>
            <Button
              v-if="onboarding?.canStart"
              size="sm"
              variant="secondary"
              @click="ctx.runSafely(() => ctx.startProfileInterview())"
            >
              {{ onboarding.status === 'skipped' ? '重新开始' : '开始访谈' }}
            </Button>
          </SettingsRow>
        </MemoryEditorPane>
      </SettingsGroup>
    </template>
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
  border: 1px solid var(--stroke-1);
  border-radius: var(--radius-row);
  background: rgb(var(--surface-raised));
}

.decision {
  padding: var(--space-2-5) var(--space-3);
  border: 1px solid var(--stroke-1);
  border-radius: var(--radius-row);
  background: rgb(var(--surface-raised));
}
</style>
