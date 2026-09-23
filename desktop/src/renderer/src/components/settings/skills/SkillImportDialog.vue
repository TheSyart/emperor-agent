<script setup lang="ts">
/**
 * SkillImportDialog — imports Skills from a source on disk or the web.
 * - mode 'archive' (「新增 › 导入 zip 或 GitHub 链接」): Tabs zip | URL. zip
 *   picks a file through the native dialog; URL takes an https link (GitHub
 *   repo, `tree/<ref>/<dir>` or a zip download).
 * - mode 'folder' (「新增 › 选择本地文件夹」): the folder already picked in
 *   the native dialog, with 「更换…」.
 * Both pick the target scope and run `skills.import`; the dialog then shows
 * the result (SkillImportResult) instead of the form. Same-name conflicts
 * get 「覆盖同名 Skill」, which runs the import again with `overwrite`.
 *
 * Opened with `initialUrl` (the 探索 page's Skill entries) it starts on the
 * URL tab with that link filled in; nothing downloads until 「导入」.
 *
 * Props: mode, folderPath? (mode 'folder'), initialUrl? (mode 'archive'),
 * scopeOptions, sessionId?.
 * v-model:open. Emits: imported(summary) whenever something was imported,
 * select(name) from a result row's 「查看」.
 */
import { computed, ref, watch } from 'vue'
import Button from '../../ui/Button.vue'
import Modal from '../../ui/Modal.vue'
import Tabs from '../../ui/Tabs.vue'
import type { TabItem } from '../../ui/blockTypes'
import { selectDirectory, selectFile } from '../../../api/backend'
import {
  importSkills,
  skillErrorInfo,
  type SkillImportSource,
  type SkillScope,
} from '../../../api/skills'
import { Field, Select, TextField, type SelectOption } from '../ui'
import SkillImportResult from './SkillImportResult.vue'
import {
  skillImportErrorSummary,
  skillUrlError,
  summarizeSkillImport,
  type SkillImportSummary,
} from './skillsModel'

const props = withDefaults(
  defineProps<{
    mode: 'archive' | 'folder'
    folderPath?: string
    initialUrl?: string
    scopeOptions: readonly SelectOption<SkillScope>[]
    sessionId?: string | null
  }>(),
  { folderPath: '', initialUrl: '', sessionId: null },
)
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{
  imported: [summary: SkillImportSummary]
  select: [name: string]
}>()

const tabs: TabItem[] = [
  { id: 'zip', label: 'zip 文件' },
  { id: 'url', label: 'GitHub / 链接' },
]

const tab = ref('zip')
const zipPath = ref('')
const url = ref('')
const folder = ref('')
const scope = ref<SkillScope>('user')
const importing = ref(false)
const summary = ref<SkillImportSummary | null>(null)

watch(open, (value) => {
  if (value) reset()
})

watch([tab, zipPath, url, folder, scope], () => {
  if (!importing.value) summary.value = null
})

function reset() {
  tab.value = props.initialUrl ? 'url' : 'zip'
  zipPath.value = ''
  url.value = props.initialUrl
  folder.value = props.folderPath
  scope.value = 'user'
  importing.value = false
  summary.value = null
}

const title = computed(() =>
  props.mode === 'folder' ? '从文件夹导入 Skill' : '导入 Skill',
)
const urlError = computed(() => skillUrlError(url.value))

const source = computed<SkillImportSource | null>(() => {
  if (props.mode === 'folder')
    return folder.value ? { kind: 'folder', path: folder.value } : null
  if (tab.value === 'zip')
    return zipPath.value ? { kind: 'zip', path: zipPath.value } : null
  const link = url.value.trim()
  return link && !urlError.value ? { kind: 'url', url: link } : null
})

const canImport = computed(() => Boolean(source.value) && !importing.value)
const pendingLabel = computed(() =>
  source.value?.kind === 'url' ? '正在下载并导入…' : '正在导入…',
)

