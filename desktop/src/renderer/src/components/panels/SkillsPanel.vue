<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { CoreOperationResult } from '@emperor/core'
import {
  AlertCircle,
  Link,
  PackageSearch,
  ShieldAlert,
  X,
} from 'lucide-vue-next'
import type { SkillInfo } from '../../types'
import { actionIcons, emptyIcons } from '../../icons'
import { core } from '../../api/http'
import { getPathForFile } from '../../api/backend'
import {
  skillCapability,
  type CapabilityDisplayItem,
} from '../../capabilities/capabilityProjection'
import CapabilityCard from '../capabilities/CapabilityCard.vue'
import MarkdownBlock from '../chat/MarkdownBlock.vue'
import { formatEnvironmentBytes } from './environmentPanelModel'

type SkillInstallPreview = CoreOperationResult<'skills.previewInstall'>

const props = defineProps<{
  skills: SkillInfo[]
  activeSkill: string | null
  content: string
}>()
const emit = defineEmits<{
  load: [name: string]
  new: [name: string]
  save: [content: string]
  delete: [name: string]
  installed: [name: string]
}>()

const filter = ref('')
const draft = ref('')
const preview = ref(false)
const detailOpen = ref(false)
const importInput = ref<HTMLInputElement | null>(null)
const installPreview = ref<SkillInstallPreview | null>(null)
const installCandidateId = ref('')
const installLoading = ref(false)
const installError = ref('')
const linkInstallOpen = ref(false)
const linkInstallUrl = ref('')

watch(
  () => props.content,
  (content) => {
    draft.value = content
  },
  { immediate: true },
)
watch(
  () => props.activeSkill,
  (name) => {
    if (name) detailOpen.value = true
  },
  { immediate: true },
)

const filtered = computed(() => {
  const query = filter.value.trim().toLowerCase()
  if (!query) return props.skills
  return props.skills.filter((skill) =>
    `${skill.name} ${skill.description || ''} ${skill.path}`
      .toLowerCase()
      .includes(query),
  )
})
const skillItems = computed(() =>
  filtered.value.map((skill) => skillCapability(skill)),
)

const activeSkillInfo = computed(
  () => props.skills.find((s) => s.name === props.activeSkill) || null,
)

function parseTags(tagStr: string): string[] {
  if (!tagStr) return []
  return tagStr.split(/[,;\s]+/).filter(Boolean)
}

function openSkill(skill: SkillInfo) {
  detailOpen.value = true
  emit('load', skill.name)
}

function openSkillItem(item: CapabilityDisplayItem) {
  const skill = props.skills.find((candidate) => candidate.name === item.name)
  if (!skill) return
  openSkill(skill)
}

function createSkill() {
  const name = window.prompt('技能名称，例如 video-planner')?.trim()
  if (!name) return
  preview.value = false
  detailOpen.value = true
  emit('new', name)
}

function confirmDelete(name: string) {
  if (!window.confirm(`确定要删除 Skill「${name}」吗？此操作不可恢复。`)) return
  detailOpen.value = false
  emit('delete', name)
}

const installCandidate = computed(() =>
  installPreview.value?.candidates.find(
    (candidate) => candidate.candidateId === installCandidateId.value,
  ),
)

async function onImportFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  installLoading.value = true
  installError.value = ''
  try {
    await previewSkillSource({ kind: 'local', path: getPathForFile(file) })
  } catch (error) {
    installError.value = error instanceof Error ? error.message : String(error)
  } finally {
    installLoading.value = false
  }
  input.value = ''
}

async function previewSkillUrl() {
  const url = linkInstallUrl.value.trim()
  if (!url || installLoading.value) return
  installLoading.value = true
  installError.value = ''
  try {
    await previewSkillSource({ kind: 'url', url })
    linkInstallOpen.value = false
    linkInstallUrl.value = ''
  } catch (error) {
    installError.value = error instanceof Error ? error.message : String(error)
  } finally {
    installLoading.value = false
  }
}

