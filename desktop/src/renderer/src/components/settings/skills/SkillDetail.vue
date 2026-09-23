<script setup lang="ts">
/**
 * SkillDetail — the inline detail of one Skill inside 能力 › Skills (it
 * replaces the list; no nested modal). A bar with 「全部 Skills」 (back) and
 * the Skill's actions, the name with source / 只读 / 未保存 badges and its
 * description, the facts (DefinitionList: source, file, tags, requirements)
 * and the SKILL.md editor with live Core validation (debounced
 * `skills.validate`) listing errors and warnings under it.
 *
 * Writable Skills (personal, project): 保存 (⌘S; disabled until edited or
 * while the draft has errors), 还原, 删除 (confirmation dialog). Read-only
 * Skills (builtin, Plugin): the editor is read-only and 「复制为个人 Skill」
 * copies it into ~/.emperor/skills (an existing personal copy asks before
 * it is overwritten); the personal copy then takes over the name.
 *
 * Props: name, sessionId?, summary? (the list row, shown while loading).
 * Emits: back, changed (the catalog changed: reload the list), deleted(name).
 * Exposes: reload() (re-read unless there are unsaved edits), dirty.
 */
import { computed, ref, watch } from 'vue'
import Button from '../../ui/Button.vue'
import IconButton from '../../ui/IconButton.vue'
import { DsChevronLeft, DsCopy, DsFolderOpen, DsTrash } from '../../icons/ds'
import { openPath } from '../../../api/backend'
import {
  copySkillToUser,
  deleteSkill,
  getSkill,
  saveSkill,
  skillErrorInfo,
  type SkillDetailPayload,
} from '../../../api/skills'
import { useAppContext } from '../../../composables/useAppContext'
import type { SkillInfo } from '../../../types'
import { CodeEditor, DefinitionList, EmptyState, StatusBadge } from '../ui'
import SkillConfirmDialog from './SkillConfirmDialog.vue'
import SkillIssues from './SkillIssues.vue'
import {
  canCopySkillToUser,
  canDeleteSkill,
  canSaveSkill,
  isSkillReadOnly,
  skillFacts,
  skillFolder,
  skillSourceLabel,
  skillSourceTone,
  skillValidationBadge,
  uniqueMessages,
} from './skillsModel'
import { useSkillValidation } from './useSkillValidation'

const props = withDefaults(
  defineProps<{
    name: string
    sessionId?: string | null
    summary?: SkillInfo | null
  }>(),
  { sessionId: null, summary: null },
)
const emit = defineEmits<{
  back: []
  changed: []
  deleted: [name: string]
}>()

const ctx = useAppContext()
const detail = ref<SkillDetailPayload | null>(null)
const original = ref('')
const draft = ref('')
const loading = ref(false)
const loadError = ref('')
const busy = ref<'save' | 'delete' | 'copy' | null>(null)
const confirmDelete = ref(false)
const confirmOverwrite = ref(false)
let loadSeq = 0

const skill = computed<SkillInfo | null>(
  () => detail.value ?? props.summary ?? null,
)
const readOnly = computed(() =>
  skill.value ? isSkillReadOnly(skill.value) : true,
)
const dirty = computed(
  () => Boolean(detail.value) && draft.value !== original.value,
)
const facts = computed(() => (skill.value ? skillFacts(skill.value) : []))

const validation = useSkillValidation(() =>
  detail.value
    ? { content: draft.value, name: props.name, sessionId: props.sessionId }
    : null,
)
const { result, pending, failure } = validation
const badge = computed(() =>
  skillValidationBadge({
    pending: pending.value,
    failure: failure.value,
    result: result.value,
  }),
)
const errors = computed(() => [
  ...(failure.value ? [failure.value] : []),
  ...(result.value?.errors ?? []),
])
const warnings = computed(() =>
  uniqueMessages(result.value?.warnings ?? [], detail.value?.warnings ?? []),
)
const canSave = computed(
  () =>
    Boolean(skill.value && canSaveSkill(skill.value)) &&
    dirty.value &&
    !busy.value &&
    !pending.value &&
    errors.value.length === 0,
)

