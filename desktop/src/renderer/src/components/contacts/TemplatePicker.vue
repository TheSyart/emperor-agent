<script setup lang="ts">
/**
 * TemplatePicker — the 18 role templates (GRP-04, D15) in four rows by
 * field: 软件工程、设计、内容、产品与决策 (Core returns them in that order).
 * Picking one fills the role card; nothing is saved.
 *
 * Props: templates; selected? (template id). Emits: pick(template).
 */
import { computed } from 'vue'
import type { ContactTemplate } from '@emperor/core/api'
import Tag from '../ui/Tag.vue'

const props = withDefaults(
  defineProps<{
    templates: readonly ContactTemplate[]
    selected?: string | null
  }>(),
  { selected: null },
)
const emit = defineEmits<{ pick: [template: ContactTemplate] }>()

const GROUPS: ReadonlyArray<{
  theme: ContactTemplate['avatarTheme']
  label: string
}> = [
  { theme: 'engineering', label: '软件工程' },
  { theme: 'design', label: '设计' },
  { theme: 'content', label: '内容' },
  { theme: 'product', label: '产品与决策' },
]

const rows = computed(() =>
  GROUPS.map((group) => ({
    ...group,
    templates: props.templates.filter(
      (template) => template.avatarTheme === group.theme,
    ),
  })).filter((row) => row.templates.length > 0),
)
</script>

<template>
  <div class="picker" data-template-picker role="group" aria-label="岗位模板">
    <div v-for="row in rows" :key="row.theme" class="row">
      <span class="label">{{ row.label }}</span>
      <Tag
        v-for="template in row.templates"
        :key="template.id"
        :data-template="template.id"
        :selected="template.id === selected"
        :label="template.name"
        :title="template.intro"
        @click="emit('pick', template)"
      />
    </div>
  </div>
</template>

<style scoped>
.picker {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-1-5);
}

.label {
  width: 72px;
  flex: none;
  color: rgb(var(--text-3));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
}
</style>
