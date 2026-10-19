<script setup lang="ts">
/**
 * 智能体权限 (PLAN-CAP-001 RV-09) — 设置 › 电脑操作 › Chrome 和 Edge: where
 * Emperor may browse and download in the user's own Chrome or Edge.
 *
 * A table 「网站或模式 · 浏览 · 下载」: the 默认 row (浏览 允许 and 下载
 * 需要批准 unless changed) cannot be removed; each exception (a host, a host
 * with its subdomains `*.host`, or an exact origin) has a remove button.
 * Every cell is a Select of 允许 / 需要批准 / 阻止, saved at once through
 * `computerUse.setExternalBrowserSettings`; Core normalizes patterns and
 * says what is wrong with one. 「+ 添加」 (beside the group title) opens a
 * dialog for one site or pattern and its two permissions. A note under the
 * card says only sites with their own permissions are listed.
 *
 * Several root nodes (the group, its notes, the dialog): the page places
 * them straight into its SettingsSection, so the group keeps the section's
 * spacing.
 */
import type { CoreOperationArgs } from '@emperor/core/api'
import type {
  ExternalBrowserSettings,
  ExternalSiteDecision,
  ExternalSiteRule,
} from '@emperor/core/runtime-contract'
import { onMounted, ref, shallowRef } from 'vue'
import { core } from '../../../../api/http'
import { DsClose, DsPlus } from '../../../icons/ds'
import Button from '../../../ui/Button.vue'
import IconButton from '../../../ui/IconButton.vue'
import Modal from '../../../ui/Modal.vue'
import {
  Field,
  Select,
  SettingsGroup,
  SettingsTable,
  SettingsTableRow,
  TextField,
  type SelectOption,
  type SettingsTableColumn,
} from '../../ui'

type Patch = CoreOperationArgs<'computerUse.setExternalBrowserSettings'>[0]

const COLUMNS: SettingsTableColumn[] = [
  { key: 'site', label: '网站或模式', width: 'minmax(0, 1.25fr)' },
  { key: 'browse', label: '浏览' },
  { key: 'download', label: '下载' },
  { key: 'remove', label: '', width: '44px' },
]

const DECISIONS: readonly SelectOption<ExternalSiteDecision>[] = [
  { value: 'allow', label: '允许' },
  { value: 'ask', label: '需要批准' },
  { value: 'block', label: '阻止' },
]

const settings = shallowRef<ExternalBrowserSettings | null>(null)
const saving = ref(false)
const error = ref('')
const dialogOpen = ref(false)
const pattern = ref('')
const browse = ref<ExternalSiteDecision>('allow')
const download = ref<ExternalSiteDecision>('ask')
const dialogError = ref('')

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

async function save(patch: Patch): Promise<string> {
  saving.value = true
  try {
    settings.value = await core('computerUse.setExternalBrowserSettings', patch)
    return ''
  } catch (cause) {
    return message(cause)
  } finally {
    saving.value = false
  }
}

async function change(patch: Patch): Promise<void> {
  if (saving.value) return
  error.value = await save(patch)
}

function setDefault(
  kind: 'browse' | 'download',
  value: ExternalSiteDecision | undefined,
) {
  if (value !== undefined) void change({ defaults: { [kind]: value } })
}

function setRule(
  rule: ExternalSiteRule,
  kind: 'browse' | 'download',
  value: ExternalSiteDecision | undefined,
) {
  if (value === undefined) return
  void change({
    sites: (settings.value?.sites ?? []).map((item) =>
      item.pattern === rule.pattern ? { ...item, [kind]: value } : item,
    ),
  })
}

function remove(rule: ExternalSiteRule) {
  void change({
    sites: (settings.value?.sites ?? []).filter(
      (item) => item.pattern !== rule.pattern,
    ),
  })
}

function openDialog() {
  pattern.value = ''
  browse.value = settings.value?.defaults.browse ?? 'allow'
  download.value = settings.value?.defaults.download ?? 'ask'
  dialogError.value = ''
  dialogOpen.value = true
}

async function add() {
  if (saving.value || !pattern.value.trim()) return
  dialogError.value = await save({
    sites: [
      ...(settings.value?.sites ?? []),
      {
        pattern: pattern.value.trim(),
        browse: browse.value,
        download: download.value,
      },
    ],
  })
  if (!dialogError.value) dialogOpen.value = false
}

onMounted(async () => {
  try {
    settings.value = await core('computerUse.externalBrowserSettings')
  } catch (cause) {
    error.value = message(cause)
  }
})
</script>

