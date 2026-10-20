<script setup lang="ts">
/**
 * CapabilityRecommendations — the 推荐 block at the top of 能力 (UI-S08:
 * the 探索 page folded in). A few picks from the catalog that ships with
 * the app (explore/exploreCatalog.json), filtered by the open tab: Skills
 * and MCP show their own kind, 插件 the first picks of any kind, 工具
 * nothing. A card is an icon, the name, one line of description and
 * 「安装」 (「已安装」 once it is there); the kind is the tab, so there is no
 * type badge. 「安装」 opens the tab's own install flow, prefilled
 * (explore/useExploreInstall). `/explore` lands here (`#recommended`).
 *
 * Props: tab (the open 能力 tab).
 */
import { computed } from 'vue'
import { Plug, Puzzle, Sparkles } from 'lucide-vue-next'
import Button from '../../ui/Button.vue'
import McpAddDialog from '../../settings/mcp/McpAddDialog.vue'
import PluginInstallDialog from '../../settings/plugins/PluginInstallDialog.vue'
import SkillImportDialog from '../../settings/skills/SkillImportDialog.vue'
import catalog from '../explore/exploreCatalog.json'
import {
  recommendedEntries,
  validExploreEntries,
  type RecommendationTab,
} from '../explore/exploreModel'
import { useExploreInstall } from '../explore/useExploreInstall'

const props = defineProps<{ tab: RecommendationTab }>()

const ENTRIES = validExploreEntries(catalog)
const GLYPHS = { skill: Sparkles, mcp: Plug, plugin: Puzzle } as const

const picks = computed(() => recommendedEntries(ENTRIES, props.tab))
const flow = useExploreInstall()
const {
  skillOpen,
  skillUrl,
  scopeOptions,
  sessionId,
  mcpOpen,
  mcpText,
  pluginFlow,
} = flow
</script>

<template>
  <section
    v-if="picks.length"
    id="recommended"
    class="recommendations"
    aria-labelledby="recommended-title"
    data-testid="capability-recommendations"
  >
    <h2 id="recommended-title" class="title">推荐</h2>
    <ul class="grid">
      <li
        v-for="entry in picks"
        :key="entry.id"
        class="recommendation"
        :data-recommendation="entry.id"
        :data-kind="entry.kind"
      >
        <span class="recommendation-icon" aria-hidden="true">
          <component :is="GLYPHS[entry.kind]" :size="16" :stroke-width="1.75" />
        </span>
        <span class="recommendation-text">
          <span class="recommendation-name">{{ entry.name }}</span>
          <span class="recommendation-description" :title="entry.description">{{
            entry.description
          }}</span>
        </span>
        <Button
          size="sm"
          :variant="flow.installed(entry) ? 'ghost' : 'secondary'"
          :disabled="flow.installed(entry)"
          :aria-label="
            flow.installed(entry)
              ? `「${entry.name}」已安装`
              : `安装「${entry.name}」`
          "
          @click="flow.install(entry)"
        >
          {{ flow.installed(entry) ? '已安装' : '安装' }}
        </Button>
      </li>
    </ul>

    <SkillImportDialog
      v-model:open="skillOpen"
      mode="archive"
      :initial-url="skillUrl"
      :scope-options="scopeOptions"
      :session-id="sessionId"
      @imported="flow.onSkillImported"
      @select="flow.viewSkill"
    />
    <McpAddDialog
      v-model:open="mcpOpen"
      :initial-text="mcpText"
      @imported="flow.onMcpImported"
    />
    <PluginInstallDialog :flow="pluginFlow" />
  </section>
</template>

<style scoped>
.recommendations {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin-bottom: var(--space-6);
  scroll-margin-top: var(--space-6);
}

.title {
  margin: 0;
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  font-weight: var(--weight-medium);
  color: rgb(var(--text-3));
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: var(--space-2);
  margin: 0;
  padding: 0;
  list-style: none;
}

.recommendation {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-width: 0;
  padding: var(--space-3);
  border-radius: var(--radius-card);
  background: rgb(var(--surface-raised));
}

.recommendation-icon {
  display: grid;
  flex: none;
  place-items: center;
  width: var(--space-8);
  height: var(--space-8);
  border-radius: var(--radius-row);
  background: rgb(var(--surface-base));
  color: rgb(var(--text-2));
}

.recommendation-text {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
}

.recommendation-name {
  overflow: hidden;
  font-size: var(--fs-s);
  line-height: var(--lh-s);
  font-weight: var(--weight-medium);
  color: rgb(var(--text-1));
  text-overflow: ellipsis;
  white-space: nowrap;
}

.recommendation-description {
  overflow: hidden;
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  color: rgb(var(--text-3));
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