async function previewSkillSource(
  source: { kind: 'local'; path: string } | { kind: 'url'; url: string },
) {
  const preview = await core('skills.previewInstall', { source })
  installPreview.value = preview
  installCandidateId.value =
    preview.candidates.find((candidate) => candidate.valid)?.candidateId ||
    preview.candidates[0]?.candidateId ||
    ''
}

function closeInstallPreview() {
  if (installLoading.value) return
  installPreview.value = null
  installCandidateId.value = ''
  installError.value = ''
}

async function confirmSkillInstall() {
  const preview = installPreview.value
  const candidate = installCandidate.value
  if (!preview || !candidate?.valid || installLoading.value) return
  installLoading.value = true
  installError.value = ''
  try {
    const result = await core('skills.confirmInstall', {
      previewId: preview.previewId,
      digest: preview.digest,
      candidateId: candidate.candidateId,
      permissionConfirmed: true,
    })
    installPreview.value = null
    installCandidateId.value = ''
    emit('installed', result.name)
  } catch (error) {
    installError.value = error instanceof Error ? error.message : String(error)
  } finally {
    installLoading.value = false
  }
}

function sourceLabel(preview: SkillInstallPreview): string {
  if (preview.source.kind === 'local') return preview.source.path
  return preview.source.repository || preview.source.resolvedUrl
}

function missingCount() {
  const missing = installCandidate.value?.missing
  return missing
    ? missing.bins.length + missing.runtimes.length + missing.env.length
    : 0
}
</script>

