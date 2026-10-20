<script setup lang="ts">
/**
 * PluginDetail — the inline detail of one plugin inside 能力 › 插件 (it
 * replaces the list, like SkillDetail). A bar with 「全部插件」 (back) and
 * 卸载 for packages that allow it; the hero with the square logo, name,
 * short description, developer and version, and the enable switch; the
 * example prompts with 「立即试用」 (opens a new chat with the prompt in its
 * composer, never sends it); then the real members grouped by kind with
 * each member's state and reason (a failed hook also names the variables
 * it may need, SEC-07); the 工具 it brings, one group per member
 * with the rows of 能力 › 工具 (Computer Use by driver, each driver with a
 * way to its settings page; an MCP server's while it runs); and the 信息
 * group.
 *
 * Data: `plugins.getDetail`, re-read on `plugins_changed`, on MCP
 * connection changes (member states follow the servers) and, for Computer
 * Use, on `computer_use_changed` (its drivers follow the stop and the
 * driver switches).
 *
 * Props: pluginId, scope, summary? (the list row, shown while loading).
 * Emits: back, changed (a toggle happened: reload the list), uninstalled.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { onCoreEvent } from '../../../api/backend'
import { core } from '../../../api/http'
import { useSession } from '../../../composables/useSession'
import { sessionLocation } from '../../../router'
import { handDraftTo } from '../../chat/draftHandoff'
import { DsChevronLeft, DsNewChat, DsSettings, DsTrash } from '../../icons/ds'
import Button from '../../ui/Button.vue'
import SkillConfirmDialog from '../skills/SkillConfirmDialog.vue'
import ToolRow from '../tools/ToolRow.vue'
import { DefinitionList, EmptyState, Badge, Switch } from '../ui'
import { useSettingsRoute } from '../useSettingsRoute'
import {
  activationState,
  type PluginDetail,
  type PluginSummary,
} from './pluginInstall'
import Avatar from '../../ui/Avatar.vue'
import {
  componentStateBadge,
  hookVariableNotes,
  isComputerUsePlugin,
  memberGroups,
  pluginFacts,
  pluginSourceTag,
  pluginToolGroups,
} from './pluginsModel'
import type { PluginSelectionScope } from './usePluginSelection'

const props = withDefaults(
  defineProps<{
    pluginId: string
    scope: PluginSelectionScope
    summary?: PluginSummary | null
  }>(),
  { summary: null },
)
const emit = defineEmits<{ back: []; changed: []; uninstalled: [] }>()

const router = useRouter()
const sessions = useSession()
const { openSettings } = useSettingsRoute()

const detail = ref<PluginDetail | null>(null)
const loadError = ref('')
const actionError = ref('')
const busy = ref<'toggle' | 'uninstall' | 'try' | null>(null)
const confirmUninstall = ref(false)

const shown = computed(() => detail.value ?? null)
const title = computed(
  () =>
    shown.value?.displayName ?? props.summary?.displayName ?? props.pluginId,
)
const state = computed(() =>
  shown.value ? activationState(shown.value) : null,
)
const groups = computed(() => (shown.value ? memberGroups(shown.value) : []))
const toolGroups = computed(() =>
  shown.value ? pluginToolGroups(shown.value) : [],
)
const toolCount = computed(() =>
  toolGroups.value.reduce((total, group) => total + group.tools.length, 0),
)
const openTool = ref<string | null>(null)
const facts = computed(() => (shown.value ? pluginFacts(shown.value) : []))
const missing = computed(() => shown.value?.materialization === 'missing')

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

async function load(): Promise<void> {
  try {
    detail.value = await core('plugins.getDetail', {
      pluginId: props.pluginId,
      scope: props.scope,
    })
    loadError.value = ''
  } catch (cause) {
    loadError.value = messageOf(cause)
  }
}

watch(
  () => [props.pluginId, props.scope] as const,
  () => {
    detail.value = null
    actionError.value = ''
    openTool.value = null
    void load()
  },
  { immediate: true },
)

async function toggle(enabled: boolean): Promise<void> {
  if (busy.value || !shown.value?.toggleable) return
  busy.value = 'toggle'
  actionError.value = ''
  try {
    await core('plugins.setEnabled', {
      pluginId: props.pluginId,
      scope: props.scope,
      enabled,
    })
    await load()
    emit('changed')
  } catch (cause) {
    actionError.value = messageOf(cause)
  } finally {
    busy.value = null
  }
}

async function uninstall(): Promise<void> {
  if (busy.value || !shown.value?.uninstallable) return
  if (props.scope === 'managed') return
  busy.value = 'uninstall'
  actionError.value = ''
  try {
    await core('plugins.uninstall', {
      pluginId: props.pluginId,
      scope: props.scope,
    })
    confirmUninstall.value = false
    emit('uninstalled')
  } catch (cause) {
    actionError.value = messageOf(cause)
  } finally {
    busy.value = null
  }
}

/** 立即试用: a new chat with the prompt waiting in its composer. */
async function tryPrompt(prompt: string): Promise<void> {
  if (busy.value) return
  busy.value = 'try'
  actionError.value = ''
  try {
    const session = await sessions.create({ mode: 'chat', title: '新会话' })
    handDraftTo(session.id, prompt)
    await router.push(sessionLocation(session.id)).catch(() => undefined)
  } catch (cause) {
    actionError.value = messageOf(cause)
  } finally {
    busy.value = null
  }
}

