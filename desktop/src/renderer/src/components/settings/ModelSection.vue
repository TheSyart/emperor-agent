<script setup lang="ts">
/**
 * Settings › 模型 — saved model entries grouped by provider (dsh
 * ModelsSection pattern): one outlined card per provider (logo, name, model
 * count, key status, endpoint) listing its models as rows. 「编辑」 expands the
 * entry editor under its row (no nested dialog), 「删除」 asks inline.
 *
 * Adding a model: the header's 「添加模型」 opens an add card whose first step
 * is the provider picker (logo tiles by region); a provider card's own
 * 「添加模型」 skips the picker. A model added under a provider that already
 * has a saved key reuses it (`credentialsFrom`) until another key is typed.
 * With no models yet the add card is open from the start. The execution /
 * cost policy is a SettingsGroup of rows below the list. The model used by a
 * conversation is picked in the composer, not here.
 *
 * Every write returns the full model config payload, which is applied to the
 * bootstrap state (current model, provider, availability, profile
 * onboarding) — the same contract the retired ModelView had.
 */
import { computed, nextTick, ref, watch } from 'vue'
import { deleteModelEntry } from '../../api/model'
import { core } from '../../api/http'
import { useAppContext } from '../../composables/useAppContext'
import type {
  ModelConfigPayload,
  ModelEntry,
  ProviderOption,
} from '../../types'
import Button from '../ui/Button.vue'
import ProviderLogo from '../ui/ProviderLogo.vue'
import { DsPlus } from '../icons/ds'
import ModelEntryEditor from './model/ModelEntryEditor.vue'
import ModelPolicyGroup from './model/ModelPolicyGroup.vue'
import ProviderPicker from './model/ProviderPicker.vue'
import {
  CAPABILITY_ROWS,
  CAPABILITY_TAGS,
  formatTokenCount,
  modelEntryLabel,
} from './model/modelFormModel'
import {
  credentialSourceEntry,
  groupEntriesByProvider,
  providerCredentialState,
  providerDisplayName,
  providerEndpointSummary,
  type ProviderGroup,
} from '../../model/providerGroups'
import { refreshAction, useSettingsHeader } from './settingsHeader'
import {
  EmptyState,
  SettingsCard,
  SettingsGroup,
  SettingsSection,
  StatusBadge,
} from './ui'

/**
 * The add flow: `pick` shows the provider picker; `form` the new-entry
 * editor for `provider` — in the top add card, or inside that provider's
 * card when `inGroup`.
 */
type AddState =
  | { step: 'pick' }
  | {
      step: 'form'
      provider: string
      source: ModelEntry | null
      inGroup: boolean
    }

const ctx = useAppContext()

const payload = computed<ModelConfigPayload | null>(
  () => ctx.boot.value?.modelConfig ?? null,
)
const entries = computed(() => payload.value?.models ?? [])
const providerOptions = computed<ProviderOption[]>(
  () => payload.value?.providerOptions ?? [],
)
const groups = computed(() =>
  groupEntriesByProvider(entries.value, providerOptions.value),
)
const modelCounts = computed(() =>
  Object.fromEntries(
    groups.value.map((group) => [group.provider, group.entries.length]),
  ),
)

const adding = ref<AddState | null>(null)
/** The saved entry whose editor is open. */
const editing = ref<string | null>(null)
const confirmingDelete = ref<string | null>(null)
const deletingId = ref<string | null>(null)
const notice = ref('')
const listError = ref('')
/** Bumped to remount the add editor with a fresh draft. */
const addRevision = ref(0)

const topAdd = computed(() =>
  adding.value && !(adding.value.step === 'form' && adding.value.inGroup)
    ? adding.value
    : null,
)

// First-run posture: with nothing configured the add card is the page.
watch(
  () => Boolean(payload.value) && entries.value.length === 0,
  (empty) => {
    if (empty && !adding.value) adding.value = { step: 'pick' }
  },
  { immediate: true },
)

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

function groupOf(provider: string): ProviderGroup | undefined {
  return groups.value.find((group) => group.provider === provider)
}

function optionOf(provider: string): ProviderOption | undefined {
  return providerOptions.value.find((option) => option.name === provider)
}

function addingIn(group: ProviderGroup): boolean {
  const state = adding.value
  return Boolean(
    state?.step === 'form' &&
    state.inGroup &&
    state.provider === group.provider,
  )
}

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
  adding.value = { step: 'pick' }
  addRevision.value += 1
}

function startAdd(provider: string, inGroup: boolean): void {
  resetTransient()
  editing.value = null
  adding.value = {
    step: 'form',
    provider,
    source: credentialSourceEntry(groupOf(provider)),
    inGroup,
  }
  addRevision.value += 1
}

function toggleEdit(entry: ModelEntry): void {
  resetTransient()
  adding.value = null
  if (editing.value === entry.entryId) closeEditor()
  else editing.value = entry.entryId
}