<template>
  <div
    class="panel-content capability-panel"
    :class="{ 'has-detail': detailOpen && props.activeSkill }"
  >
    <div class="panel-toolbar">
      <div class="filter-wrap">
        <input v-model="filter" placeholder="筛选技能" />
        <span
          v-if="filtered.length !== props.skills.length"
          class="filter-badge"
        >
          {{ filtered.length }} / {{ props.skills.length }}
        </span>
        <span v-else-if="props.skills.length" class="filter-badge">
          共 {{ props.skills.length }} 个
        </span>
      </div>
      <button
        class="tool-button asset-button primary-action"
        @click="createSkill"
      >
        <component :is="actionIcons.new" class="action-icon" :size="16" />
        <span>新增</span>
      </button>
      <button
        class="tool-button asset-button"
        :disabled="installLoading"
        @click="importInput?.click()"
      >
        <PackageSearch :size="16" />
        <span>{{ installLoading ? '检查中' : '安装 Skill' }}</span>
      </button>
      <button
        class="icon-button"
        :disabled="installLoading"
        title="从 GitHub 或 HTTPS 链接安装"
        aria-label="从链接安装 Skill"
        @click="linkInstallOpen = true"
      >
        <Link :size="16" />
      </button>
      <input
        ref="importInput"
        type="file"
        accept=".zip,.skill"
        class="hidden"
        @change="onImportFile"
      />
    </div>

    <div
      v-if="installError && !installPreview"
      class="skill-install-error"
      role="alert"
    >
      <AlertCircle :size="17" />
      <span>{{ installError }}</span>
      <button class="icon-button" title="关闭" @click="installError = ''">
        <X :size="14" />
      </button>
    </div>

    <div class="capability-card-grid panel-scroll">
      <CapabilityCard
        v-for="item in skillItems"
        :key="item.id"
        :item="item"
        :active="props.activeSkill === item.name"
        @select="openSkillItem"
      />
      <div
        v-if="!filtered.length"
        class="empty-state illustrated-empty tool-empty"
      >
        <component :is="emptyIcons.skills" :size="64" :stroke-width="1" />
        <span>还没有发现技能。</span>
      </div>
    </div>

    <aside
      v-if="detailOpen && props.activeSkill"
      class="capability-detail-drawer"
    >
      <div class="capability-drawer-head">
        <div class="min-w-0">
          <h2>{{ props.activeSkill }}</h2>
          <p>{{ activeSkillInfo?.path || 'SKILL.md' }}</p>
        </div>
        <button class="icon-button" title="关闭" @click="detailOpen = false">
          ×
        </button>
      </div>

      <div class="capability-drawer-badges">
        <span
          v-if="activeSkillInfo?.status && activeSkillInfo.status !== 'active'"
          class="badge gold"
        >
          {{ activeSkillInfo.status }}
        </span>
        <span v-if="activeSkillInfo?.always" class="badge gold">always</span>
        <span
          v-for="tag in parseTags(activeSkillInfo?.tags || '')"
          :key="tag"
          class="badge green"
          >{{ tag }}</span
        >
        <span class="badge">md</span>
        <button
          class="badge preview-toggle"
          :class="{ active: preview }"
          @click="preview = !preview"
        >
          {{ preview ? '编辑' : '预览' }}
        </button>
      </div>

      <div v-if="preview" class="skill-preview">
        <MarkdownBlock :content="draft" />
      </div>
      <textarea v-else v-model="draft" class="capability-editor-textarea" />

      <div class="capability-drawer-actions">
        <button
          class="tool-button danger"
          @click="confirmDelete(props.activeSkill)"
        >
          删除
        </button>
        <button
          class="tool-button ink asset-button primary-action"
          @click="emit('save', draft)"
        >
          <component :is="actionIcons.save" class="action-icon" :size="16" />
          <span>保存技能</span>
        </button>
      </div>
    </aside>

    <div
      v-if="linkInstallOpen"
      class="modal-backdrop skill-install-backdrop"
      @click.self="linkInstallOpen = false"
    >
      <form
        class="skill-link-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="skill-link-title"
        @submit.prevent="previewSkillUrl"
      >
        <header>
          <div>
            <h2 id="skill-link-title">从链接检查 Skill</h2>
            <p>支持公开 GitHub repo/tree 与 HTTPS .skill/.zip</p>
          </div>
          <button
            class="icon-button"
            type="button"
            title="关闭"
            aria-label="关闭"
            @click="linkInstallOpen = false"
          >
            <X :size="16" />
          </button>
        </header>
        <label>
          <span>来源链接</span>
          <input
            v-model="linkInstallUrl"
            type="url"
            required
            placeholder="https://github.com/owner/repository"
            autocomplete="off"
          />
        </label>
        <div v-if="installError" class="skill-install-error" role="alert">
          <AlertCircle :size="17" />
          <span>{{ installError }}</span>
        </div>
        <footer>
          <button
            class="tool-button"
            type="button"
            @click="linkInstallOpen = false"
          >
            取消
          </button>
          <button
            class="tool-button ink"
            type="submit"
            :disabled="installLoading || !linkInstallUrl.trim()"
          >
            {{ installLoading ? '检查中' : '检查来源' }}
          </button>
        </footer>
      </form>
    </div>

    <div
      v-if="installPreview"
      class="modal-backdrop skill-install-backdrop"
      @click.self="closeInstallPreview"
    >
      <section
        class="skill-install-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="skill-install-title"
      >
        <header>
          <div>
            <h2 id="skill-install-title">检查 Skill 安装内容</h2>
            <p>{{ sourceLabel(installPreview) }}</p>
          </div>
          <button
            class="icon-button"
            title="关闭"
            aria-label="关闭"
            @click="closeInstallPreview"
          >
            <X :size="16" />
          </button>
        </header>

        <div class="skill-install-summary">
          <div>
            <span>摘要</span>
            <code>{{ installPreview.digest.slice(0, 16) }}…</code>
          </div>
          <div>
            <span>文件</span>
            <strong>{{ installPreview.fileCount }}</strong>
          </div>
          <div>
            <span>解压后</span>
            <strong>{{
              formatEnvironmentBytes(installPreview.unpackedBytes)
            }}</strong>
          </div>
        </div>

        <div
          v-if="installPreview.candidates.length > 1"
          class="skill-candidate-list"
        >
          <label
            v-for="candidate in installPreview.candidates"
            :key="candidate.candidateId"
          >
            <input
              v-model="installCandidateId"
              type="radio"
              name="skill-candidate"
              :value="candidate.candidateId"
            />
            <span>
              <strong>{{ candidate.name }}</strong>
              <small>{{ candidate.relativeRoot }}</small>
            </span>
            <code>{{ candidate.valid ? '可安装' : '无效' }}</code>
          </label>
        </div>

        <template v-if="installCandidate">
          <div v-if="!installCandidate.valid" class="skill-risk-block danger">
            <AlertCircle :size="17" />
            <div>
              <strong>此候选项不能安装</strong>
              <span v-for="message in installCandidate.errors" :key="message">{{
                message
              }}</span>
            </div>
          </div>

          <div
            v-if="
              installCandidate.scripts.length ||
              installCandidate.externalCommands.length
            "
            class="skill-risk-block"
          >
            <ShieldAlert :size="17" />
            <div>
              <strong>脚本与外部命令</strong>
              <span
                v-for="script in installCandidate.scripts"
                :key="script.path"
              >
                {{ script.type }} · {{ script.path }}
              </span>
              <span
                v-for="command in installCandidate.externalCommands"
                :key="command"
              >
                command · {{ command }}
              </span>
            </div>
          </div>

          <div v-if="missingCount()" class="skill-risk-block blocked">
            <ShieldAlert :size="17" />
            <div>
              <strong>安装后将保持 blocked</strong>
              <span>
                {{
                  [
                    ...installCandidate.missing.bins,
                    ...installCandidate.missing.runtimes,
                    ...installCandidate.missing.env,
                  ].join(' · ')
                }}
              </span>
            </div>
          </div>

          <details class="skill-file-list">
            <summary>文件清单 · {{ installCandidate.fileCount }}</summary>
            <code v-for="file in installCandidate.files" :key="file">{{
              file
            }}</code>
          </details>
        </template>

        <div v-if="installError" class="skill-install-error" role="alert">
          <AlertCircle :size="17" />
          <span>{{ installError }}</span>
        </div>

        <footer>
          <button class="tool-button" @click="closeInstallPreview">取消</button>
          <button
            class="tool-button ink"
            :disabled="installLoading || !installCandidate?.valid"
            data-testid="confirm-skill-install"
            @click="confirmSkillInstall"
          >
            {{
              installLoading
                ? '安装中'
                : missingCount()
                  ? '安装为 blocked'
                  : '确认安装'
            }}
          </button>
        </footer>
      </section>
    </div>
  </div>