async function load(force = true) {
  if (!force && dirty.value) return
  const id = ++loadSeq
  loading.value = !detail.value || detail.value.name !== props.name
  loadError.value = ''
  try {
    const next = await getSkill(props.name, { sessionId: props.sessionId })
    if (id !== loadSeq) return
    apply(next)
  } catch (error) {
    if (id !== loadSeq) return
    detail.value = null
    loadError.value = skillErrorInfo(error).message
  } finally {
    if (id === loadSeq) loading.value = false
  }
}

function apply(next: SkillDetailPayload) {
  detail.value = next
  original.value = next.content
  draft.value = next.content
}

watch(
  () => [props.name, props.sessionId] as const,
  () => {
    detail.value = null
    original.value = ''
    draft.value = ''
    void load()
  },
  { immediate: true },
)

function revert() {
  draft.value = original.value
}

async function save() {
  if (!canSave.value || !detail.value) return
  busy.value = 'save'
  try {
    apply(
      await saveSkill(props.name, draft.value, { sessionId: props.sessionId }),
    )
    emit('changed')
    ctx.showToast(`Skill「${props.name}」已保存`)
  } catch (error) {
    ctx.showToast(skillErrorInfo(error).message)
  } finally {
    busy.value = null
  }
}

async function copyToUser(overwrite = false) {
  if (busy.value) return
  busy.value = 'copy'
  try {
    apply(
      await copySkillToUser({
        name: props.name,
        sessionId: props.sessionId,
        overwrite,
      }),
    )
    confirmOverwrite.value = false
    emit('changed')
    ctx.showToast(`已复制为个人 Skill「${props.name}」，现在可以编辑`)
  } catch (error) {
    const info = skillErrorInfo(error)
    if (
      !overwrite &&
      info.code === 'skill_exists' &&
      info.action === 'overwrite'
    )
      confirmOverwrite.value = true
    else {
      confirmOverwrite.value = false
      ctx.showToast(info.message)
    }
  } finally {
    busy.value = null
  }
}

async function remove() {
  if (busy.value || !skill.value || !canDeleteSkill(skill.value)) return
  busy.value = 'delete'
  try {
    await deleteSkill(props.name, { sessionId: props.sessionId })
    confirmDelete.value = false
    ctx.showToast(`Skill「${props.name}」已删除`)
    emit('deleted', props.name)
  } catch (error) {
    ctx.showToast(skillErrorInfo(error).message)
  } finally {
    busy.value = null
  }
}

async function revealFolder() {
  if (!skill.value) return
  try {
    await openPath(skillFolder(skill.value))
  } catch (error) {
    ctx.showToast(skillErrorInfo(error).message)
  }
}

defineExpose({ reload: () => load(false), dirty })
</script>

