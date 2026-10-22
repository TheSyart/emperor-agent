<script setup lang="ts">
/**
 * Settings › 模型 (MOD-05) — one card per provider: the logo, name and the
 * connection's state (「已连接」「Key 无效 · N 天前测试」「未测试」, or what
 * the key lacks), the key's last 4 characters and the host; 「管理模型」 and
 * the card's 「⋯」: 更换 Key (every model on the connection, one
 * `model.updateConnection`, after saying how many change), 编辑地址, 刷新模型
 * 资料 (the differences first, then 「应用」) and 删除供应商. Its models are
 * rows (model/ModelRow): 「测试」「编辑」「⋯ › 删除」 on hover; a retired model
 * offers 「替换为 X」 (`model.replaceEntry`: the replacement takes its
 * place, the active and the backup model follow). 「编辑」 opens the simple
 * editor under the row (model/ModelEntryEditor).
 *
 * Adding models: the header's 「添加模型」 opens the three-step dialog
 * (model/AddModelDialog); a card's 「管理模型」 opens it at step 2 for that
 * provider. With no models yet the dialog opens by itself. Saved rows are
 * highlighted and the first new model gets a text test in the background.
 * The execution / cost policy (model/ModelPolicyGroup) saves as it changes.
 * The model a conversation uses is picked in the composer, not here.
 *
 * Every write returns the full model config payload, which is applied to the
 * bootstrap state (model/applyModelConfig: current model, provider,
 * availability).
 */
import { computed, defineAsyncComponent, nextTick, ref, watch } from 'vue'
import { deleteModelEntry, testModelEntry } from '../../api/model'
import { addModelRequested, takeAddModelRequest } from './model/addModelRequest'
import { core } from '../../api/http'
import { useAppContext } from '../../composables/useAppContext'
import { applyModelConfig } from '../../model/applyModelConfig'
import type {
  ModelConfigPayload,
  ModelEntry,
  ProviderOption,
} from '../../types'
import Button from '../ui/Button.vue'
import Avatar from '../ui/Avatar.vue'
import { DsPlus } from '../icons/ds'
import ConnectionAddressDialog from './model/ConnectionAddressDialog.vue'
import ConnectionKeyDialog from './model/ConnectionKeyDialog.vue'
import MetadataRefreshDialog from './model/MetadataRefreshDialog.vue'
import ModelEntryEditor from './model/ModelEntryEditor.vue'
import ModelPolicyGroup from './model/ModelPolicyGroup.vue'
import ModelRow from './model/ModelRow.vue'
import { modelEntryLabel, modelTestSummary } from './model/modelFormModel'
import {
  connectionStatus,
  hostOf,
  keyTail,
  sameConnection,
} from './model/modelListModel'
import {
  groupEntriesByProvider,
  providerCredentialState,
  type ProviderGroup,
} from '../../model/providerGroups'
import { refreshAction, useSettingsHeader } from './settingsHeader'
import {
  EmptyState,
  Notice,
  SettingsCard,
  SettingsGroup,
  SettingsRowMenu,
  SettingsSection,
  Badge,
} from './ui'
import { confirm } from '../ui/confirm'
import type { RejectedModelEntryPayload } from '../../types'

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
const notice = ref('')
const listError = ref('')
/** Row tests of this visit: running, and their one-line outcome. */
const testing = ref<Set<string>>(new Set())
const testSummaries = ref<Record<string, string>>({})

/** The connection dialogs: which one is open, for which models. */
type ConnectionDialog = 'key' | 'address' | 'refresh'
const connectionDialog = ref<ConnectionDialog | null>(null)
const dialogEntries = ref<ModelEntry[]>([])
const dialogLabel = ref('')
const dialogVisible = computed({
  get: () => connectionDialog.value !== null,
  set: (open: boolean) => {
    if (!open) connectionDialog.value = null
  },
})

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

/** The card's status: what the key lacks first, then the last test. */
function cardStatus(group: ProviderGroup): {
  text: string
  tone: 'ok' | 'warn' | 'error' | 'neutral'
} {
  const state = providerCredentialState(group)
  if (state === 'reentry') return { text: '凭据需要重新输入', tone: 'warn' }
  if (state === 'missing') return { text: '缺少 API Key', tone: 'warn' }
  const status = connectionStatus(group.entries)
  if (state === 'keyless' && status.text === '未测试')
    return { text: '本地 · 无需 Key', tone: 'neutral' }
  return status
}