async function pickZip() {
  const path = await selectFile({
    title: '选择 Skill zip 文件',
    filters: [{ name: 'Zip', extensions: ['zip'] }],
  })
  if (path) zipPath.value = path
}

async function pickFolder() {
  const path = await selectDirectory()
  if (path) folder.value = path
}

async function run(overwrite = false) {
  const target = source.value
  if (!target || importing.value) return
  importing.value = true
  try {
    const next = summarizeSkillImport(
      await importSkills({
        source: target,
        scope: scope.value,
        sessionId: props.sessionId,
        overwrite,
      }),
    )
    summary.value = next
    if (next.imported.length) emit('imported', next)
  } catch (error) {
    summary.value = skillImportErrorSummary(skillErrorInfo(error))
  } finally {
    importing.value = false
  }
}

function openSkill(name: string) {
  emit('select', name)
  open.value = false
}
</script>

<template>
  <Modal
    v-model:open="open"
    :title="title"
    :width="560"
    :close-on-mask="!importing"
    :closable="!importing"
  >
    <div class="import-dialog" :data-mode="mode">
      <Tabs v-if="mode === 'archive'" v-model="tab" :tabs="tabs" class="tabs" />

      <Field
        v-if="mode === 'folder'"
        label="文件夹"
        hint="文件夹本身或其中的子文件夹需包含 SKILL.md；.venv、node_modules、.git 不会被复制。"
      >
        <div class="picker">
          <TextField
            :model-value="folder"
            :title="folder || undefined"
            readonly
            monospace
            placeholder="未选择文件夹"
            aria-label="文件夹路径"
          />
          <Button size="sm" variant="outline" @click="pickFolder">
            更换…
          </Button>
        </div>
      </Field>
      <Field
        v-else-if="tab === 'zip'"
        label="zip 文件"
        hint="压缩包中包含 SKILL.md 的每个文件夹都会作为一个 Skill 导入。"
      >
        <div class="picker">
          <TextField
            :model-value="zipPath"
            :title="zipPath || undefined"
            readonly
            monospace
            placeholder="未选择文件"
            aria-label="zip 文件路径"
          />
          <Button size="sm" variant="outline" @click="pickZip">
            选择文件…
          </Button>
        </div>
      </Field>
      <Field
        v-else
        label="链接"
        :error="urlError || undefined"
        hint="支持 GitHub 仓库、tree/<分支>/<目录> 链接和 zip 下载地址，仅限 https。"
      >
        <TextField
          v-model="url"
          type="url"
          monospace
          placeholder="https://github.com/owner/repo/tree/main/skills/my-skill"
          autocomplete="off"
          spellcheck="false"
          @keydown.enter="run()"
        />
      </Field>

      <Field label="保存到">
        <Select v-model="scope" :options="scopeOptions" block />
      </Field>

      <SkillImportResult
        v-if="summary"
        :summary="summary"
        class="result"
        @select="openSkill"
      />
    </div>

    <template #footer>
      <Button
        v-if="summary?.conflicts.length"
        variant="danger"
        data-action="overwrite"
        :disabled="importing"
        @click="run(true)"
      >
        覆盖同名 Skill
      </Button>
      <Button
        v-if="summary"
        variant="primary"
        data-action="done"
        :disabled="importing"
        @click="open = false"
      >
        完成
      </Button>
      <template v-else>
        <Button variant="outline" :disabled="importing" @click="open = false">
          取消
        </Button>
        <Button
          variant="primary"
          data-testid="skill-import-submit"
          :disabled="!canImport"
          @click="run()"
        >
          {{ importing ? pendingLabel : '导入' }}
        </Button>
      </template>
    </template>
  </Modal>
</template>

<style scoped>
.import-dialog {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  min-width: 0;
  padding-bottom: var(--space-0-5);
}

.tabs {
  margin-top: calc(var(--space-3) * -1);
  border-bottom: 1px solid var(--border-l2);
}

.picker {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

.result {
  padding-top: var(--space-3);
  border-top: 1px solid var(--border-l1);
}
</style>