<template>
  <SettingsGroup
    title="智能体权限"
    description="选择默认权限，并为特定网站添加例外"
    data-group="agent-permissions"
  >
    <template #actions>
      <Button
        size="sm"
        variant="secondary"
        data-action="add-site-rule"
        :disabled="settings === null || saving"
        @click="openDialog"
      >
        <template #icon><DsPlus :size="14" /></template>
        添加
      </Button>
    </template>
    <SettingsTable :columns="COLUMNS" aria-label="智能体权限">
      <template v-if="settings">
        <SettingsTableRow data-rule="default">
          <span class="site">默认</span>
          <Select
            size="sm"
            :model-value="settings.defaults.browse"
            :options="DECISIONS"
            :data-decision="settings.defaults.browse"
            :disabled="saving"
            aria-label="默认 浏览"
            @update:model-value="(value) => setDefault('browse', value)"
          />
          <Select
            size="sm"
            :model-value="settings.defaults.download"
            :options="DECISIONS"
            :data-decision="settings.defaults.download"
            :disabled="saving"
            aria-label="默认 下载"
            @update:model-value="(value) => setDefault('download', value)"
          />
          <span />
        </SettingsTableRow>
        <SettingsTableRow
          v-for="rule in settings.sites"
          :key="rule.pattern"
          :data-rule="rule.pattern"
        >
          <span class="site mono">{{ rule.pattern }}</span>
          <Select
            size="sm"
            :model-value="rule.browse"
            :options="DECISIONS"
            :data-decision="rule.browse"
            :disabled="saving"
            :aria-label="`${rule.pattern} 浏览`"
            @update:model-value="(value) => setRule(rule, 'browse', value)"
          />
          <Select
            size="sm"
            :model-value="rule.download"
            :options="DECISIONS"
            :data-decision="rule.download"
            :disabled="saving"
            :aria-label="`${rule.pattern} 下载`"
            @update:model-value="(value) => setRule(rule, 'download', value)"
          />
          <IconButton
            :label="`删除 ${rule.pattern}`"
            :disabled="saving"
            @click="remove(rule)"
          >
            <DsClose :size="14" />
          </IconButton>
        </SettingsTableRow>
      </template>
    </SettingsTable>
  </SettingsGroup>
  <p class="agent-permissions-note">此处仅显示设置了自定义权限的网站</p>
  <p v-if="error" class="agent-permissions-error" role="alert">{{ error }}</p>
  <Modal v-model:open="dialogOpen" title="添加网站" :width="440">
    <form id="site-rule-form" class="site-rule-form" @submit.prevent="add">
      <Field
        label="网站或模式"
        :error="dialogError || undefined"
        hint="例如 example.com、*.example.com（含子域名）、https://example.com:8443"
      >
        <TextField
          v-model="pattern"
          required
          monospace
          placeholder="example.com"
          spellcheck="false"
          autocomplete="off"
        />
      </Field>
      <Field label="浏览">
        <Select
          v-model="browse"
          :options="DECISIONS"
          aria-label="新网站 浏览"
          block
        />
      </Field>
      <Field label="下载">
        <Select
          v-model="download"
          :options="DECISIONS"
          aria-label="新网站 下载"
          block
        />
      </Field>
    </form>
    <template #footer>
      <Button variant="secondary" type="button" @click="dialogOpen = false"
        >取消</Button
      >
      <Button
        variant="primary"
        type="submit"
        form="site-rule-form"
        :disabled="saving || !pattern.trim()"
        >添加</Button
      >
    </template>
  </Modal>
</template>

<style scoped>
.site {
  min-width: 0;
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  font-weight: 500;
  color: rgb(var(--label-primary));
  overflow-wrap: anywhere;
}

.site.mono {
  font-family: var(--font-mono);
  font-weight: 400;
}

/* 需要批准 reads as a warning, 阻止 as an error (as in the preview). */
.ds-settings-table :deep(.ds-select[data-decision='ask'] .value) {
  color: rgb(var(--state-warn-label));
}

.ds-settings-table :deep(.ds-select[data-decision='block'] .value) {
  color: rgb(var(--state-error-label));
}

.agent-permissions-note {
  margin: var(--space-2) var(--space-0-5) 0;
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  color: rgb(var(--label-tertiary));
}

.agent-permissions-error {
  margin: var(--space-2) var(--space-0-5) 0;
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  color: rgb(var(--state-error-label));
}

.site-rule-form {
  display: grid;
  gap: var(--space-3);
}
</style>