function cardDetail(group: ProviderGroup): string {
  const hosts = [
    ...new Set(group.entries.map((entry) => hostOf(entry.apiBase))),
  ].filter(Boolean)
  return [hosts.join('、'), keyTail(group.entries)].filter(Boolean).join(' · ')
}

function connectionOf(entry: ModelEntry): ModelEntry[] {
  return entries.value.filter((item) => sameConnection(item, entry))
}

function resetTransient(): void {
  notice.value = ''
  listError.value = ''
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

function openConnection(
  kind: ConnectionDialog,
  label: string,
  models: ModelEntry[],
): void {
  resetTransient()
  dialogLabel.value = label
  dialogEntries.value = models
  connectionDialog.value = kind
}

function cardMenu(group: ProviderGroup) {
  const lead = group.entries[0]!
  return [
    {
      id: 'change-key',
      label: '更换 Key',
      onSelect: () => openConnection('key', group.label, connectionOf(lead)),
    },
    {
      id: 'edit-address',
      label: '编辑地址',
      onSelect: () =>
        openConnection('address', group.label, connectionOf(lead)),
    },
    {
      id: 'refresh-metadata',
      label: '刷新模型资料',
      onSelect: () => openConnection('refresh', group.label, group.entries),
    },
    {
      id: 'delete-provider',
      label: '删除供应商',
      danger: true,
      onSelect: () => deleteProvider(group),
    },
  ]
}

function editAddress(entry: ModelEntry): void {
  const group = groups.value.find((item) => item.provider === entry.provider)
  openConnection('address', group?.label ?? entry.provider, connectionOf(entry))
}

async function onConnectionSaved(next: ModelConfigPayload): Promise<void> {
  applyPayload(next)
  notice.value =
    connectionDialog.value === 'refresh' ? '已更新模型资料' : '已更新连接'
}

/** The dialog saved: show the new rows and test the first one quietly. */
async function onDialogSaved(
  result: ModelConfigPayload & { savedEntryIds: string[] },
): Promise<void> {
  applyPayload(result)
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
  await reload({ quiet: true })
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

function applyPayload(next: ModelConfigPayload): void {
  applyModelConfig(ctx.boot.value, next)
}

async function onSaved(next: ModelConfigPayload, label: string): Promise<void> {
  editing.value = null
  notice.value = `已保存「${label}」`
  applyPayload(next)
}

async function reload(options: { quiet?: boolean } = {}): Promise<void> {
  if (!options.quiet) listError.value = ''
  try {
    const next = await core('model.getConfig')
    if (next && Array.isArray(next.models)) applyPayload(next)
  } catch (error) {
    if (!options.quiet)
      listError.value = error instanceof Error ? error.message : String(error)
  }
}

/** Test a model; the row says how it went, the card's status follows. */
async function testEntry(entry: ModelEntry): Promise<void> {
  if (testing.value.has(entry.entryId)) return
  testing.value = new Set([...testing.value, entry.entryId])
  try {
    const result = await testModelEntry(entry.entryId, 'text')
    testSummaries.value = {
      ...testSummaries.value,
      [entry.entryId]: modelTestSummary(result),
    }
  } catch (error) {
    testSummaries.value = {
      ...testSummaries.value,
      [entry.entryId]: error instanceof Error ? error.message : String(error),
    }
  } finally {
    const next = new Set(testing.value)
    next.delete(entry.entryId)
    testing.value = next
  }
  await reload({ quiet: true })
}

async function replaceEntry(entry: ModelEntry, modelId: string): Promise<void> {
  resetTransient()
  try {
    const result = await core('model.replaceEntry', {
      entryId: entry.entryId,
      modelId,
    })
    applyPayload(result)
    highlight.value = new Set([result.replacedEntryId])
    clearTimeout(highlightTimer)
    highlightTimer = setTimeout(() => (highlight.value = new Set()), 4000)
    notice.value = `已把「${modelEntryLabel(entry)}」换成 ${modelId}`
  } catch (error) {
    listError.value = error instanceof Error ? error.message : String(error)
  }
}

async function deleteEntry(entry: ModelEntry): Promise<void> {
  const label = modelEntryLabel(entry)
  if (
    !(await confirm({
      title: `删除「${label}」？`,
      body: '这个模型会从 model_config.json 里删掉；同一连接下的其他模型不受影响。',
      confirmLabel: '删除',
      tone: 'danger',
    }))
  )
    return
  resetTransient()
  if (editing.value === entry.entryId) editing.value = null
  try {
    applyPayload(await deleteModelEntry(entry.entryId))
    notice.value = `已删除「${label}」`
  } catch (error) {
    listError.value = error instanceof Error ? error.message : String(error)
  }
}

async function deleteProvider(group: ProviderGroup): Promise<void> {
  resetTransient()
  if (
    group.entries.some(
      (entry) => entry.entryId === payload.value?.activeModelId,
    )
  ) {
    listError.value = `「${group.label}」里有正在使用的模型，先在输入框换成别的模型再删除`
    return
  }
  if (
    !(await confirm({
      title: `删除供应商「${group.label}」？`,
      body: `它的 ${group.entries.length} 个模型和保存的 Key 都会删除，无法恢复。`,
      confirmLabel: '删除',
      tone: 'danger',
    }))
  )
    return
  try {
    let next: ModelConfigPayload | null = null
    for (const entry of group.entries)
      next = await deleteModelEntry(entry.entryId)
    if (next) applyPayload(next)
    notice.value = `已删除「${group.label}」`
  } catch (error) {
    listError.value = error instanceof Error ? error.message : String(error)
    await reload({ quiet: true })
  }
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
    applyPayload(await core('model.discardRejected', { key: item.key }))
    notice.value = `已删除「${rejectedLabel(item)}」`
  } catch (error) {
    listError.value = error instanceof Error ? error.message : String(error)
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
            <Badge
              :tone="cardStatus(group).tone"
              variant="dot-label"
              data-connection-status
              >{{ cardStatus(group).text }}</Badge
            >
          </template>
          <template #description>
            <span class="endpoint">{{ cardDetail(group) }}</span>
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
            <SettingsRowMenu
              :label="`${group.label} 的更多操作`"
              :items="cardMenu(group)"
            />
          </template>

          <ul class="model-list" :aria-label="`${group.label} 的模型`">
            <ModelRow
              v-for="entry in group.entries"
              :key="entry.entryId"
              :entry="entry"
              :active="entry.entryId === payload.activeModelId"
              :editing="editing === entry.entryId"
              :highlight="highlight.has(entry.entryId)"
              :testing="testing.has(entry.entryId)"
              :test-summary="testSummaries[entry.entryId] ?? ''"
              @test="testEntry(entry)"
              @edit="toggleEdit(entry)"
              @delete="deleteEntry(entry)"
              @replace="(modelId: string) => replaceEntry(entry, modelId)"
            >
              <ModelEntryEditor
                v-if="editing === entry.entryId"
                :entry="entry"
                :provider-options="providerOptions"
                @saved="onSaved"
                @cancel="closeEditor"
                @edit-address="editAddress(entry)"
              />
            </ModelRow>
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
      <ConnectionKeyDialog
        v-if="connectionDialog === 'key'"
        v-model:open="dialogVisible"
        :label="dialogLabel"
        :entries="dialogEntries"
        @saved="onConnectionSaved"
      />
      <ConnectionAddressDialog
        v-if="connectionDialog === 'address'"
        v-model:open="dialogVisible"
        :label="dialogLabel"
        :entries="dialogEntries"
        @saved="onConnectionSaved"
      />
      <MetadataRefreshDialog
        v-if="connectionDialog === 'refresh'"
        v-model:open="dialogVisible"
        :label="dialogLabel"
        :entries="dialogEntries"
        @updated="onConnectionSaved"
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

.endpoint {
  font: var(--font-code-small);
  color: rgb(var(--text-3));
  overflow-wrap: anywhere;
}

.model-list {
  display: flex;
  flex-direction: column;
  margin: 0;
  padding: 0;
  list-style: none;
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
  font-weight: var(--weight-medium);
}

.rejected-reason {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
  color: rgb(var(--text-2));
}
</style>
