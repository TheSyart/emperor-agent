<script setup lang="ts">
import { Pencil, Plus, Trash2 } from 'lucide-vue-next'
import type { ModelEntry, ProviderOption } from '../../../types'
import {
  providerIconAsset,
  providerIconFallback,
} from '../../../model/providerIcons'

const props = defineProps<{
  entries: ModelEntry[]
  providerOptions: ProviderOption[]
  deletingId?: string | null
}>()

const emit = defineEmits<{
  add: []
  edit: [entry: ModelEntry]
  delete: [entryId: string]
}>()

function providerOption(entry: ModelEntry): ProviderOption | undefined {
  return props.providerOptions.find((option) => option.name === entry.provider)
}

function providerLabel(entry: ModelEntry): string {
  const provider = providerOption(entry)
  return provider?.displayName || provider?.name || entry.provider
}

function providerIcon(entry: ModelEntry): string | null {
  return providerIconAsset(providerOption(entry)?.iconId || entry.provider)
}

function effectiveLabel(entry: ModelEntry): string {
  return entry.effectiveDisplayName || entry.displayName || entry.modelId
}
</script>

<template>
  <section class="model-entry-list" aria-labelledby="saved-models-title">
    <header class="model-list-head">
      <div>
        <h2 id="saved-models-title">已保存模型</h2>
        <p>管理 Provider、协议、凭证与模型能力。</p>
      </div>
      <button type="button" class="model-add-button" @click="emit('add')">
        <Plus :size="16" aria-hidden="true" />
        添加模型
      </button>
    </header>

    <div v-if="entries.length" class="model-card-grid">
      <article v-for="entry in entries" :key="entry.entryId" class="model-card">
        <div class="model-card-main">
          <div class="provider-avatar" aria-hidden="true">
            <img
              v-if="providerIcon(entry)"
              :src="providerIcon(entry) || undefined"
              :alt="`${providerLabel(entry)} logo`"
            />
            <span v-else>{{ providerIconFallback(providerLabel(entry)) }}</span>
          </div>
          <div class="model-card-copy">
            <div class="model-card-title-row">
              <strong>{{ effectiveLabel(entry) }}</strong>
            </div>
            <code>{{ entry.modelId }}</code>
            <div class="model-card-meta">
              <span>{{ providerLabel(entry) }}</span>
              <span aria-hidden="true">·</span>
              <span>{{
                entry.protocol === 'anthropic' ? 'Anthropic' : 'OpenAI'
              }}</span>
            </div>
          </div>
        </div>

        <div class="model-card-actions">
          <button
            type="button"
            class="card-action icon"
            :aria-label="`编辑 ${effectiveLabel(entry)}`"
            title="编辑"
            @click="emit('edit', entry)"
          >
            <Pencil :size="15" aria-hidden="true" />
          </button>
          <button
            type="button"
            class="card-action icon danger"
            :disabled="deletingId === entry.entryId"
            :aria-label="`删除 ${effectiveLabel(entry)}`"
            title="删除"
            @click="entry.entryId && emit('delete', entry.entryId)"
          >
            <Trash2 :size="15" aria-hidden="true" />
          </button>
        </div>
      </article>
    </div>

    <button v-else type="button" class="model-empty" @click="emit('add')">
      <span class="empty-plus"><Plus :size="20" aria-hidden="true" /></span>
      <strong>添加第一个模型</strong>
      <span>配置 API 地址、凭证和模型能力后即可开始使用。</span>
    </button>
  </section>
</template>

<style scoped>
.model-entry-list {
  display: grid;
  gap: var(--space-5);
}

.model-list-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.model-list-head h2 {
  margin: 0;
  color: rgb(var(--fg));
  font-size: var(--font-size-lg);
  font-weight: 650;
}

.model-list-head p {
  margin: var(--space-1) 0 0;
  color: rgb(var(--fg-subtle));
  font-size: var(--font-size-sm);
}

.model-add-button,
.card-action {
  border: 1px solid rgb(var(--border));
  border-radius: var(--radius-md);
  background: rgb(var(--bg-elevated));
  color: rgb(var(--fg));
  font: inherit;
  cursor: pointer;
  transition:
    border-color 150ms ease,
    background 150ms ease,
    color 150ms ease;
}

.model-add-button {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  min-height: 34px;
  padding: 0 12px;
  font-size: var(--font-size-sm);
  font-weight: 600;
}

.model-add-button:hover,
.card-action:hover:not(:disabled) {
  border-color: rgb(var(--accent));
  background: rgb(var(--bg-inset));
}

.model-card-grid {
  display: grid;
  gap: var(--space-3);
}

.model-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-5);
  min-height: 78px;
  padding: var(--space-4) 16px;
  border: 1px solid rgb(var(--border));
  border-radius: var(--radius);
  background: rgb(var(--bg-elevated));
}

.model-card-main {
  display: flex;
  align-items: center;
  min-width: 0;
  gap: 13px;
}

.provider-avatar {
  display: grid;
  place-items: center;
  width: 38px;
  height: 38px;
  flex: 0 0 38px;
  overflow: hidden;
  border: 1px solid rgb(var(--border));
  border-radius: var(--radius-md);
  background: rgb(var(--bg));
  color: rgb(var(--fg-muted));
  font-size: var(--font-size-lg);
  font-weight: 700;
}

.provider-avatar:has(img) {
  background: rgb(248 250 252);
}

.provider-avatar img {
  width: 23px;
  height: 23px;
  object-fit: contain;
}

.model-card-copy {
  display: grid;
  min-width: 0;
  gap: 4px;
}

.model-card-title-row {
  display: flex;
  align-items: center;
  min-width: 0;
  gap: 8px;
}

.model-card-title-row strong,
.model-card-copy code {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.model-card-title-row strong {
  color: rgb(var(--fg));
  font-size: var(--font-size-md);
}

.model-card-copy code {
  color: rgb(var(--fg-muted));
  font-size: var(--font-size-sm);
}

.model-card-meta {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  color: rgb(var(--fg-subtle));
  font-size: var(--font-size-xs);
}

.model-card-actions {
  display: flex;
  align-items: center;
  flex: 0 0 auto;
  gap: var(--space-2);
}

.card-action {
  min-height: 30px;
  padding: 0 10px;
  font-size: var(--font-size-xs);
}

.card-action.icon {
  display: grid;
  place-items: center;
  width: 30px;
  padding: 0;
}

.card-action.danger:hover:not(:disabled) {
  border-color: rgb(var(--danger));
  color: rgb(var(--danger));
}

.card-action:disabled {
  cursor: wait;
  opacity: 0.55;
}

.model-empty {
  display: grid;
  justify-items: center;
  gap: var(--space-2);
  min-height: 190px;
  padding: 28px;
  border: 1px dashed rgb(var(--border));
  border-radius: var(--radius);
  background: transparent;
  color: rgb(var(--fg-subtle));
  cursor: pointer;
}

.model-empty strong {
  color: rgb(var(--fg));
  font-size: var(--font-size-md);
}

.model-empty span:last-child {
  font-size: var(--font-size-sm);
}

.empty-plus {
  display: grid;
  place-items: center;
  width: 38px;
  height: 38px;
  border-radius: var(--radius);
  background: rgb(var(--bg-elevated));
  color: rgb(var(--accent));
}

@media (max-width: 720px) {
  .model-card {
    align-items: flex-start;
    flex-direction: column;
  }

  .model-card-actions {
    width: 100%;
    justify-content: flex-end;
  }
}

@media (prefers-reduced-motion: reduce) {
  .model-add-button,
  .card-action {
    transition: none;
  }
}
</style>
