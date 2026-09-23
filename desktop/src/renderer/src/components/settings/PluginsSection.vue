<script setup lang="ts">
/**
 * 能力 › 插件 — the 插件 tab of the /capabilities page (dsh plugin inventory): search, then the
 * installed Plugins as a two-column grid of compact disclosure cards
 * (PluginCard: facts, enable switch, uninstall). The header carries refresh
 * and the 「安装」 menu — 选择本地文件夹 / 选择 zip 文件 (`plugins.inspect`
 * with `{ kind: 'local', path }`, picked through the main-process dialogs)
 * and 从 URL 安装 (https; needs signature verification before it activates).
 * Every install is confirmed in PluginInstallDialog (ui/Modal).
 *
 * A Plugin can bring Skills, Hooks and MCP servers, so every change
 * refreshes the whole workbench (ctx.refreshAll) as the legacy panel did.
 */
import { computed, ref, watch } from 'vue'
import { core } from '../../api/http'
import { onPageReactivated } from '../pages/pageLifecycle'
import { useAppContext } from '../../composables/useAppContext'
import { DsDownload, DsFolderOpen, DsLink, DsPlus } from '../icons/ds'
import PluginCard from './plugins/PluginCard.vue'
import PluginInstallDialog from './plugins/PluginInstallDialog.vue'
import { usePluginInstall, type PluginSummary } from './plugins/pluginInstall'
import { refreshAction, useSettingsHeader } from './settingsHeader'
import { EmptyState, SearchField, SettingsSection } from './ui'

const ctx = useAppContext()

const plugins = computed<PluginSummary[]>(() => ctx.boot.value?.plugins ?? [])
const query = ref('')
const expanded = ref<string | null>(null)
const busyKey = ref<string | null>(null)
const error = ref('')
const notice = ref('')

const install = usePluginInstall({
  onInstalled: async (preview) => {
    notice.value = `已安装「${preview.name}」`
    await ctx.refreshAll()
  },
})

const filtered = computed(() => {
  const needle = query.value.trim().toLowerCase()
  if (!needle) return plugins.value
  return plugins.value.filter((plugin) =>
    `${plugin.name} ${plugin.pluginId}`.toLowerCase().includes(needle),
  )
})

watch(filtered, (list) => {
  if (
    expanded.value &&
    !list.some((plugin) => keyOf(plugin) === expanded.value)
  )
    expanded.value = null
})

// Shown again after another page: re-read the installed list only.
onPageReactivated(() =>
  ctx.runSafely(async () => {
    const list = await core('plugins.list')
    if (ctx.boot.value) ctx.boot.value.plugins = list
  }),
)

useSettingsHeader({
  actions: () => [
    refreshAction(() => ctx.refreshAll(), { title: '刷新 Plugin 列表' }),
    {
      id: 'install-plugin',
      label: '安装',
      kind: 'primary',
      icon: DsPlus,
      menu: [
        {
          id: 'local-folder',
          label: '选择本地文件夹',
          description: '从解压后的 Plugin 目录安装',
          icon: DsFolderOpen,
          onSelect: () => startLocal('folder'),
        },
        {
          id: 'local-zip',
          label: '选择 zip 文件',
          description: '从本地 Plugin 压缩包安装',
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

function keyOf(plugin: PluginSummary): string {
  return `${plugin.pluginId}:${plugin.scope}`
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

async function startLocal(kind: 'folder' | 'zip'): Promise<void> {
  notice.value = ''
  error.value = ''
  try {
    await install.installLocal(kind)
  } catch (cause) {
    error.value = messageOf(cause)
  }
}

async function mutate(
  plugin: PluginSummary,
  task: () => Promise<unknown>,
  done: string,
): Promise<void> {
  if (busyKey.value) return
  busyKey.value = keyOf(plugin)
  error.value = ''
  notice.value = ''
  try {
    await task()
    notice.value = done
    await ctx.refreshAll()
  } catch (cause) {
    error.value = messageOf(cause)
  } finally {
    busyKey.value = null
  }
}

function setEnabled(plugin: PluginSummary, enabled: boolean): void {
  if (plugin.scope === 'managed') return
  const scope = plugin.scope
  void mutate(
    plugin,
    () =>
      core('plugins.setEnabled', { pluginId: plugin.pluginId, scope, enabled }),
    `已${enabled ? '启用' : '停用'}「${plugin.name}」`,
  )
}

function uninstall(plugin: PluginSummary): void {
  if (plugin.scope === 'managed') return
  const scope = plugin.scope
  void mutate(
    plugin,
    () => core('plugins.uninstall', { pluginId: plugin.pluginId, scope }),
    `已卸载「${plugin.name}」`,
  )
}
</script>

<template>
  <SettingsSection
    intro="Plugin 打包 Skill、Hook、MCP 等能力；单个 Skill 请在 Skills 标签页添加。"
  >
    <p v-if="notice" class="notice" role="status">{{ notice }}</p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>

    <EmptyState
      v-if="!plugins.length"
      title="尚未安装 Plugin"
      description="从右上角「安装」选择本地文件夹、zip 文件或 HTTPS 地址。"
    />
    <div v-else class="catalog">
      <SearchField v-model="query" placeholder="搜索 Plugin">
        <template v-if="query" #trailing>
          <span class="count"
            >{{ filtered.length }} / {{ plugins.length }}</span
          >
        </template>
      </SearchField>
      <div class="catalog-heading">
        <h3>已安装</h3>
        <span :data-plugin-count="filtered.length">{{ filtered.length }}</span>
      </div>
      <EmptyState
        v-if="!filtered.length"
        title="没有匹配的 Plugin"
        variant="plain"
        compact
      />
      <ul v-else class="cards">
        <PluginCard
          v-for="plugin in filtered"
          :key="keyOf(plugin)"
          :plugin="plugin"
          :busy="busyKey === keyOf(plugin)"
          :open="expanded === keyOf(plugin)"
          @update:open="
            (value: boolean) => (expanded = value ? keyOf(plugin) : null)
          "
          @toggle="(enabled: boolean) => setEnabled(plugin, enabled)"
          @uninstall="uninstall(plugin)"
        />
      </ul>
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

.cards {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  align-items: start;
  gap: var(--space-2-5);
  margin: 0;
  padding: 0;
  list-style: none;
}

@container (max-width: 519px) {
  .cards {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
