<script setup lang="ts">
/**
 * SkillRow — one Skill in the Settings › Skills list: a full-width button
 * (14/22 medium name, source StatusBadge, 只读 / status badges, a warn glyph
 * with the loader-warning count) over a one-line 13/20 tertiary
 * description; a trailing chevron shows it opens the detail. Rows sit in
 * the section's bordered list and draw their own l2 hairline.
 *
 * Props: skill (SkillInfo). Emits: select.
 */
import { computed } from 'vue'
import { DsChevronRight, DsWarning } from '../../icons/ds'
import type { SkillInfo } from '../../../types'
import { StatusBadge } from '../ui'
import {
  isSkillReadOnly,
  skillSourceLabel,
  skillSourceTone,
} from './skillsModel'

const props = defineProps<{ skill: SkillInfo }>()
const emit = defineEmits<{ select: [] }>()

const warnings = computed(() => props.skill.warnings ?? [])
const status = computed(() =>
  props.skill.status && props.skill.status !== 'active'
    ? props.skill.status
    : '',
)
</script>

<template>
  <li class="skill-row-item">
    <button
      type="button"
      class="skill-row"
      :data-skill="skill.name"
      @click="emit('select')"
    >
      <span class="main">
        <span class="title-line">
          <span class="name">{{ skill.name }}</span>
          <StatusBadge :tone="skillSourceTone(skill)">
            {{ skillSourceLabel(skill) }}
          </StatusBadge>
          <StatusBadge v-if="isSkillReadOnly(skill)">只读</StatusBadge>
          <StatusBadge v-if="status" tone="warn" mono>{{ status }}</StatusBadge>
          <span
            v-if="warnings.length"
            class="warnings"
            :title="warnings.join('\n')"
            :aria-label="`${warnings.length} 条加载提示`"
            data-skill-warnings
          >
            <DsWarning :size="12" />
            {{ warnings.length }}
          </span>
        </span>
        <span class="description" :title="skill.description || undefined">
          {{ skill.description || '没有描述' }}
        </span>
      </span>
      <DsChevronRight :size="14" class="chevron" aria-hidden="true" />
    </button>
  </li>
</template>

<style scoped>
.skill-row-item {
  min-width: 0;
  list-style: none;
}

.skill-row-item + .skill-row-item {
  border-top: 1px solid var(--border-l2);
}

.skill-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  width: 100%;
  min-width: 0;
  padding: var(--space-2-5) var(--space-3) var(--space-2-5) var(--space-4);
  border: none;
  background: transparent;
  font: inherit;
  color: inherit;
  text-align: left;
  cursor: pointer;
  transition: background-color var(--duration-ds-fast) ease;
}

.skill-row:hover {
  background: var(--interactive-bg-hover);
}

.skill-row:focus-visible {
  outline: none;
  box-shadow: inset 0 0 0 2px rgb(var(--focus-ring) / 0.5);
}

.main {
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
  min-width: 0;
  font-size: var(--fs-s);
  line-height: var(--lh-s);
  font-weight: 500;
  color: rgb(var(--label-primary));
  overflow-wrap: anywhere;
}

.warnings {
  display: inline-flex;
  align-items: center;
  gap: var(--space-0-5);
  font-size: var(--fs-xxxs);
  line-height: var(--lh-xxxs);
  font-weight: 500;
  color: rgb(var(--state-warn-label));
  font-variant-numeric: tabular-nums;
}

.description {
  min-width: 0;
  overflow: hidden;
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  color: rgb(var(--label-tertiary));
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chevron {
  flex: none;
  color: rgb(var(--label-caption));
}
</style>