let unsubscribe = () => {}
let pending: ReturnType<typeof setTimeout> | null = null
onMounted(() => {
  unsubscribe = onCoreEvent((event) => {
    const name = (event as { event?: unknown } | null)?.event
    // Computer Use's drivers change with its own event (stop, driver switches).
    const computerUse =
      name === 'computer_use_changed' &&
      isComputerUsePlugin({ pluginId: props.pluginId, scope: props.scope })
    if (
      name !== 'plugins_changed' &&
      name !== 'mcp_connection_state' &&
      !computerUse
    )
      return
    if (pending !== null) return
    pending = setTimeout(() => {
      pending = null
      void load()
    }, 150)
  })
})
onBeforeUnmount(() => {
  unsubscribe()
  if (pending !== null) clearTimeout(pending)
})

defineExpose({ reload: load })
</script>

<template>
  <div class="plugin-detail" :data-plugin-detail="pluginId">
    <div class="bar">
      <Button size="sm" variant="ghost" class="back" @click="emit('back')">
        <template #icon><DsChevronLeft :size="14" /></template>
        全部插件
      </Button>
      <div v-if="shown?.uninstallable" class="bar-actions">
        <Button
          size="sm"
          variant="danger"
          data-action="uninstall-plugin"
          :disabled="busy !== null"
          @click="confirmUninstall = true"
        >
          <template #icon><DsTrash :size="14" /></template>
          卸载
        </Button>
      </div>
    </div>

    <EmptyState
      v-if="loadError && !shown"
      title="无法打开这个插件"
      :description="loadError"
      framed
    >
      <Button size="sm" variant="secondary" @click="load()">重试</Button>
    </EmptyState>

    <template v-else-if="shown">
      <header class="hero">
        <Avatar kind="logo" :label="title" :src="shown.logo" :size="40" />
        <div class="hero-text">
          <div class="title-line">
            <h3 class="name">{{ title }}</h3>
            <Badge>{{ pluginSourceTag(shown) }}</Badge>
            <Badge v-if="state" :tone="state.tone" variant="dot-label">
              {{ state.label }}
            </Badge>
          </div>
          <p class="description">{{ shown.description || '没有描述' }}</p>
          <p class="byline">
            {{ shown.developerName || '开发者未提供' }} · 版本
            {{ shown.version ?? '未提供' }}
          </p>
        </div>
        <label v-if="shown.toggleable" class="enable" data-plugin-toggle>
          <Switch
            :model-value="shown.enabled"
            :disabled="busy !== null"
            aria-label="启用"
            @update:model-value="(value: boolean) => toggle(value)"
          />
          启用
        </label>
        <p v-else class="enable-note">这台电脑上不能开启</p>
      </header>

      <p v-if="actionError" class="error" role="alert">{{ actionError }}</p>

      <section v-if="shown.prompts.length" class="block" data-plugin-prompts>
        <h4 class="block-title">示例提示</h4>
        <ul class="prompts">
          <li v-for="prompt in shown.prompts" :key="prompt" class="prompt">
            <span class="prompt-text">{{ prompt }}</span>
            <Button
              size="sm"
              variant="secondary"
              data-action="try-prompt"
              :disabled="busy !== null"
              @click="tryPrompt(prompt)"
            >
              <template #icon><DsNewChat :size="14" /></template>
              立即试用
            </Button>
          </li>
        </ul>
      </section>

      <div v-if="isComputerUsePlugin(shown)" class="cross-link">
        <p>
          这个插件的开关就是电脑操作总开关。驱动、权限、应用名单在设置里调整。
        </p>
        <Button
          size="sm"
          variant="secondary"
          data-action="open-computer-settings"
          @click="openSettings('computer')"
        >
          <template #icon><DsSettings :size="14" /></template>
          打开 设置 › 电脑操作
        </Button>
      </div>

      <template v-if="groups.length">
        <section
          v-for="group in groups"
          :key="group.key"
          class="block"
          :data-member-group="group.key"
        >
          <h4 class="block-title">
            {{ group.title }}
            <Badge variant="count" :label="group.items.length" />
          </h4>
          <ul class="members">
            <li
              v-for="item in group.items"
              :key="`${item.kind}:${item.id}`"
              class="member"
              :data-member="item.id"
              :data-member-state="item.state"
            >
              <div class="member-head">
                <span class="member-title">{{ item.title }}</span>
                <Badge
                  :tone="componentStateBadge(item.state).tone"
                  variant="dot-label"
                >
                  {{ componentStateBadge(item.state).label }}
                </Badge>
              </div>
              <p
                v-if="item.description"
                class="member-description"
                :data-code="
                  item.kind === 'mcp' || item.kind === 'hook' || undefined
                "
              >
                {{ item.description }}
              </p>
              <p v-if="item.reason" class="member-reason">{{ item.reason }}</p>
              <p
                v-if="item.variables?.length"
                class="member-reason"
                data-member-variables
              >
                需要的环境变量：<template
                  v-for="(variable, index) in hookVariableNotes(item.variables)"
                  :key="variable.name"
                  ><template v-if="index > 0">；</template
                  ><code>{{ variable.name }}</code
                  >（{{ variable.note }}）</template
                >
              </p>
            </li>
          </ul>
        </section>
      </template>
      <p v-else class="note" data-plugin-empty>
        {{
          missing
            ? '插件内容缺失，请重新安装。'
            : '仅展示元数据：这个插件没有 Skill、MCP、Hook 或应用连接。'
        }}
      </p>

      <section v-if="toolGroups.length" class="block" data-plugin-tools>
        <h4 class="block-title">
          工具 <Badge variant="count" :label="toolCount" />
        </h4>
        <p v-if="shown.tools.note" class="note" data-tools-note>
          {{ shown.tools.note }}
        </p>
        <div
          v-for="group in toolGroups"
          :key="group.id"
          class="tool-group"
          :data-tool-group="group.id"
        >
          <div class="tool-group-head">
            <span class="tool-group-title">
              {{ group.title }}
              <Badge variant="count" :label="group.tools.length" />
            </span>
            <Button
              v-if="group.settings"
              size="sm"
              variant="ghost"
              :data-driver-settings="group.id"
              :title="group.settings.label"
              :aria-label="`打开 ${group.settings.label}`"
              @click="openSettings(group.settings.section, group.settings.page)"
            >
              <template #icon><DsSettings :size="14" /></template>
              设置
            </Button>
          </div>
          <p v-if="group.note" class="note">{{ group.note }}</p>
          <ul v-if="group.tools.length" class="tool-list">
            <ToolRow
              v-for="tool in group.tools"
              :key="tool.name"
              :tool="tool"
              :open="openTool === tool.name"
              @update:open="
                (value: boolean) => (openTool = value ? tool.name : null)
              "
            />
          </ul>
        </div>
      </section>

      <section class="block" data-plugin-info>
        <h4 class="block-title">信息</h4>
        <p v-if="shown.longDescription" class="long">
          {{ shown.longDescription }}
        </p>
        <DefinitionList :items="facts" />
        <p v-if="shown.logoIssue" class="note">Logo：{{ shown.logoIssue }}</p>
      </section>
    </template>

    <SkillConfirmDialog
      v-model:open="confirmUninstall"
      :title="`卸载插件「${title}」？`"
      description="插件的 Skill、MCP 与 Hook 会立即停用；已下载的内容保留在缓存里。"
      confirm-label="卸载"
      danger
      :busy="busy === 'uninstall'"
      @confirm="uninstall"
    />
  </div>