<template>
  <div class="skill-detail" :data-skill-detail="name">
    <div class="bar">
      <Button size="sm" variant="ghost" class="back" @click="emit('back')">
        <template #icon><DsChevronLeft :size="14" /></template>
        全部 Skills
      </Button>
      <div v-if="skill" class="bar-actions">
        <IconButton label="打开所在文件夹" @click="revealFolder">
          <DsFolderOpen :size="16" />
        </IconButton>
        <template v-if="detail && canCopySkillToUser(detail)">
          <Button
            size="sm"
            variant="primary"
            data-action="copy-to-user"
            :disabled="busy !== null"
            @click="copyToUser()"
          >
            <template #icon><DsCopy :size="14" /></template>
            {{ busy === 'copy' ? '正在复制…' : '复制为个人 Skill' }}
          </Button>
        </template>
        <template v-else-if="detail">
          <Button
            size="sm"
            variant="danger"
            data-action="delete"
            :disabled="busy !== null"
            @click="confirmDelete = true"
          >
            <template #icon><DsTrash :size="14" /></template>
            删除
          </Button>
          <Button
            size="sm"
            variant="primary"
            data-action="save"
            :disabled="!canSave"
            @click="save"
          >
            {{ busy === 'save' ? '正在保存…' : '保存' }}
          </Button>
        </template>
      </div>
    </div>

    <EmptyState
      v-if="loadError && !detail"
      title="无法打开这个 Skill"
      :description="loadError"
    >
      <Button size="sm" variant="outline" @click="load()">重试</Button>
    </EmptyState>

    <template v-else-if="skill">
      <header class="head">
        <div class="title-line">
          <h3 class="name">{{ name }}</h3>
          <StatusBadge :tone="skillSourceTone(skill)">
            {{ skillSourceLabel(skill) }}
          </StatusBadge>
          <StatusBadge v-if="readOnly">只读</StatusBadge>
          <StatusBadge v-if="dirty" tone="accent">未保存</StatusBadge>
        </div>
        <p class="description">{{ skill.description || '没有描述' }}</p>
      </header>

      <DefinitionList :items="facts" />

      <p v-if="readOnly" class="note">
        {{ skillSourceLabel(skill) }} Skill 只读。复制为个人 Skill
        后即可编辑，个人副本会替代同名的{{ skillSourceLabel(skill) }}版本。
      </p>

      <div class="skill-editor">
        <div class="skill-editor-head">
          <h4 class="skill-editor-title">SKILL.md</h4>
          <StatusBadge
            v-if="badge"
            :tone="badge.tone"
            dot
            data-testid="skill-validation"
          >
            {{ badge.label }}
          </StatusBadge>
          <Button
            v-if="dirty"
            size="sm"
            variant="ghost"
            class="revert"
            :disabled="busy !== null"
            @click="revert"
          >
            还原
          </Button>
        </div>
        <CodeEditor
          v-model="draft"
          language="markdown"
          :min-lines="12"
          :max-lines="22"
          :readonly="readOnly"
          :disabled="loading"
          :invalid="errors.length > 0"
          aria-label="SKILL.md"
          @save="save"
        />
        <SkillIssues :errors="errors" :warnings="warnings" />
      </div>
    </template>

    <SkillConfirmDialog
      v-model:open="confirmDelete"
      :title="`删除 Skill「${name}」？`"
      description="Skill 文件夹会从磁盘删除，无法撤销。"
      :detail="skill ? skillFolder(skill) : undefined"
      confirm-label="删除"
      danger
      :busy="busy === 'delete'"
      @confirm="remove"
    />
    <SkillConfirmDialog
      v-model:open="confirmOverwrite"
      :title="`覆盖个人 Skill「${name}」？`"
      description="个人 Skills 文件夹里已有同名 Skill，覆盖后它的内容会被替换。"
      confirm-label="覆盖"
      danger
      :busy="busy === 'copy'"
      @confirm="copyToUser(true)"
    />
  </div>
</template>

<style scoped>
.skill-detail {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  min-width: 0;
}

.bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: var(--space-2);
  min-width: 0;
  padding-top: var(--space-1);
}

.back {
  margin-left: calc(var(--space-2) * -1);
}

.bar-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: var(--space-2);
  min-width: 0;
}

.head {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
}

.title-line {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-2);
  min-width: 0;
}

.name {
  margin: 0;
  min-width: 0;
  font-size: var(--fs-base);
  line-height: var(--lh-base);
  font-weight: 600;
  color: rgb(var(--label-primary));
  overflow-wrap: anywhere;
}

.description {
  margin: 0;
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  color: rgb(var(--label-secondary));
  overflow-wrap: anywhere;
  text-wrap: pretty;
}

.note {
  margin: 0;
  padding: var(--space-2-5) var(--space-3);
  border-radius: var(--radius-row);
  background: rgb(var(--selector-fill));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  color: rgb(var(--label-secondary));
  text-wrap: pretty;
}

.skill-editor {
  display: flex;
  flex-direction: column;
  gap: var(--space-2-5);
  min-width: 0;
}

.skill-editor-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  min-height: var(--space-7);
}

.skill-editor-title {
  margin: 0;
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  font-weight: 600;
  color: rgb(var(--label-primary));
}

.revert {
  margin-left: auto;
}
</style>
