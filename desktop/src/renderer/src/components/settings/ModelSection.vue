<script setup lang="ts">
/**
 * Settings › 模型 — saved model entries grouped by provider (dsh
 * ModelsSection pattern): one outlined card per provider (logo, name, model
 * count, key status, endpoint) listing its models as rows. 「编辑」 expands the
 * entry editor under its row (no nested dialog), 「删除」 asks inline.
 *
 * Adding models: the header's 「添加模型」 opens the three-step dialog
 * (model/AddModelDialog: connect → pick → confirm, one saveEntries); a
 * provider card's 「管理模型」 opens it at step 2 for that provider. With no
 * models yet the dialog opens by itself. Saved rows are highlighted and the
 * first new model gets a text test in the background. The execution /
 * cost policy is a SettingsGroup of rows below the list. The model used by a
 * conversation is picked in the composer, not here.
 *
 * Every write returns the full model config payload, which is applied to the
 * bootstrap state (current model, provider, availability, profile
 * onboarding) — the same contract the retired ModelView had.
 */
import { computed, defineAsyncComponent, nextTick, ref, watch } from 'vue'
import { deleteModelEntry, testModelEntry } from '../../api/model'
import { addModelRequested, takeAddModelRequest } from './model/addModelRequest'
import { core } from '../../api/http'
import { useAppContext } from '../../composables/useAppContext'
import type {
  ModelConfigPayload,
  ModelEntry,
  ProviderOption,
} from '../../types'
import Button from '../ui/Button.vue'
import Avatar from '../ui/Avatar.vue'
import { DsPlus } from '../icons/ds'
import ModelEntryEditor from './model/ModelEntryEditor.vue'
import ModelPolicyGroup from './model/ModelPolicyGroup.vue'
import {
  CAPABILITY_ROWS,
  CAPABILITY_TAGS,
  formatTokenCount,
  modelEntryLabel,
} from './model/modelFormModel'
import {
  groupEntriesByProvider,
  providerCredentialState,
  providerEndpointSummary,
  type ProviderGroup,
} from '../../model/providerGroups'
import { refreshAction, useSettingsHeader } from './settingsHeader'
import {
  EmptyState,
  Notice,
  SettingsCard,
  SettingsGroup,
  SettingsSection,
  Badge,
} from './ui'
import { confirm } from '../ui/confirm'
import type { RejectedModelEntryPayload } from '../../types'

/**
 * The add flow: `pick` shows the provider picker; `form` the new-entry
 * editor for `provider` — in the top add card, or inside that provider's
 * card when `inGroup`.
 */
// The dialog loads when it is first opened.
const AddModelDialog = defineAsyncComponent(
  () => import('./model/AddModelDialog.vue'),
)

const ctx = useAppContext()

const payload = computed<ModelConfigPayload | null>(
  () => ctx.boot.value?.modelConfig ?? null,
)
const entries = computed(() => payload.value?.models ?? [])
/** Entries in model_config.json that do not validate (MOD-03). */
const rejected = computed(() => payload.value?.rejectedEntries ?? [])
const providerOptions = computed<ProviderOption[]>(
  () => payload.value?.providerOptions ?? [],
)
const groups = computed(() =>
  groupEntriesByProvider(entries.value, providerOptions.value),
)

/** The add-model dialog: open, and the provider it manages (null: add). */
const dialogOpen = ref(false)
const manageProvider = ref<string | null>(null)
const dialogKey = ref(0)
/** Rows saved by the dialog, highlighted for a few seconds. */
const highlight = ref<Set<string>>(new Set())
let highlightTimer: ReturnType<typeof setTimeout> | undefined
/** The saved entry whose editor is open. */
const editing = ref<string | null>(null)
const confirmingDelete = ref<string | null>(null)
const deletingId = ref<string | null>(null)
const notice = ref('')
const listError = ref('')

let autoOpened = false
// 添加模型… from the composer's model menu (addModelRequest.ts).
watch(
  () => addModelRequested.value && Boolean(payload.value),
  (requested) => {
    if (requested && takeAddModelRequest()) {
      autoOpened = true
      openAdd()
    }
  },
)

// First run: with nothing configured the dialog opens by itself, once.
watch(
  () => Boolean(payload.value) && entries.value.length === 0,
  (empty) => {
    if (empty && !autoOpened) {
      autoOpened = true
      openAdd()
    }
  },
  { immediate: true },
)
if (payload.value && takeAddModelRequest()) {
  autoOpened = true
  openAdd()
}

