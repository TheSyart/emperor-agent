<script setup lang="ts">
/**
 * ExplorePage — the /explore full page (探索): the curated catalog
 * (exploreCatalog.json, shipped with the app) as a card grid, with a search
 * field and 全部 / Skills / MCP / 插件 filter chips.
 *
 * 「安装」 never installs by itself; it opens the flow the 插件 page uses,
 * prefilled, and the person confirms there:
 * - Skill  → SkillImportDialog on its URL tab (`skills.import` url source);
 * - MCP    → McpAddDialog with the entry's JSON (dry-run preview, then 导入);
 * - Plugin → PluginInstallDialog on the URL (`plugins.inspect` → preview →
 *   `plugins.install`); URL Plugins stay inactive until their signature
 *   verifies.
 * A Skill or MCP entry that is already present reads 「已安装」.
 */
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { openExternal } from '../../../api/backend'
import { listSkills } from '../../../api/skills'
import type { McpImportResult } from '../../../api/mcp'
import { useAppContext } from '../../../composables/useAppContext'
import { useSession } from '../../../composables/useSession'
import type { BootstrapPayload } from '../../../types'
import Button from '../../ui/Button.vue'
import Chip from '../../ui/Chip.vue'
import { EmptyState, SearchField } from '../../settings/ui'
import McpAddDialog from '../../settings/mcp/McpAddDialog.vue'
import { mcpImportSummary } from '../../settings/mcp/mcpModel'
import PluginInstallDialog from '../../settings/plugins/PluginInstallDialog.vue'
import { usePluginInstall } from '../../settings/plugins/pluginInstall'
import SkillImportDialog from '../../settings/skills/SkillImportDialog.vue'
import {
  skillProject,
  skillScopeOptions,
  skillSessionId,
  skillImportToast,
  type SkillImportSummary,
} from '../../settings/skills/skillsModel'
import PageShell from '../PageShell.vue'
import ExploreCard from './ExploreCard.vue'
import catalog from './exploreCatalog.json'
import {
  EXPLORE_FILTERS,
  exploreEntryInstalled,
  exploreKindCounts,
  filterExploreEntries,
  mcpEntryConfigText,
  validExploreEntries,
  type ExploreEntry,
  type ExploreFilter,
} from './exploreModel'

const ctx = useAppContext()
const sessions = useSession()
const router = useRouter()

const entries = validExploreEntries(catalog)
const counts = exploreKindCounts(entries)

const query = ref('')
const filter = ref<ExploreFilter>('all')
const visible = computed(() =>
  filterExploreEntries(entries, { query: query.value, filter: filter.value }),
)

const installedState = computed(() => ({
  skills: (ctx.boot.value?.skills ?? []).map((skill) => skill.name),
  mcpServers: (ctx.boot.value?.mcp?.servers ?? []).map(
    (server) => server.serverName,
  ),
}))

// ── Skill: URL import ────────────────────────────────────────────────────
const skillOpen = ref(false)
const skillUrl = ref('')
const sessionId = computed(() => skillSessionId(ctx.sessionId.value))
const scopeOptions = computed(() =>
  skillScopeOptions(
    skillProject(
      sessions.sessions.value.find(
        (session) => session.id === ctx.sessionId.value,
      ),
    ),
  ),
)

// ── MCP: prefilled add dialog ────────────────────────────────────────────
const mcpOpen = ref(false)
const mcpText = ref('')

// ── Plugin: URL inspect → install ────────────────────────────────────────
const pluginFlow = usePluginInstall({
  onInstalled: async (preview) => {
    ctx.showToast(`已安装「${preview.name}」（签名验证通过前不会激活）`)
    await ctx.refreshAll()
  },
})

function install(entry: ExploreEntry) {
  const source = entry.install
  if ('skillUrl' in source) {
    skillUrl.value = source.skillUrl
    skillOpen.value = true
  } else if ('mcpConfig' in source) {
    mcpText.value = mcpEntryConfigText(entry)
    mcpOpen.value = true
  } else {
    pluginFlow.openUrl(source.pluginUrl)
  }
}