</template>

<style scoped>
.plugin-detail {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  min-width: 0;
}

.bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: var(--space-2);
  min-width: 0;
  padding-top: var(--space-1);
}

.back {
  margin-left: calc(var(--space-2) * -1);
}

.bar-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.hero {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  min-width: 0;
}

.hero-text {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: var(--space-0-5);
  min-width: 0;
}

.title-line {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-1-5);
  min-width: 0;
}

.name {
  margin: 0;
  min-width: 0;
  font-size: var(--fs-base);
  line-height: var(--lh-base);
  font-weight: 600;
  color: rgb(var(--label-primary));
  overflow-wrap: anywhere;
}

.description,
.byline,
.long,
.note,
.enable-note,
.error {
  margin: 0;
  min-width: 0;
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  overflow-wrap: anywhere;
}

.description,
.long {
  color: rgb(var(--label-secondary));
}

.byline,
.note,
.enable-note {
  color: rgb(var(--label-tertiary));
}

.error {
  color: rgb(var(--state-error-label));
}

.enable {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: var(--space-1-5);
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  color: rgb(var(--label-secondary));
  cursor: pointer;
}

.enable-note {
  flex: none;
}

.block {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-width: 0;
}

.block-title {
  display: flex;
  align-items: baseline;
  gap: var(--space-1-5);
  margin: 0;
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  font-weight: 600;
  color: rgb(var(--label-primary));
}