useSettingsHeader({
  actions: () => [
    refreshAction(() => reload(), { title: '重新读取模型配置' }),
    {
      id: 'add-model',
      label: '添加模型',
      kind: 'primary',
      icon: DsPlus,
      disabled: !payload.value,
      onClick: () => openAdd(),
    },
  ],
})

function capabilityTags(entry: ModelEntry): string[] {
  const profile = entry.resolvedProfile
  if (!profile) return []
  return CAPABILITY_ROWS.filter((row) => profile[row.key]).map(
    (row) => CAPABILITY_TAGS[row.key],
  )
}

function contextLabel(entry: ModelEntry): string {
  const tokens = formatTokenCount(
    entry.resolvedProfile?.contextWindowTokens || entry.contextWindowTokens,
  )
  return tokens ? `${tokens} 上下文` : ''
}

function resetTransient(): void {
  notice.value = ''
  listError.value = ''
  confirmingDelete.value = null
}

function openAdd(): void {
  resetTransient()
  editing.value = null
  manageProvider.value = null
  dialogKey.value += 1
  dialogOpen.value = true
}

function manage(group: ProviderGroup): void {
  resetTransient()
  editing.value = null
  manageProvider.value = group.provider
  dialogKey.value += 1
  dialogOpen.value = true
}

/** The dialog saved: show the new rows and test the first one quietly. */
async function onDialogSaved(
  result: ModelConfigPayload & { savedEntryIds: string[] },
): Promise<void> {
  await applyPayload(result)
  const ids = result.savedEntryIds
  highlight.value = new Set(ids)
  clearTimeout(highlightTimer)
  highlightTimer = setTimeout(() => (highlight.value = new Set()), 4000)
  notice.value = ids.length ? `已添加 ${ids.length} 个模型` : '已更新模型'
  const first = ids[0]
  if (!first) return
  const label =
    result.models.find((entry) => entry.entryId === first)
      ?.effectiveDisplayName ?? first
  try {
    const test = await testModelEntry(first, 'text')
    notice.value = test.ok
      ? `已添加 ${ids.length} 个模型 ·「${label}」测试通过`
      : `已添加 ${ids.length} 个模型 ·「${label}」测试失败：${test.error ?? '没有回复'}`
  } catch (error) {
    notice.value = `已添加 ${ids.length} 个模型 ·「${label}」测试失败：${
      error instanceof Error ? error.message : String(error)
    }`
  }
}

function toggleEdit(entry: ModelEntry): void {
  resetTransient()
  if (editing.value === entry.entryId) closeEditor()
  else editing.value = entry.entryId
}

function closeEditor(): void {
  const entryId = editing.value
  editing.value = null
  if (entryId) void focusEditButton(entryId)
}

async function focusEditButton(entryId: string): Promise<void> {
  await nextTick()
  const row = [
    ...document.querySelectorAll<HTMLElement>('[data-entry-id]'),
  ].find((element) => element.dataset.entryId === entryId)
  row?.querySelector<HTMLElement>('[aria-expanded]')?.focus()
}

/** Apply a model config payload to the bootstrap state (ex-ModelView). */
async function applyPayload(next: ModelConfigPayload): Promise<void> {
  const boot = ctx.boot.value
  if (boot) {
    boot.modelConfig = next
    boot.model = next.current?.modelId || ''
    boot.provider = next.current?.provider || undefined
    boot.providerLabel = next.current?.providerLabel || undefined
    if (next.profileOnboarding)
      boot.profileOnboarding = next.profileOnboarding.state
  }
  if (next.profileOnboarding?.started)
    await ctx.openProfileInterviewSession(
      next.profileOnboarding.state.sessionId,
    )
}

async function onSaved(next: ModelConfigPayload, label: string): Promise<void> {
  editing.value = null
  notice.value = `已保存「${label}」`
  await applyPayload(next)
}

async function reload(): Promise<void> {
  listError.value = ''
  try {
    await applyPayload(await core('model.getConfig'))
  } catch (error) {
    listError.value = error instanceof Error ? error.message : String(error)
  }
}

function askDelete(entry: ModelEntry): void {
  resetTransient()
  if (editing.value === entry.entryId) editing.value = null
  confirmingDelete.value = entry.entryId
}

function rejectedLabel(item: RejectedModelEntryPayload): string {
  return item.modelId || item.entryId || `第 ${item.index + 1} 个条目`
}