function openHomepage(entry: ExploreEntry) {
  void ctx.runSafely(() => openExternal(entry.homepage))
}

async function reloadSkills() {
  const result = await listSkills({ sessionId: sessionId.value })
  const boot = ctx.boot.value
  if (!boot) return
  boot.skills = result.skills
  boot.invalidSkills = result.invalid
}

function onSkillImported(summary: SkillImportSummary) {
  ctx.showToast(skillImportToast(summary))
  void ctx.runSafely(reloadSkills)
}

function viewSkill(name: string) {
  void router.push({ path: '/capabilities/skills', query: { skill: name } })
}

function onMcpImported(result: McpImportResult) {
  if (ctx.boot.value && result.status)
    ctx.boot.value.mcp = result.status as BootstrapPayload['mcp']
  ctx.showToast(mcpImportSummary(result))
}

function clearFilters() {
  query.value = ''
  filter.value = 'all'
}
</script>

<template>
  <PageShell
    title="探索"
    subtitle="精选的 Skills 与 MCP 服务器，安装前都会先预览，由你确认"
  >
    <div class="explore-page">
      <div class="toolbar">
        <SearchField
          v-model="query"
          class="search"
          placeholder="搜索 Skills、MCP 与插件"
          aria-label="搜索探索目录"
        />
        <div class="chips" role="radiogroup" aria-label="按类型筛选">
          <Chip
            v-for="item in EXPLORE_FILTERS"
            :key="item.id"
            role="radio"
            :aria-checked="filter === item.id"
            :active="filter === item.id"
            :data-filter="item.id"
            @click="filter = item.id"
          >
            {{ item.label }}
            <span class="count">{{ counts[item.id] }}</span>
          </Chip>
        </div>
      </div>

      <ul v-if="visible.length" class="grid" aria-label="探索目录">
        <ExploreCard
          v-for="entry in visible"
          :key="entry.id"
          :entry="entry"
          :installed="exploreEntryInstalled(entry, installedState)"
          @install="install(entry)"
          @homepage="openHomepage(entry)"
        />
      </ul>
      <EmptyState
        v-else-if="filter === 'plugin' && !counts.plugin"
        title="暂无精选插件"
        description="目录里还没有经过核实的插件。可以在「能力」页的「插件」标签从本地文件夹、zip 或 HTTPS 地址安装。"
        data-testid="explore-empty"
      >
        <Button
          size="sm"
          variant="outline"
          @click="router.push('/capabilities')"
        >
          前往能力页
        </Button>
      </EmptyState>
      <EmptyState
        v-else
        compact
        title="没有匹配的条目"
        description="换个关键词或类型试试。"
        data-testid="explore-empty"
      >
        <Button size="sm" variant="outline" @click="clearFilters">
          清除筛选
        </Button>
      </EmptyState>

      <p class="footnote">
        目录随 Emperor 版本发布，条目来自发布方的公开仓库。安装前请查看来源；MCP
        服务器会以你的权限运行本地命令或连接远程服务。
      </p>
    </div>

    <SkillImportDialog
      v-model:open="skillOpen"
      mode="archive"
      :initial-url="skillUrl"
      :scope-options="scopeOptions"
      :session-id="sessionId"
      @imported="onSkillImported"
      @select="viewSkill"
    />
    <McpAddDialog
      v-model:open="mcpOpen"
      :initial-text="mcpText"
      @imported="onMcpImported"
    />
    <PluginInstallDialog :flow="pluginFlow" />
  </PageShell>
</template>

<style scoped>
.explore-page {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  min-width: 0;
}

.toolbar {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  min-width: 0;
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1-5);
}

.count {
  margin-left: var(--space-1);
  color: rgb(var(--label-tertiary));
  font-variant-numeric: tabular-nums;
}

.grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-3);
  margin: 0;
  padding: 0;
  list-style: none;
}

.footnote {
  margin: 0;
  color: rgb(var(--label-tertiary));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  text-wrap: pretty;
}

@container settings-panel (max-width: 559px) {
  .grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