.prompts,
.members {
  display: flex;
  flex-direction: column;
  margin: 0;
  padding: 0;
  list-style: none;
  overflow: hidden;
  border: 1px solid var(--border-l2);
  border-radius: var(--radius-card);
  background: rgb(var(--bg-layer-3));
  min-width: 0;
}

.prompt,
.member {
  display: flex;
  flex-direction: column;
  gap: var(--space-0-5);
  min-width: 0;
  padding: var(--space-2) var(--space-3);
}

.prompt {
  flex-direction: row;
  align-items: center;
  gap: var(--space-3);
}

.prompt + .prompt,
.member + .member {
  border-top: 1px solid var(--border-l2);
}

.prompt-text {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  color: rgb(var(--label-primary));
  overflow-wrap: anywhere;
}

.member-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-1-5);
  min-width: 0;
}

.member-title {
  min-width: 0;
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  font-weight: 500;
  color: rgb(var(--label-primary));
  overflow-wrap: anywhere;
}

.member-description,
.member-reason {
  margin: 0;
  min-width: 0;
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  overflow-wrap: anywhere;
}

.member-description {
  color: rgb(var(--label-tertiary));
}

/* MCP transports and Hook commands read as code; other descriptions are prose. */
.member-description[data-code] {
  font-family: var(--font-mono);
}

.member-reason {
  color: rgb(var(--label-secondary));
}

.member-reason code {
  font-family: var(--font-mono);
}

.tool-group {
  display: flex;
  flex-direction: column;
  gap: var(--space-1-5);
  min-width: 0;
}

.tool-group + .tool-group {
  margin-top: var(--space-2);
}

.tool-group-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  min-width: 0;
  min-height: var(--space-7);
}

.tool-group-title {
  display: flex;
  align-items: baseline;
  gap: var(--space-1-5);
  min-width: 0;
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  font-weight: 500;
  color: rgb(var(--label-secondary));
}

.tool-list {
  display: flex;
  flex-direction: column;
  margin: 0;
  padding: 0;
  overflow: hidden;
  border: 1px solid var(--border-l2);
  border-radius: var(--radius-card);
  list-style: none;
}

.cross-link {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-card);
  background: var(--interactive-bg-hover);
}

.cross-link p {
  flex: 1;
  margin: 0;
  min-width: 0;
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  color: rgb(var(--label-secondary));
}

@container (max-width: 439px) {
  .hero {
    flex-wrap: wrap;
  }

  .prompt {
    flex-direction: column;
    align-items: flex-start;
  }
}
</style>