</template>

<style scoped>
.skill-install-error {
  display: grid;
  grid-template-columns: 20px minmax(0, 1fr) auto;
  align-items: center;
  gap: var(--space-2);
  border: 1px solid rgb(var(--danger) / 0.45);
  border-radius: var(--radius-md);
  padding: var(--space-2) 11px;
  background: rgb(var(--bg-elevated));
  color: rgb(var(--danger));
  font-size: var(--font-size-sm);
}

.skill-install-modal {
  display: flex;
  width: min(620px, calc(100vw - 24px));
  max-height: min(760px, calc(100dvh - 24px));
  flex-direction: column;
  gap: var(--space-3);
  overflow-y: auto;
  border: 1px solid rgb(var(--border));
  border-radius: var(--radius-md);
  padding: var(--space-4);
  background: rgb(var(--bg));
  box-shadow: 0 18px 48px rgb(var(--shadow-color) / 0.32);
}

.skill-link-modal {
  display: grid;
  width: min(520px, calc(100vw - 24px));
  gap: var(--space-3);
  border: 1px solid rgb(var(--border));
  border-radius: var(--radius-md);
  padding: var(--space-4);
  background: rgb(var(--bg));
  box-shadow: 0 18px 48px rgb(var(--shadow-color) / 0.32);
}

.skill-link-modal > header,
.skill-link-modal > footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
}

.skill-link-modal h2 {
  color: rgb(var(--fg));
  font-size: var(--font-size-lg);
  font-weight: 700;
}

.skill-link-modal header p,
.skill-link-modal label > span {
  color: rgb(var(--fg-subtle));
  font-size: var(--font-size-xs);
}

.skill-link-modal label {
  display: grid;
  gap: var(--space-2);
}

.skill-link-modal input {
  width: 100%;
  min-width: 0;
}

