<script setup lang="ts">
/**
 * InvalidSkillsNotice — the warn block on top of Settings › Skills: Skills
 * whose SKILL.md failed validation are not loaded, and this is where their
 * reasons show. The head (「不合格的 Skill (N)」 + one-line explanation)
 * toggles the list; each entry is an expandable SettingsCard (name,
 * source, reason) whose body shows the absolute path, the errors / warnings
 * and 打开文件夹 / 删除 (personal and project Skills only).
 *
 * Props: items (InvalidSkillInfo[]); busyPath? (entry being deleted).
 * v-model:open (list shown, default false).
 * Emits: openFolder(item), delete(item).
 */
import { reactive } from 'vue'
import Button from '../../ui/Button.vue'
import { DsChevronDown, DsFolderOpen, DsTrash, DsWarning } from '../../icons/ds'
import type { InvalidSkillInfo } from '../../../types'
import { DefinitionList, SettingsCard, StatusBadge } from '../ui'
import SkillIssues from './SkillIssues.vue'
import { invalidSkillDeleteTarget, skillSourceLabel } from './skillsModel'

withDefaults(
  defineProps<{
    items: readonly InvalidSkillInfo[]
    busyPath?: string | null
  }>(),
  { busyPath: null },
)
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{
  openFolder: [item: InvalidSkillInfo]
  delete: [item: InvalidSkillInfo]
}>()

const expanded = reactive<Record<string, boolean>>({})
const listId = 'invalid-skills-list'
</script>

<template>
  <section
    class="invalid-notice"
    :data-open="open || undefined"
    aria-label="不合格的 Skill"
    data-testid="invalid-skills"
  >
    <button
      type="button"
      class="head"
      :aria-expanded="open"
      :aria-controls="listId"
      @click="open = !open"
    >
      <DsWarning :size="16" class="glyph" />
      <span class="text">
        <span class="title">不合格的 Skill ({{ items.length }})</span>
        <span class="subtitle">
          这些 Skill 未通过校验，没有加载。修复或删除后列表会自动刷新。
        </span>
      </span>
      <DsChevronDown :size="14" class="chevron" aria-hidden="true" />
    </button>
    <ul v-if="open" :id="listId" class="list">
      <li v-for="item in items" :key="item.path" class="entry">
        <SettingsCard
          v-model:open="expanded[item.path]"
          expandable
          :title="item.name"
          :data-invalid-skill="item.name"
        >
          <template #meta>
            <StatusBadge>{{ skillSourceLabel(item) }}</StatusBadge>
          </template>
          <template #description>
            <span class="reason">{{ item.reason }}</span>
          </template>
          <DefinitionList
            :items="[
              { key: 'path', term: '路径', value: item.path, mono: true },
              { key: 'reason', term: '原因', value: item.reason },
            ]"
          />
          <SkillIssues
            :errors="item.errors"
            :warnings="item.warnings"
            :label="`${item.name} 的校验结果`"
          />
          <template #footer>
            <Button
              size="sm"
              variant="outline"
              data-action="open-folder"
              @click="emit('openFolder', item)"
            >
              <template #icon><DsFolderOpen :size="14" /></template>
              打开文件夹
            </Button>
            <Button
              v-if="invalidSkillDeleteTarget(item)"
              size="sm"
              variant="danger"
              data-action="delete"
              :disabled="busyPath === item.path"
              @click="emit('delete', item)"
            >
              <template #icon><DsTrash :size="14" /></template>
              删除
            </Button>
          </template>
        </SettingsCard>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.invalid-notice {
  display: flex;
  flex-direction: column;
  min-width: 0;
  border: 1px solid rgb(var(--state-warn) / 0.35);
  border-radius: var(--radius-card);
  background: rgb(var(--state-warn-soft));
}

.head {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2-5);
  width: 100%;
  min-width: 0;
  padding: var(--space-3) var(--space-3-5);
  border: none;
  border-radius: var(--radius-card);
  background: transparent;
  font: inherit;
  color: inherit;
  text-align: left;
  cursor: pointer;
}

.head:focus-visible {
  outline: none;
  box-shadow: inset 0 0 0 2px rgb(var(--focus-ring) / 0.5);
}

.glyph {
  flex: none;
  margin-top: var(--space-0-5);
  color: rgb(var(--state-warn));
}

.text {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: var(--space-0-5);
  min-width: 0;
}

.title {
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  font-weight: 600;
  color: rgb(var(--state-warn-label));
}

.subtitle {
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  color: rgb(var(--label-secondary));
  text-wrap: pretty;
}

.chevron {
  flex: none;
  margin-top: var(--space-1);
  color: rgb(var(--state-warn-label));
  transition: transform var(--duration-ds-fast) var(--ease-in-out);
}

.invalid-notice[data-open] .chevron {
  transform: rotate(180deg);
}

.list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-width: 0;
  margin: 0;
  padding: 0 var(--space-3) var(--space-3);
  list-style: none;
}

.entry {
  min-width: 0;
}

.reason {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
