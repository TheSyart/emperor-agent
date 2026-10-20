<script setup lang="ts">
/**
 * Step 2 of the add-model dialog (MOD-04): the connection's models by
 * family (or sorted by newest / name), chat models by default, filter
 * chips, a search, and per row the capabilities known to be there, the
 * limits, where the facts came from and 已添加 / 将下线 / 已退役. A list of
 * three or fewer starts all checked; otherwise the newest live model of
 * each family. 找不到？ adds an id by hand with catalog defaults. Rows render
 * lazily (`content-visibility`) so lists of hundreds stay quick.
 */
import { computed, ref } from 'vue'
import type { DiscoveredModel } from '@emperor/core/api'
import Badge from '../../ui/Badge.vue'
import Button from '../../ui/Button.vue'
import Checkbox from '../../ui/Checkbox.vue'
import EmptyState from '../../ui/EmptyState.vue'
import LinkButton from '../../ui/LinkButton.vue'
import Notice from '../../ui/Notice.vue'
import SearchField from '../../ui/SearchField.vue'
import Select from '../../ui/Select.vue'
import Tag from '../../ui/Tag.vue'
import TextField from '../../ui/TextField.vue'
import { formatTokenCount } from './modelFormModel'
import {
  MODEL_FILTERS,
  sourceLabel,
  statusMarks,
  type ModelSort,
} from './addModelModel'
import { useAddModel } from './addModelController'

const add = useAddModel()
const manual = ref(false)

const SORTS: Array<{ value: ModelSort; label: string }> = [
  { value: 'recommended', label: '推荐' },
  { value: 'newest', label: '最新' },
  { value: 'name', label: '名称' },
]

const sections = computed(
  () => add.families ?? [{ family: '', models: add.visible }],
)
const savedCount = computed(() => add.existingIds.size)
const nextLabel = computed(() => {
  const count = add.picked.length
  if (add.manage && !count)
    return add.removed.length ? `移除 ${add.removed.length} 个` : '完成'
  return '下一步'
})

function capabilities(model: DiscoveredModel): string[] {
  const out: string[] = []
  if (model.capabilities.toolCall === true) out.push('工具')
  if (model.capabilities.vision === true) out.push('识图')
  if (model.capabilities.reasoning === true) out.push('思考')
  return out
}

function limits(model: DiscoveredModel): string {
  const context = model.contextWindowTokens
    ? formatTokenCount(model.contextWindowTokens)
    : '?'
  const output = model.maxOutputTokens
    ? formatTokenCount(model.maxOutputTokens)
    : '?'
  return `${context} · 输出 ${output}`
}

function marks(model: DiscoveredModel) {
  return statusMarks(
    model,
    [...add.existingIds].map((modelId) => ({ modelId })),
  )
}

function next(): void {
  if (add.manage && !add.picked.length) void add.save()
  else add.toConfirm()
}

function startManual(id = ''): void {
  manual.value = true
  void add.lookupManual(id)
}
</script>

