<script setup lang="ts">
/**
 * 能力 › 插件 — the 插件 tab of the /capabilities page: search, then two
 * lists of PluginRow — 已安装 (what the user installed) and 预装 (what ships
 * with Emperor). Selecting a plugin swaps the lists for its inline detail
 * (PluginDetail); the choice lives in the route
 * (`/capabilities/plugins?plugin=<id>&scope=<scope>`, usePluginSelection),
 * and 「全部插件」 goes back with the search term kept (the page stays alive).
 *
 * The header carries refresh and the 「安装」 menu — 选择本地文件夹 /
 * 选择 zip 文件 (`plugins.inspect` with `{ kind: 'local', path }`, picked
 * through the main-process dialogs) and 从 URL 安装 (https; needs signature
 * verification before it activates). Every install is confirmed in
 * PluginInstallDialog (ui/Modal).
 *
 * A plugin can bring Skills, Hooks and MCP servers, so every change
 * refreshes the whole workbench (ctx.refreshAll). Core's `plugins_changed`
 * (installs, toggles, a different active project, a hook that starts or
 * stops failing) re-reads the list.
 *
 * SEC-07: a project's `.emperor/settings.json` only suggests. Above the
 * lists, one Notice per suggested project plugin — 「该项目建议启用 X」
 * with 启用 / 忽略; either answer is the user's choice for this project
 * (`plugins.setEnabled`, kept in Emperor), and the suggestion goes away.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { onCoreEvent } from '../../api/backend'
import { core } from '../../api/http'
import { onPageReactivated } from '../pages/pageLifecycle'
import { useAppContext } from '../../composables/useAppContext'
import { DsDownload, DsFolderOpen, DsLink, DsPlus } from '../icons/ds'
import Button from '../ui/Button.vue'
import Notice from '../ui/Notice.vue'
import PluginDetail from './plugins/PluginDetail.vue'
import PluginInstallDialog from './plugins/PluginInstallDialog.vue'
import PluginRow from './plugins/PluginRow.vue'
import { usePluginInstall, type PluginSummary } from './plugins/pluginInstall'
import {
  filterPlugins,
  groupPlugins,
  pluginKey,
  pluginMembersText,
  pluginSuggestions,
} from './plugins/pluginsModel'
import { usePluginSelection } from './plugins/usePluginSelection'
import { useSettingsHeader } from './settingsHeader'
import { EmptyState, SearchField, SettingsSection } from './ui'

const ctx = useAppContext()
const selection = usePluginSelection()

const plugins = computed<PluginSummary[]>(() => ctx.boot.value?.plugins ?? [])
const query = ref('')
const notice = ref('')

const install = usePluginInstall({
  onInstalled: async (preview) => {
    notice.value = `已安装「${preview.name}」`
    await ctx.refreshAll()
    await reloadList()
  },
})

const suggestions = computed(() => pluginSuggestions(plugins.value))
const filtered = computed(() => filterPlugins(plugins.value, query.value))
const groups = computed(() => groupPlugins(filtered.value))
const selected = selection.selected
const selectedSummary = computed(
  () =>
    plugins.value.find(
      (plugin) =>
        selected.value &&
        plugin.pluginId === selected.value.pluginId &&
        plugin.scope === selected.value.scope,
    ) ?? null,
)

/** A fresh array, so the list updates even when the bridge hands back the same one. */
async function reloadList(): Promise<void> {
  const list = await core('plugins.list')
  if (ctx.boot.value) ctx.boot.value.plugins = [...list]
}

// Shown again after another page: re-read the installed list only.
onPageReactivated(() => ctx.runSafely(reloadList))

let unsubscribe = () => {}
let pending: ReturnType<typeof setTimeout> | null = null
onMounted(() => {
  unsubscribe = onCoreEvent((event) => {
    if (
      (event as { event?: unknown } | null)?.event !== 'plugins_changed' ||
      pending !== null
    )
      return
    pending = setTimeout(() => {
      pending = null
      void ctx.runSafely(reloadList)
    }, 80)
  })
})
onBeforeUnmount(() => {
  unsubscribe()
  if (pending !== null) clearTimeout(pending)
})

// No refresh action: the list follows plugins_changed and reloads when the
// page is shown again.
useSettingsHeader({
  actions: () => [
    {
      id: 'install-plugin',
      label: '安装',
      kind: 'primary',
      icon: DsPlus,
      menu: [
        {
          id: 'local-folder',
          label: '选择本地文件夹',
          description: '从解压后的插件目录安装',
          icon: DsFolderOpen,
          onSelect: () => startLocal('folder'),
        },
        {
          id: 'local-zip',
          label: '选择 zip 文件',
          description: '从本地插件压缩包安装',
          icon: DsDownload,
          onSelect: () => startLocal('zip'),
        },
        {
          id: 'url',
          label: '从 URL 安装',
          description: '需要通过签名验证才会激活',
          icon: DsLink,
          onSelect: () => {
            notice.value = ''
            install.openUrl()
          },
        },
      ],
    },
  ],
})

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

const error = ref('')

async function startLocal(kind: 'folder' | 'zip'): Promise<void> {
  notice.value = ''
  error.value = ''
  try {
    await install.installLocal(kind)
  } catch (cause) {
    error.value = messageOf(cause)
  }
}