function closeAdd(): void {
  adding.value = null
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
  adding.value = null
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
    <EmptyState
      v-if="!payload"
      title="正在读取模型配置…"
      variant="plain"
      compact
    />
    <template v-else>
      <p v-if="notice" class="notice" role="status">{{ notice }}</p>
      <p v-if="listError" class="list-error" role="alert">{{ listError }}</p>

      <SettingsGroup variant="stack" data-testid="model-entries">
        <SettingsCard
          v-if="topAdd"
          :key="`add-${addRevision}`"
          variant="outline"
          class="add-card"
          :title="
            topAdd.step === 'pick'
              ? '添加模型 · 选择供应商'
              : `添加模型 · ${providerDisplayName(topAdd.provider, optionOf(topAdd.provider))}`
          "
          data-testid="model-add-card"
          data-editor-host
        >
          <template #actions>
            <Button
              v-if="topAdd.step === 'pick' && entries.length"
              size="sm"
              variant="outline"
              @click="closeAdd"
            >
              取消
            </Button>
          </template>
          <ProviderPicker
            v-if="topAdd.step === 'pick'"
            :options="providerOptions"
            :counts="modelCounts"
            @pick="(provider) => startAdd(provider, false)"
          />
          <ModelEntryEditor
            v-else
            :entry="null"
            :provider="topAdd.provider"
            :source="topAdd.source"
            :provider-options="providerOptions"
            @saved="onSaved"
            @cancel="closeAdd"
          />
        </SettingsCard>

        <SettingsCard
          v-for="group in groups"
          :key="group.provider"
          variant="outline"
          class="provider-card"
          :title="group.label"
          :data-provider="group.provider"
        >
          <template #leading>
            <ProviderLogo
              :icon-id="group.iconId"
              :label="group.label"
              size="lg"
            />
          </template>
          <template #meta>
            <span class="model-count">{{ group.entries.length }} 个模型</span>
            <StatusBadge
              v-if="providerCredentialState(group) === 'ok'"
              tone="ok"
              dot
            >
              Key 已配置
            </StatusBadge>
            <StatusBadge
              v-else-if="providerCredentialState(group) === 'missing'"
              tone="warn"
              dot
            >
              缺少 API Key
            </StatusBadge>
            <StatusBadge v-else>本地 · 无需 Key</StatusBadge>
          </template>
          <template #description>
            <span class="endpoint">{{ providerEndpointSummary(group) }}</span>
          </template>
          <template #actions>
            <Button
              size="sm"
              variant="outline"
              :aria-label="`在 ${group.label} 下添加模型`"
              :aria-expanded="addingIn(group)"
              @click="
                addingIn(group) ? closeAdd() : startAdd(group.provider, true)
              "
            >
              <template #icon><DsPlus :size="14" /></template>
              添加模型
            </Button>
          </template>

          <div
            v-if="addingIn(group) && adding?.step === 'form'"
            :key="`add-${addRevision}`"
            class="group-add"
            data-testid="model-add-card"
            data-editor-host
          >
            <h4 class="group-add-title">添加 {{ group.label }} 模型</h4>
            <ModelEntryEditor
              :entry="null"
              :provider="adding.provider"
              :source="adding.source"
              :provider-options="providerOptions"
              @saved="onSaved"
              @cancel="closeAdd"
            />
          </div>

          <ul class="model-list" :aria-label="`${group.label} 的模型`">
            <li
              v-for="entry in group.entries"
              :key="entry.entryId"
              class="model-row"
              :class="{ editing: editing === entry.entryId }"
              :data-entry-id="entry.entryId"
              data-editor-host
            >
              <div class="model-line">
                <div class="model-text">
                  <span class="model-title">
                    <span class="model-name">{{ modelEntryLabel(entry) }}</span>
                    <StatusBadge
                      v-if="entry.entryId === payload.activeModelId"
                      tone="accent"
                    >
                      当前
                    </StatusBadge>
                  </span>
                  <span class="model-meta">
                    <code class="model-id">{{ entry.modelId }}</code>
                    <span
                      v-for="tag in capabilityTags(entry)"
                      :key="tag"
                      class="cap-tag"
                    >
                      {{ tag }}
                    </span>
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
                      variant="outline"
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
          v-if="!entries.length && !adding"
          title="还没有模型"
          description="添加一个模型后即可开始对话。"
        >
          <Button size="sm" variant="outline" @click="openAdd">
            添加第一个模型
          </Button>
        </EmptyState>
      </SettingsGroup>

      <ModelPolicyGroup :payload="payload" @updated="applyPayload" />
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

.add-card {
  border-color: rgb(var(--label-dimmed));
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

.group-add {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-3-5);
  border-radius: var(--radius-cell);
  background: rgb(var(--bg-layer-2));
}

.group-add-title {
  margin: 0;
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  font-weight: 500;
  color: rgb(var(--label-primary));
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

.cap-tag {
  padding: 0 var(--space-1);
  border: 1px solid var(--border-l2);
  border-radius: var(--radius-xs);
  font-size: var(--fs-xxxs);
  line-height: var(--lh-xxxs);
  color: rgb(var(--label-secondary));
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
</style>