/** Remove an entry that does not validate from model_config.json. */
async function discardRejected(item: RejectedModelEntryPayload): Promise<void> {
  if (
    !(await confirm({
      title: `删除无法读取的「${rejectedLabel(item)}」？`,
      body: '这个条目会从 model_config.json 里删掉，无法恢复。其余模型不受影响。',
      confirmLabel: '删除',
      tone: 'danger',
    }))
  )
    return
  listError.value = ''
  try {
    await applyPayload(await core('model.discardRejected', { key: item.key }))
    notice.value = `已删除「${rejectedLabel(item)}」`
  } catch (error) {
    listError.value = error instanceof Error ? error.message : String(error)
  }
}

async function confirmDelete(entry: ModelEntry): Promise<void> {
  if (deletingId.value) return
  deletingId.value = entry.entryId
  listError.value = ''
  try {
    await applyPayload(await deleteModelEntry(entry.entryId))
    confirmingDelete.value = null
    notice.value = `已删除「${modelEntryLabel(entry)}」`
  } catch (error) {
    listError.value = error instanceof Error ? error.message : String(error)
  } finally {
    deletingId.value = null
  }
}
</script>

<template>
  <SettingsSection
    intro="按供应商管理模型的连接、凭证与能力。对话使用哪个模型，在聊天输入框中选择。"
  >
    <EmptyState v-if="!payload" title="正在读取模型配置…" variant="inline" />
    <template v-else>
      <p v-if="notice" class="notice" role="status">{{ notice }}</p>
      <p v-if="listError" class="list-error" role="alert">{{ listError }}</p>
      <Notice
        v-if="rejected.length"
        tone="warn"
        :title="`有 ${rejected.length} 个模型条目无法读取`"
        data-testid="model-rejected"
      >
        model_config.json
        里的这些条目不完整或格式不对，已先跳过，其余模型照常可用。可以删掉它们；要继续使用，就重新添加这个模型。
        <ul class="rejected-list">
          <li v-for="item in rejected" :key="item.key">
            <span class="rejected-name">{{ rejectedLabel(item) }}</span>
            <span class="rejected-reason">{{ item.reason }}</span>
            <Button size="sm" variant="secondary" @click="discardRejected(item)"
              >删除</Button
            >
          </li>
        </ul>
      </Notice>

      <SettingsGroup variant="stack" data-testid="model-entries">
        <SettingsCard
          v-for="group in groups"
          :key="group.provider"
          variant="outline"
          class="provider-card"
          :title="group.label"
          :data-provider="group.provider"
        >
          <template #leading>
            <Avatar
              kind="logo"
              :icon-id="group.iconId"
              :label="group.label"
              :size="40"
            />
          </template>
          <template #meta>
            <span class="model-count">{{ group.entries.length }} 个模型</span>
            <Badge
              v-if="providerCredentialState(group) === 'ok'"
              tone="ok"
              variant="dot-label"
            >
              Key 已配置
            </Badge>
            <Badge
              v-else-if="providerCredentialState(group) === 'reentry'"
              tone="warn"
              variant="dot-label"
            >
              凭据需要重新输入
            </Badge>
            <Badge
              v-else-if="providerCredentialState(group) === 'missing'"
              tone="warn"
              variant="dot-label"
            >
              缺少 API Key
            </Badge>
            <Badge v-else>本地 · 无需 Key</Badge>
          </template>
          <template #description>
            <span class="endpoint">{{ providerEndpointSummary(group) }}</span>
          </template>
          <template #actions>
            <Button
              size="sm"
              variant="secondary"
              :aria-label="`管理 ${group.label} 的模型`"
              @click="manage(group)"
            >
              管理模型
            </Button>
          </template>

          <ul class="model-list" :aria-label="`${group.label} 的模型`">
            <li
              v-for="entry in group.entries"
              :key="entry.entryId"
              class="model-row"
              :class="{ editing: editing === entry.entryId }"
              :data-highlight="highlight.has(entry.entryId) || undefined"
              :data-entry-id="entry.entryId"
              data-editor-host
            >
              <div class="model-line">
                <div class="model-text">
                  <span class="model-title">
                    <span class="model-name">{{ modelEntryLabel(entry) }}</span>
                    <Badge
                      v-if="entry.entryId === payload.activeModelId"
                      tone="accent"
                    >
                      当前
                    </Badge>
                    <Badge
                      v-if="entry.credentialState === 'needs_reentry'"
                      tone="warn"
                    >
                      凭据需要重新输入
                    </Badge>
                  </span>
                  <span class="model-meta">
                    <code class="model-id">{{ entry.modelId }}</code>
                    <Badge v-for="tag in capabilityTags(entry)" :key="tag">
                      {{ tag }}
                    </Badge>
                    <span v-if="contextLabel(entry)" class="context">
                      {{ contextLabel(entry) }}
                    </span>
                  </span>
                </div>
                <div class="model-actions">
                  <template v-if="confirmingDelete === entry.entryId">
                    <span class="confirm-text">确认删除？</span>
                    <Button
                      size="sm"
                      variant="secondary"
                      :disabled="deletingId === entry.entryId"
                      @click="confirmingDelete = null"
                    >
                      取消
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      :disabled="deletingId === entry.entryId"
                      :aria-label="`确认删除 ${modelEntryLabel(entry)}`"
                      @click="confirmDelete(entry)"
                    >
                      {{ deletingId === entry.entryId ? '删除中…' : '删除' }}
                    </Button>
                  </template>
                  <template v-else>
                    <Button
                      size="sm"
                      variant="ghost"
                      :aria-label="`编辑 ${modelEntryLabel(entry)}`"
                      :aria-expanded="editing === entry.entryId"
                      @click="toggleEdit(entry)"
                    >
                      编辑
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      class="delete"
                      :aria-label="`删除 ${modelEntryLabel(entry)}`"
                      @click="askDelete(entry)"
                    >
                      删除
                    </Button>
                  </template>
                </div>
              </div>
              <ModelEntryEditor
                v-if="editing === entry.entryId"
                class="row-editor"
                :entry="entry"
                :provider-options="providerOptions"
                @saved="onSaved"
                @cancel="closeEditor"
              />
            </li>
          </ul>
        </SettingsCard>

        <EmptyState
          v-if="!entries.length"
          title="还没有模型"
          description="添加一个模型后即可开始对话。"
          framed
        >
          <Button size="sm" variant="secondary" @click="openAdd">
            添加第一个模型
          </Button>
        </EmptyState>
      </SettingsGroup>

      <ModelPolicyGroup :payload="payload" @updated="applyPayload" />
      <AddModelDialog
        v-if="dialogOpen"
        :key="dialogKey"
        v-model:open="dialogOpen"
        :payload="payload"
        :manage-provider="manageProvider"
        @saved="onDialogSaved"
      />
    </template>
  </SettingsSection>