<template>
  <section class="pick" data-step="pick">
    <Notice
      v-if="add.listSource === 'catalog'"
      tone="info"
      title="这个供应商没有模型列表接口，下面是内置目录推荐"
    />
    <Notice
      v-if="add.truncated"
      tone="info"
      :title="`已显示前 ${add.models.length} 个（共 ${add.totalCount} 个），请搜索`"
    />

    <div class="toolbar">
      <SearchField v-model="add.search" placeholder="搜索模型" size="sm" />
      <Select
        :model-value="add.sort"
        :options="SORTS"
        size="sm"
        aria-label="排序"
        @update:model-value="(value) => (add.sort = value as ModelSort)"
      />
    </div>
    <div class="filters" role="group" aria-label="筛选">
      <Tag
        v-for="item in MODEL_FILTERS"
        :key="item.key"
        :selected="add.filter === item.key"
        @click="add.filter = item.key"
        >{{ item.label }}</Tag
      >
    </div>

    <p v-if="add.guard" class="guard" role="alert">{{ add.guard }}</p>

    <EmptyState
      v-if="!add.models.length"
      variant="inline"
      title="这个 Key 下没有可用模型"
      description="可以手动输入模型 ID，或者到供应商的控制台开通模型。"
    />
    <EmptyState
      v-else-if="!add.visible.length"
      variant="inline"
      :title="add.search ? `没有匹配「${add.search}」的模型` : '这一类没有模型'"
    >
      <Button
        v-if="add.search"
        size="sm"
        variant="secondary"
        @click="startManual(add.search)"
        >按「{{ add.search }}」手动添加</Button
      >
    </EmptyState>

    <div v-else class="list">
      <section v-for="section in sections" :key="section.family" class="family">
        <h3 v-if="section.family" class="family-label">
          {{ section.family }}
        </h3>
        <div
          v-for="model in section.models"
          :key="model.id"
          class="row"
          :data-model-id="model.id"
          :data-checked="add.selected.has(model.id) ? 'true' : 'false'"
        >
          <Checkbox
            :model-value="add.selected.has(model.id)"
            :aria-label="`选择 ${model.id}`"
            @update:model-value="(value) => add.toggle(model.id, value)"
          />
          <span class="row-main">
            <span class="row-title">
              <span v-if="model.name && model.name !== model.id" class="name">{{
                model.name
              }}</span>
              <code class="id">{{ model.id }}</code>
            </span>
            <span class="row-meta">
              <Badge
                v-for="cap in capabilities(model)"
                :key="cap"
                tone="neutral"
                >{{ cap }}</Badge
              >
              <span class="limits">{{ limits(model) }}</span>
              <span class="source">{{ sourceLabel(model.source) }}</span>
            </span>
          </span>
          <span class="row-marks">
            <Badge
              v-for="mark in marks(model)"
              :key="mark"
              :tone="
                mark === '已添加' ? 'ok' : mark === '已退役' ? 'error' : 'warn'
              "
              >{{ mark }}</Badge
            >
          </span>
        </div>
      </section>
    </div>

    <div class="manual">
      <LinkButton v-if="!manual" @click="startManual()"
        >找不到？＋ 手动输入模型 ID</LinkButton
      >
      <template v-else>
        <TextField
          :model-value="add.manualId"
          monospace
          size="sm"
          placeholder="模型 ID，例如 deepseek-flash"
          aria-label="手动输入模型 ID"
          @update:model-value="add.lookupManual"
        />
        <span v-if="add.manualMatch" class="manual-match">
          {{ sourceLabel(add.manualMatch.source) }} ·
          {{ limits(add.manualMatch) }}
        </span>
        <Button
          size="sm"
          variant="secondary"
          :disabled="!add.manualMatch"
          @click="add.addManual()"
          >添加</Button
        >
      </template>
    </div>

    <div class="footer">
      <span class="count"
        >已选 {{ add.picked.length }} 个<template v-if="add.manage">
          · 已保存 {{ savedCount }} 个</template
        ></span
      >
      <Button v-if="!add.manage" variant="ghost" @click="add.step = 'connect'"
        >上一步</Button
      >
      <Button
        variant="primary"
        :loading="add.saving"
        :disabled="!add.picked.length && !(add.manage && add.removed.length)"
        @click="next"
        >{{ nextLabel }}</Button
      >
    </div>
  </section>
</template>

<style scoped>
.pick {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  min-height: 0;
}

.toolbar {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: var(--space-2);
}

.filters {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1-5);
}

.guard {
  margin: 0;
  font-size: var(--fs-xs);
  color: rgb(var(--error));
}

.list {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  max-height: 380px;
  overflow-y: auto;
}

.family {
  display: flex;
  flex-direction: column;
}

.family-label {
  margin: 0 0 var(--space-1);
  font-size: var(--fs-xs);
  font-weight: var(--weight-medium);
  color: rgb(var(--text-3));
}

.row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-height: 48px;
  padding: var(--space-1-5) var(--space-2);
  border-radius: var(--r-sm);
  content-visibility: auto;
  contain-intrinsic-size: auto 48px;
}

.row:hover {
  background: var(--surface-hover);
}

.row-main {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: var(--space-0-5);
  min-width: 0;
}

.row-title {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  min-width: 0;
}

.name {
  font-size: var(--fs-xs);
  font-weight: var(--weight-medium);
}

.id {
  overflow: hidden;
  font: var(--font-code-small);
  color: rgb(var(--text-2));
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-1-5);
  font-size: var(--fs-xxs);
  color: rgb(var(--text-3));
}

.limits {
  font-variant-numeric: tabular-nums;
}

.row-marks {
  display: flex;
  flex: none;
  gap: var(--space-1);
}

.manual {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.manual-match {
  font-size: var(--fs-xxs);
  color: rgb(var(--text-3));
  white-space: nowrap;
}

.footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-2);
}

.count {
  margin-right: auto;
  font-size: var(--fs-xs);
  color: rgb(var(--text-3));
}
</style>
