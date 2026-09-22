<script setup lang="ts">
/**
 * SkillPasteDialog — 「新增 › 粘贴 SKILL.md」: a ui/Modal with the SKILL.md
 * editor, the Skill name (read from the frontmatter `name` until the user
 * edits it; clearing it resumes auto-detection), the target scope (个人, or
 * the current project during a Build session) and live Core validation of
 * the file as it will be written. 「导入」 runs `skills.import` with
 * `{ kind: 'content' }`; a same-named Skill turns into an inline notice with
 * 「覆盖」, which imports again with `overwrite`.
 *
 * Props: scopeOptions (SelectOption<SkillScope>[]), sessionId?.
 * v-model:open. Emits: imported(summary) after a successful import (the
 * dialog then closes).
 */
import { computed, ref, watch } from 'vue'
import Button from '../../ui/Button.vue'
import Modal from '../../ui/Modal.vue'
import {
  importSkills,
  skillErrorInfo,
  type SkillScope,
} from '../../../api/skills'
import {
  CodeEditor,
  Field,
  Select,
  StatusBadge,
  TextField,
  type SelectOption,
} from '../ui'
import SkillIssues from './SkillIssues.vue'
import {
  detectFrontmatterName,
  SKILL_TEMPLATE,
  skillImportErrorSummary,
  skillValidationBadge,
  summarizeSkillImport,
  withFrontmatterName,
  type SkillImportSummary,
} from './skillsModel'
import { useSkillValidation } from './useSkillValidation'

const props = withDefaults(
  defineProps<{
    scopeOptions: readonly SelectOption<SkillScope>[]
    sessionId?: string | null
  }>(),
  { sessionId: null },
)
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ imported: [summary: SkillImportSummary] }>()

const content = ref('')
const name = ref('')
const nameTouched = ref(false)
const scope = ref<SkillScope>('user')
const importing = ref(false)
const conflict = ref<string | null>(null)
const submitError = ref('')

watch(open, (value) => {
  if (value) reset()
})

watch(content, (text) => {
  if (!nameTouched.value) name.value = detectFrontmatterName(text) ?? ''
  conflict.value = null
  submitError.value = ''
})

watch([name, scope], () => {
  conflict.value = null
  submitError.value = ''
})

function reset() {
  content.value = ''
  name.value = ''
  nameTouched.value = false
  scope.value = 'user'
  importing.value = false
  conflict.value = null
  submitError.value = ''
}

/** Typing takes over the name; clearing it hands it back to the frontmatter. */
function onNameInput(value: string) {
  name.value = value
  nameTouched.value = value.trim() !== ''
}

const detected = computed(() => detectFrontmatterName(content.value))
/** The name the Skill is imported under. */
const effectiveName = computed(() => name.value.trim() || detected.value || '')
const renamed = computed(() =>
  Boolean(
    effectiveName.value &&
    detected.value &&
    effectiveName.value !== detected.value,
  ),
)
const nameHint = computed(() => {
  if (!content.value.trim()) return '默认使用 frontmatter 里的 name。'
  if (renamed.value)
    return `导入时会把 frontmatter 的 name 改为「${effectiveName.value}」。`
  if (detected.value) return '已从 frontmatter 识别，可修改。'
  return 'frontmatter 里没有 name，请填写 Skill 名称。'
})

const validation = useSkillValidation(() => {
  if (!open.value || !content.value.trim()) return null
  const target = effectiveName.value
  return {
    content: target
      ? withFrontmatterName(content.value, target)
      : content.value,
    sessionId: props.sessionId,
  }
})
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
const warnings = computed(() => result.value?.warnings ?? [])

const canImport = computed(
  () =>
    Boolean(content.value.trim()) &&
    Boolean(effectiveName.value) &&
    !importing.value &&
    !pending.value &&
    !failure.value &&
    result.value?.valid === true,
)