</template>

<style scoped>
.notice,
.list-error {
  margin: 0 0 var(--space-1);
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  color: rgb(var(--state-ok-label));
}

.list-error {
  color: rgb(var(--state-error-label));
  overflow-wrap: anywhere;
}

.model-count {
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  color: rgb(var(--label-tertiary));
}

.endpoint {
  font: var(--font-code-small);
  color: rgb(var(--label-tertiary));
  overflow-wrap: anywhere;
}

.model-list {
  display: flex;
  flex-direction: column;
  margin: 0;
  padding: 0;
  list-style: none;
}

.model-row {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  min-width: 0;
  padding: var(--space-2-5) 0;
}

.model-row:first-child {
  padding-top: 0;
}

.model-row:last-child {
  padding-bottom: 0;
}

.model-row + .model-row {
  border-top: 1px solid var(--border-l1);
}

.model-line {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-width: 0;
}

.model-text {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: var(--space-0-5);
  min-width: 0;
}

.model-title {
  display: flex;
  align-items: center;
  gap: var(--space-1-5);
  min-width: 0;
}

.model-name {
  min-width: 0;
  overflow: hidden;
  font-size: var(--fs-s);
  line-height: var(--lh-s);
  color: rgb(var(--label-primary));
  text-overflow: ellipsis;
  white-space: nowrap;
}

.model-row.editing .model-name {
  font-weight: 500;
}

.model-meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-1) var(--space-2);
  min-width: 0;
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  color: rgb(var(--label-tertiary));
}

.model-id {
  min-width: 0;
  font: var(--font-code-small);
  color: rgb(var(--label-secondary));
  overflow-wrap: anywhere;
}

.model-actions {
  display: flex;
  flex: none;
  align-items: center;
  gap: var(--space-1);
}

.model-actions .delete {
  color: rgb(var(--state-error-label));
}

.row-editor {
  padding: var(--space-3) var(--space-3-5);
  border-radius: var(--radius-cell);
  background: rgb(var(--bg-layer-2));
}

.confirm-text {
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  color: rgb(var(--label-secondary));
  white-space: nowrap;
}

.rejected-list {
  display: grid;
  gap: var(--space-1);
  margin: var(--space-2) 0 0;
  padding: 0;
  list-style: none;
}

.rejected-list li {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

.rejected-name {
  flex: none;
  font-weight: 500;
}

.rejected-reason {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
  color: rgb(var(--text-2));
}

.model-row[data-highlight] {
  border-radius: var(--r-sm);
  background: rgb(var(--accent) / 0.08);
  transition: background-color var(--motion-slow) var(--ease-standard);
}
</style>