.skill-link-modal > footer .tool-button:last-child {
  margin-left: auto;
}

.skill-install-modal > header,
.skill-install-modal > footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
}

.skill-install-modal h2 {
  color: rgb(var(--fg));
  font-size: var(--font-size-lg);
  font-weight: 700;
}

.skill-install-modal header p {
  max-width: 520px;
  margin-top: 2px;
  overflow: hidden;
  color: rgb(var(--fg-subtle));
  font-size: var(--font-size-xs);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.skill-install-summary {
  display: grid;
  grid-template-columns: minmax(0, 2fr) repeat(2, minmax(0, 1fr));
  border-block: 1px solid rgb(var(--border));
}

.skill-install-summary > div {
  display: grid;
  min-width: 0;
  gap: var(--space-1);
  padding: var(--space-2) 8px;
}

.skill-install-summary span {
  color: rgb(var(--fg-subtle));
  font-size: var(--font-size-2xs);
}

.skill-install-summary code,
.skill-install-summary strong {
  overflow: hidden;
  color: rgb(var(--fg));
  font-size: var(--font-size-xs);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.skill-candidate-list {
  display: grid;
  gap: var(--space-2);
}

.skill-candidate-list label {
  display: grid;
  grid-template-columns: 18px minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  min-height: 44px;
  border: 1px solid rgb(var(--border));
  border-radius: var(--radius-md);
  padding: var(--space-2) 9px;
}

.skill-candidate-list label:has(input:checked) {
  border-color: rgb(var(--accent) / 0.55);
  background: rgb(var(--accent) / 0.08);
}

.skill-candidate-list label > span {
  display: grid;
  min-width: 0;
  gap: 2px;
}

.skill-candidate-list small {
  overflow: hidden;
  color: rgb(var(--fg-subtle));
  font-size: var(--font-size-2xs);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.skill-risk-block {
  display: grid;
  grid-template-columns: 20px minmax(0, 1fr);
  gap: var(--space-2);
  border: 1px solid rgb(var(--warning) / 0.4);
  border-radius: var(--radius-md);
  padding: var(--space-2) 10px;
  color: rgb(var(--warning));
}

.skill-risk-block.danger {
  border-color: rgb(var(--danger) / 0.45);
  color: rgb(var(--danger));
}

.skill-risk-block.blocked {
  border-color: rgb(var(--border));
  color: rgb(var(--fg-muted));
}

.skill-risk-block > div {
  display: grid;
  min-width: 0;
  gap: var(--space-1);
}

.skill-risk-block strong {
  color: rgb(var(--fg));
  font-size: var(--font-size-sm);
}

.skill-risk-block span {
  overflow-wrap: anywhere;
  color: rgb(var(--fg-subtle));
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: var(--font-size-2xs);
}

.skill-file-list {
  border: 1px solid rgb(var(--border));
  border-radius: var(--radius-md);
}

.skill-file-list summary {
  cursor: pointer;
  padding: var(--space-2) 10px;
  color: rgb(var(--fg-muted));
  font-size: var(--font-size-xs);
}

.skill-file-list code {
  display: block;
  overflow-wrap: anywhere;
  border-top: 1px solid rgb(var(--border));
  padding: var(--space-1) 10px;
  color: rgb(var(--fg-subtle));
  font-size: var(--font-size-2xs);
}

.skill-install-modal > footer {
  position: sticky;
  bottom: -14px;
  border-top: 1px solid rgb(var(--border));
  padding: var(--space-3) 0 14px;
  background: rgb(var(--bg));
}

.skill-install-modal > footer .tool-button:last-child {
  margin-left: auto;
}

@media (max-width: 640px) {
  .skill-install-modal {
    width: calc(100vw - 16px);
    max-height: calc(100dvh - 16px);
  }

  .skill-link-modal {
    width: calc(100vw - 16px);
  }

  .skill-install-summary {
    grid-template-columns: minmax(0, 1fr);
  }

  .skill-install-summary > div + div {
    border-top: 1px solid rgb(var(--border));
  }
}
</style>