async function submit(overwrite = false) {
  if (!overwrite && !canImport.value) return
  if (importing.value) return
  importing.value = true
  submitError.value = ''
  conflict.value = null
  const target = effectiveName.value
  try {
    const summary = summarizeSkillImport(
      await importSkills({
        source: { kind: 'content', content: content.value, name: target },
        scope: scope.value,
        sessionId: props.sessionId,
        overwrite,
      }),
    )
    if (summary.imported.length) {
      emit('imported', summary)
      open.value = false
      return
    }
    if (summary.conflicts.length) conflict.value = summary.conflicts[0]!
    else
      submitError.value =
        summary.failures.map((entry) => entry.reason).join('；') ||
        summary.headline
  } catch (error) {
    const summary = skillImportErrorSummary(skillErrorInfo(error), target)
    if (summary.conflicts.length) conflict.value = summary.conflicts[0]!
    else submitError.value = summary.failures[0]?.reason ?? summary.headline
  } finally {
    importing.value = false
  }
}
</script>

<template>
  <Modal
    v-model:open="open"
    title="粘贴 SKILL.md"
    :width="560"
    :close-on-mask="false"
  >
    <div class="paste-dialog">
      <Field label="SKILL.md">
        <template #badge>
          <StatusBadge
            v-if="badge"
            :tone="badge.tone"
            dot
            data-testid="skill-paste-validation"
          >
            {{ badge.label }}
          </StatusBadge>
        </template>
        <CodeEditor
          v-model="content"
          language="markdown"
          :min-lines="10"
          :max-lines="14"
          :placeholder="SKILL_TEMPLATE"
          :invalid="errors.length > 0"
          @save="submit()"
        />
        <template #hint>
          以 <code>---</code> 开头的 YAML frontmatter，至少包含
          <code>name</code> 与 <code>description</code>。
        </template>
      </Field>

      <SkillIssues :errors="errors" :warnings="warnings" />

      <div class="fields">
        <Field label="名称" :hint="nameHint">
          <TextField
            :model-value="name"
            monospace
            :placeholder="detected || 'my-skill'"
            autocomplete="off"
            spellcheck="false"
            @update:model-value="onNameInput"
          />
        </Field>
        <Field label="保存到">
          <Select v-model="scope" :options="scopeOptions" block />
        </Field>
      </div>

      <div v-if="conflict" class="conflict" role="alert">
        <span class="conflict-text">
          已存在名为「{{ conflict }}」的 Skill。覆盖后原内容会被替换。
        </span>
        <Button
          size="sm"
          variant="danger"
          data-action="overwrite"
          :disabled="importing"
          @click="submit(true)"
        >
          覆盖
        </Button>
      </div>
      <p v-if="submitError" class="submit-error" role="alert">
        {{ submitError }}
      </p>
    </div>

    <template #footer>
      <Button variant="outline" @click="open = false">取消</Button>
      <Button
        variant="primary"
        data-testid="skill-paste-submit"
        :disabled="!canImport"
        @click="submit()"
      >
        {{ importing ? '正在导入…' : '导入' }}
      </Button>
    </template>
  </Modal>
</template>

<style scoped>
.paste-dialog {
  container-type: inline-size;
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  min-width: 0;
  padding-bottom: var(--space-0-5);
}

.paste-dialog code {
  font-family: var(--font-mono);
  font-size: var(--fs-xxxs);
}

.fields {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-3);
  align-items: start;
}

@container (max-width: 419px) {
  .fields {
    grid-template-columns: minmax(0, 1fr);
  }
}

.conflict {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-2) var(--space-3);
  padding: var(--space-2-5) var(--space-3);
  border: 1px solid rgb(var(--state-warn) / 0.35);
  border-radius: var(--radius-row);
  background: rgb(var(--state-warn-soft));
}

.conflict-text {
  flex: 1 1 240px;
  min-width: 0;
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  color: rgb(var(--state-warn-label));
}

.submit-error {
  margin: 0;
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  color: rgb(var(--state-error-label));
  overflow-wrap: anywhere;
}
</style>
