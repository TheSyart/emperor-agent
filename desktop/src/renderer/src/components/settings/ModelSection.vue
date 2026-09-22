<script setup lang="ts">
/**
 * Settings › 模型 — native section (dsh ModelsSection pattern): one outlined
 * row card per saved model entry; 「编辑」 expands the entry editor inside its
 * card (no nested dialog), 「删除」 asks inline. 「添加模型」 (header primary)
 * opens a filled add card above the rows; with no models yet the add card is
 * open from the start. The execution / cost policy is a SettingsGroup of rows
 * below the list. The model used by a conversation is picked in the composer,
 * not here.
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
import { DsPlus } from '../icons/ds'
import ModelEntryEditor from './model/ModelEntryEditor.vue'
import ModelPolicyGroup from './model/ModelPolicyGroup.vue'
import ProviderMark from './model/ProviderMark.vue'
import { modelEntryLabel, PROTOCOL_SHORT_LABELS } from './model/modelFormModel'
import { refreshAction, useSettingsHeader } from './settingsHeader'
import {
  EmptyState,
  SettingsCard,
  SettingsGroup,
  SettingsSection,
  StatusBadge,
} from './ui'

const ctx = useAppContext()

const payload = computed<ModelConfigPayload | null>(
  () => ctx.boot.value?.modelConfig ?? null,
)
const entries = computed(() => payload.value?.models ?? [])
const providerOptions = computed<ProviderOption[]>(
  () => payload.value?.providerOptions ?? [],
)

/** 'new' = the add card, an entry id = that row's editor, null = closed. */
const editing = ref<string | null>(null)
const confirmingDelete = ref<string | null>(null)
const deletingId = ref<string | null>(null)
const notice = ref('')
const listError = ref('')
/** Bumped to remount the add editor with a fresh draft. */
const addRevision = ref(0)

// First-run posture: with nothing configured the add card is the page.
watch(
  () => Boolean(payload.value) && entries.value.length === 0,
  (empty) => {
    if (empty && editing.value === null) editing.value = 'new'
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

function providerOf(entry: ModelEntry): ProviderOption | undefined {
  return providerOptions.value.find((option) => option.name === entry.provider)
}

function providerLabel(entry: ModelEntry): string {
  const provider = providerOf(entry)
  return provider?.displayName || provider?.name || entry.provider
}

function resetTransient(): void {
  notice.value = ''
  listError.value = ''
  confirmingDelete.value = null
}

function openAdd(): void {
  resetTransient()
  if (editing.value !== 'new') editing.value = 'new'
  else addRevision.value += 1
}

function toggleEdit(entry: ModelEntry): void {
  resetTransient()
  if (editing.value === entry.entryId) closeEditor()
  else editing.value = entry.entryId
}

function closeEditor(): void {
  const entryId = editing.value
  editing.value = null
  if (entryId && entryId !== 'new') void focusEditButton(entryId)
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
    intro="管理模型的连接、凭证与能力。对话使用哪个模型，在聊天输入框中选择。"
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
          v-if="editing === 'new'"
          :key="`add-${addRevision}`"
          variant="outline"
          class="model-row editing"
          title="添加模型"
          data-testid="model-add-card"
          data-editor-host
        >
          <ModelEntryEditor
            :entry="null"
            :provider-options="providerOptions"
            @saved="onSaved"
            @cancel="closeEditor"
          />
        </SettingsCard>

        <SettingsCard
          v-for="entry in entries"
          :key="entry.entryId"
          variant="outline"
          class="model-row"
          :class="{ editing: editing === entry.entryId }"
          :title="modelEntryLabel(entry)"
          :data-entry-id="entry.entryId"
          data-editor-host
        >
          <template #leading>
            <ProviderMark
              :icon-id="providerOf(entry)?.iconId || entry.provider"
              :label="providerLabel(entry)"
            />
          </template>
          <template #meta>
            <StatusBadge
              v-if="entry.entryId === payload.activeModelId"
              tone="accent"
            >
              当前
            </StatusBadge>
          </template>
          <template #description>
            <span class="row-meta">
              <code class="model-id">{{ entry.modelId }}</code>
              <span>
                {{ providerLabel(entry) }} ·
                {{ PROTOCOL_SHORT_LABELS[entry.protocol] }}
              </span>
            </span>
          </template>
          <template #actions>
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
                variant="outline"
                :aria-label="`编辑 ${modelEntryLabel(entry)}`"
                :aria-expanded="editing === entry.entryId"
                @click="toggleEdit(entry)"
              >
                编辑
              </Button>
              <Button
                size="sm"
                variant="danger"
                :aria-label="`删除 ${modelEntryLabel(entry)}`"
                @click="askDelete(entry)"
              >
                删除
              </Button>
            </template>
          </template>
          <template v-if="editing === entry.entryId" #default>
            <ModelEntryEditor
              :entry="entry"
              :provider-options="providerOptions"
              @saved="onSaved"
              @cancel="closeEditor"
            />
          </template>
        </SettingsCard>

        <EmptyState
          v-if="!entries.length && editing !== 'new'"
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

.model-row.editing {
  border-color: rgb(var(--label-dimmed));
}

.row-meta {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  column-gap: var(--space-2);
  min-width: 0;
}

.model-id {
  min-width: 0;
  font: var(--font-code-small);
  color: rgb(var(--label-secondary));
  overflow-wrap: anywhere;
}

.confirm-text {
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  color: rgb(var(--label-secondary));
  white-space: nowrap;
}
</style>