const deciding = ref<string | null>(null)

/** 启用 / 忽略 a project's suggestion: the user's choice for this project. */
async function decide(plugin: PluginSummary, enabled: boolean): Promise<void> {
  if (deciding.value !== null) return
  deciding.value = pluginKey(plugin)
  notice.value = ''
  error.value = ''
  try {
    await core('plugins.setEnabled', {
      pluginId: plugin.pluginId,
      scope: 'project',
      enabled,
    })
    await reloadList()
    if (enabled) {
      notice.value = `已在这个项目启用「${plugin.displayName}」`
      await ctx.refreshAll()
    }
  } catch (cause) {
    error.value = messageOf(cause)
  } finally {
    deciding.value = null
  }
}

function suggestionText(plugin: PluginSummary): string {
  const members = pluginMembersText(plugin.capabilities)
  return members ? `（带 ${members}）` : ''
}

function open(plugin: PluginSummary): void {
  notice.value = ''
  void selection.select({ pluginId: plugin.pluginId, scope: plugin.scope })
}

function back(): void {
  void selection.select(null)
}

async function onUninstalled(): Promise<void> {
  const name = selectedSummary.value?.displayName ?? selected.value?.pluginId
  back()
  notice.value = `已卸载「${name}」`
  await ctx.refreshAll()
}
</script>

<template>
  <SettingsSection
    intro="插件打包 Skill、MCP、Hook 等能力；单个 Skill 请在 Skills 标签页添加。"
  >
    <div v-if="!selected && suggestions.length" class="suggestions">
      <Notice
        v-for="plugin in suggestions"
        :key="pluginKey(plugin)"
        tone="info"
        :title="`该项目建议启用 ${plugin.displayName}`"
        :data-plugin-suggestion="plugin.pluginId"
      >
        仓库的 <code>.emperor/settings.json</code> 建议在这个项目里启用它{{
          suggestionText(plugin)
        }}。确认后才会启用，选择记在 Emperor 里，仓库文件改不了它。
        <template #actions>
          <Button
            size="sm"
            variant="secondary"
            :loading="deciding === pluginKey(plugin)"
            :disabled="deciding !== null"
            @click="decide(plugin, true)"
          >
            启用
          </Button>
          <Button
            size="sm"
            variant="ghost"
            :disabled="deciding !== null"
            @click="decide(plugin, false)"
          >
            忽略
          </Button>
        </template>
      </Notice>
    </div>
    <p v-if="notice && !selected" class="notice" role="status">{{ notice }}</p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>

    <PluginDetail
      v-if="selected"
      :key="`${selected.pluginId}:${selected.scope}`"
      :plugin-id="selected.pluginId"
      :scope="selected.scope"
      :summary="selectedSummary"
      @back="back"
      @changed="ctx.refreshAll()"
      @uninstalled="onUninstalled"
    />
    <EmptyState
      v-else-if="!plugins.length"
      title="尚未安装插件"
      description="从右上角「安装」选择本地文件夹、zip 文件或 HTTPS 地址。"
      framed
    />
    <div v-else class="catalog">
      <SearchField v-model="query" placeholder="搜索插件">
        <template v-if="query" #trailing>
          <span class="count"
            >{{ filtered.length }} / {{ plugins.length }}</span
          >
        </template>
      </SearchField>
      <EmptyState
        v-if="!filtered.length"
        title="没有匹配的插件"
        variant="inline"
      />
      <template
        v-for="group in ['installed', 'preinstalled'] as const"
        :key="group"
      >
        <section
          v-if="groups[group].length"
          class="group"
          :data-plugin-group="group"
        >
          <div class="catalog-heading">
            <h3>{{ group === 'installed' ? '已安装' : '预装' }}</h3>
            <span :data-plugin-count="groups[group].length">{{
              groups[group].length
            }}</span>
          </div>
          <ul class="rows">
            <PluginRow
              v-for="plugin in groups[group]"
              :key="pluginKey(plugin)"
              :plugin="plugin"
              @select="open(plugin)"
            />
          </ul>
        </section>
      </template>
    </div>

    <PluginInstallDialog :flow="install" />
  </SettingsSection>
</template>

<style scoped>
.notice,
.error {
  margin: 0 0 var(--space-3);
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  color: rgb(var(--state-ok-label));
  overflow-wrap: anywhere;
}

.error {
  color: rgb(var(--state-error-label));
}

.suggestions {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin: 0 0 var(--space-3);
  min-width: 0;
}

.suggestions code {
  font-family: var(--font-mono);
}

.catalog {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  min-width: 0;
}

.count {
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  color: rgb(var(--label-tertiary));
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.catalog-heading {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  padding: 0 var(--space-0-5);
}

.catalog-heading h3 {
  margin: 0;
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  font-weight: 600;
  color: rgb(var(--label-primary));
}

.catalog-heading span {
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  color: rgb(var(--label-tertiary));
  font-variant-numeric: tabular-nums;
}

.group {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-width: 0;
}

.rows {
  display: flex;
  flex-direction: column;
  min-width: 0;
  margin: 0;
  padding: 0;
  overflow: hidden;
  border: 1px solid var(--border-l2);
  border-radius: var(--radius-card);
  background: rgb(var(--bg-layer-3));
}
</style>
