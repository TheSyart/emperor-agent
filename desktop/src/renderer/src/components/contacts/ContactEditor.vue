<script setup lang="ts">
/**
 * ContactEditor — /contacts/new and /contacts/:id/edit (GRP-04, 预览 B 第 1
 * 步): a contact as a seven-section role card — 1 身份, 2 职责与交付, 3 工作
 * 方法, 4 知识, 5 边界, 6 能力, 7 群聊习惯. A new contact starts one of four
 * ways (ContactMethods): a role template, a description Emperor drafts
 * from, an imported agent file, or a copy. On the right: the completeness
 * check (a hint, never a block), the trial bench and the compiled prompt.
 *
 * Nothing is saved until 保存联系人 (`contacts.create` / `contacts.update`).
 * Sections Emperor drafted carry 「AI 起草」 until the user changes them. A
 * builtin contact changes only its avatar and intro; an external one keeps
 * its executor's model and permission.
 *
 * Data: `contacts.list`, `contacts.templates`, `model.getConfig` and
 * `sessions.defaults` when the route opens; `contacts.preview` (debounced)
 * as the draft changes.
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type {
  Contact,
  ContactDomain,
  ContactKnowledge,
  ContactMcpSelection,
  ContactSkillSelection,
  ContactPreview,
  ContactTemplate,
  ContactToolPreset,
  ContactTrialResult,
  ContactsListing,
} from '@emperor/core/api'
import { core } from '../../api/http'
import { selectDirectory, selectFile } from '../../api/backend'
import { useAppContext } from '../../composables/useAppContext'
import type { ModelConfigPayload } from '../../types'
import Avatar from '../ui/Avatar.vue'
import Badge from '../ui/Badge.vue'
import Button from '../ui/Button.vue'
import EmptyState from '../ui/EmptyState.vue'
import Field from '../ui/Field.vue'
import Notice from '../ui/Notice.vue'
import Segmented from '../ui/Segmented.vue'
import Select from '../ui/Select.vue'
import Switch from '../ui/Switch.vue'
import Tag from '../ui/Tag.vue'
import TextArea from '../ui/TextArea.vue'
import TextField from '../ui/TextField.vue'
import { confirm } from '../ui/confirm'
import AvatarRecommend from './AvatarRecommend.vue'
import CompiledPromptPreview from './CompiledPromptPreview.vue'
import CompletenessPanel from './CompletenessPanel.vue'
import ContactMethods from './ContactMethods.vue'
import TemplatePicker from './TemplatePicker.vue'
import TrialBench from './TrialBench.vue'
import { contactAvatarProps } from './contactAvatar'
import {
  applyBrief,
  charHint,
  completeness,
  createInput,
  draftCopy,
  draftFromContact,
  draftFromImport,
  draftFromTemplate,
  draftInput,
  editSection,
  emptyDraft,
  failureText,
  LIMITS,
  setPreset,
  toggleTool,
  toolChips,
  updatePatch,
  workspaceWriteAllowed,
  type ContactMethod,
  type EditorDraft,
  type SectionKey,
  type ToolPresetTable,
} from './contactEditorModel'

const route = useRoute()
const router = useRouter()
const ctx = useAppContext()

// ── state ─────────────────────────────────────────────────────────────

const draft = ref<EditorDraft>(emptyDraft())
const drafted = ref<Set<SectionKey>>(new Set())
const dirty = ref(false)
const loadedPath = ref('')
const loading = ref(true)
const loadError = ref('')
const listing = ref<ContactsListing | null>(null)
const templates = ref<ContactTemplate[]>([])
const models = ref<ModelConfigPayload['models']>([])
const globalPermission = ref('workspace-write')
const avatarOrigin = ref<'recommended' | 'saved'>('recommended')
/** Bumped on every new start: the avatar row starts over. */
const avatarEpoch = ref(0)
/** The user chose the avatar from the library: new starts keep it. */
const avatarPicked = ref(false)
const method = ref<ContactMethod>('template')
const trialRan = ref(false)
const saving = ref(false)
const saveError = ref('')

const isNew = computed(
  () => route.name === 'contact-new' || route.name === 'contact-advanced-new',
)
const editing = computed(() =>
  route.name === 'contact-edit' || route.name === 'contact-advanced-edit'
    ? String(route.params.id ?? '')
    : '',
)
const readOnly = computed(() => listing.value?.readOnly ?? null)
const locked = computed(() => draft.value.builtin)
const external = computed(() => draft.value.kind === 'external')
const contacts = computed(() => listing.value?.contacts ?? [])
const template = computed(
  () =>
    templates.value.find((item) => item.id === draft.value.templateId) ?? null,
)

/** Avatars other contacts use, and who uses them. */
const inUse = computed(() =>
  Object.fromEntries(
    contacts.value
      .filter((contact) => contact.id !== draft.value.id)
      .flatMap((contact) =>
        contact.avatar.kind === 'library'
          ? [[contact.avatar.id, contact.name] as const]
          : [],
      ),
  ),
)

// ── loading ───────────────────────────────────────────────────────────

async function load() {
  const path = route.fullPath
  loadedPath.value = path
  loading.value = true
  loadError.value = ''
  saveError.value = ''
  drafted.value = new Set()
  dirty.value = false
  trialRan.value = false
  method.value = 'template'
  avatarPicked.value = false
  avatarEpoch.value += 1
  try {
    const [list, tmpl, config, defaults] = await Promise.all([
      core('contacts.list'),
      core('contacts.templates'),
      core('model.getConfig').catch(() => null),
      core('sessions.defaults').catch(() => null),
    ])
    if (loadedPath.value !== path) return
    listing.value = Array.isArray(list?.contacts)
      ? list
      : { contacts: [], readOnly: null }
    templates.value = Array.isArray(tmpl) ? tmpl : []
    models.value = (config as ModelConfigPayload | null)?.models ?? []
    globalPermission.value = defaults?.permission ?? 'workspace-write'
    if (editing.value) {
      const contact = await core('contacts.get', { id: editing.value })
      if (loadedPath.value !== path) return
      draft.value = draftFromContact(contact)
      avatarOrigin.value = 'saved'
    } else {
      draft.value = emptyDraft()
      avatarOrigin.value = 'recommended'
      await recommend({})
    }
  } catch (error) {
    loadError.value = failureText(error)
  } finally {
    if (loadedPath.value === path) loading.value = false
  }
}

watch(
  () => [route.name, route.fullPath] as const,
  ([name, path]) => {
    if (
      name !== 'contact-new' &&
      name !== 'contact-edit' &&
      name !== 'contact-advanced-new' &&
      name !== 'contact-advanced-edit'
    )
      return
    if (path !== loadedPath.value) void load()
  },
  { immediate: true },
)

async function recommend(input: { templateId?: string }) {
  try {
    const pick = await core('contacts.recommendAvatar', input)
    if (typeof pick?.id !== 'string') return
    draft.value = { ...draft.value, avatar: { kind: 'library', id: pick.id } }
  } catch {
    // The avatar shown stays; 换一个 can try again.
  }
}

// ── the four ways ─────────────────────────────────────────────────────

/** Whether to replace what the user has typed (asked only when there is some). */
async function mayReplace(what: string): Promise<boolean> {
  if (!dirty.value) return true
  return confirm({
    title: `用${what}替换现在填的内容？`,
    body: '现在填的内容没有保存，替换后找不回来。',
    confirmLabel: '替换',
  })
}

/** The avatar for a new start: kept when the user picked it; else recommended. */
async function startAvatar(templateId?: string, preferred?: string) {
  if (avatarOrigin.value === 'saved' || avatarPicked.value) return
  avatarEpoch.value += 1
  if (preferred && !inUse.value[preferred]) {
    draft.value = {
      ...draft.value,
      avatar: { kind: 'library', id: preferred },
    }
    return
  }
  await recommend(templateId ? { templateId } : {})
}

async function pickTemplate(picked: ContactTemplate) {
  if (!(await mayReplace(`「${picked.name}」模板`))) return
  const avatar = draft.value.avatar
  draft.value = {
    ...draftFromTemplate(picked, {
      contacts: contacts.value,
      globalPermission: globalPermission.value,
    }),
    avatar,
  }
  drafted.value = new Set()
  dirty.value = false
  await startAvatar(picked.id, picked.avatar)
}

// 说说你要什么人
const brief = ref('')
const questions = ref<string[]>([])
const answers = ref<string[]>([])
const drafting = ref(false)
const briefError = ref('')

async function draftBrief(withAnswers: boolean) {
  if (drafting.value || !brief.value.trim()) return
  drafting.value = true
  briefError.value = ''
  try {
    const result = await core('contacts.draftFromBrief', {
      brief: brief.value.trim(),
      ...(withAnswers
        ? {
            answers: questions.value.map((question, index) => ({
              question,
              answer: (answers.value[index] ?? '').trim(),
            })),
          }
        : {}),
    })
    if (result.kind === 'questions') {
      questions.value = result.questions
      answers.value = result.questions.map(() => '')
      return
    }
    if (!(await mayReplace('起草的岗位说明书'))) return
    const next = applyBrief(draft.value, result.draft, result.sections)
    draft.value = next.draft
    drafted.value = next.drafted
    dirty.value = false
    questions.value = []
    answers.value = []
  } catch (error) {
    // The description stays for another try.
    briefError.value = failureText(error)
  } finally {
    drafting.value = false
  }
}

// 导入
const importNotes = ref<string[]>([])
const importing = ref(false)
const importError = ref('')

async function importFile() {
  if (importing.value) return
  importError.value = ''
  const path = await selectFile({
    title: '选一个岗位文件或提示词文件',
    filters: [{ name: '文本', extensions: ['md', 'markdown', 'txt'] }],
  })
  if (!path) return
  importing.value = true
  try {
    const result = await core('contacts.importAgentFile', { path })
    if (!(await mayReplace('导入的内容'))) return
    draft.value = draftFromImport(result, draft.value)
    importNotes.value = result.notes
    drafted.value = new Set()
    dirty.value = false
  } catch (error) {
    importError.value = failureText(error)
  } finally {
    importing.value = false
  }
}

// 复制已有联系人 (the ones the user made; builtins are not copied)
const copySources = computed(() =>
  contacts.value.filter((contact) => !contact.builtin),
)

async function copyFrom(source: Contact) {
  if (!(await mayReplace(`「${source.name}」的副本`))) return
  draft.value = draftCopy(source, contacts.value)
  drafted.value = new Set()
  dirty.value = false
  await startAvatar(source.templateId)
}

// ── editing ───────────────────────────────────────────────────────────

/** Apply a change made in `section` (its 「AI 起草」 mark goes). */
function change(section: SectionKey, next: Partial<EditorDraft>) {
  draft.value = { ...draft.value, ...next }
  drafted.value = editSection(drafted.value, section)
  dirty.value = true
}

function changeRole(
  section: SectionKey,
  key: 'mission' | 'deliverable' | 'playbook' | 'boundaries',
  value: string,
) {
  change(section, { role: { ...draft.value.role, [key]: value } })
}

function setTrialTask(task: string) {
  const role = { ...draft.value.role }
  if (task.trim()) role.trialTask = task
  else delete role.trialTask
  draft.value = { ...draft.value, role }
  dirty.value = true
}

const DOMAINS: ReadonlyArray<{ value: ContactDomain; label: string }> = [
  { value: 'engineering', label: '工程' },
  { value: 'security', label: '安全' },
  { value: 'design', label: '设计' },
  { value: 'content', label: '内容' },
  { value: 'product', label: '产品' },
  { value: 'data', label: '数据' },
  { value: 'decision', label: '决策' },
  { value: 'other', label: '其他' },
]

function toggleDomain(domain: ContactDomain) {
  const current = draft.value.domains
  const next = current.includes(domain)
    ? current.filter((item) => item !== domain)
    : [...current, domain]
  if (next.length > LIMITS.domains) return
  change('identity', { domains: next })
}

// 知识（CP-01：文件、文件夹、网址、笔记）
const refInput = ref('')
const noteTitle = ref('')
const noteText = ref('')
const refError = ref('')

function newId(prefix: 'kr' | 'sk'): string {
  return `${prefix}-${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`
}

function knowledgeLabel(ref: ContactKnowledge): string {
  switch (ref.kind) {
    case 'file':
      return `文件 · ${ref.path.split('/').pop() || ref.path}`
    case 'folder':
      return `文件夹 · ${ref.path.split('/').pop() || ref.path}`
    case 'url':
      return `网址 · ${ref.url.replace(/^https:\/\//, '')}`
    case 'note':
      return `笔记 · ${ref.title}`
  }
}

function knowledgeTitle(ref: ContactKnowledge): string {
  switch (ref.kind) {
    case 'file':
    case 'folder':
      return ref.path
    case 'url':
      return ref.url
    case 'note':
      return ref.title
  }
}

function setKnowledge(next: ContactKnowledge[]) {
  change('knowledge', { knowledge: next })
}

function addKnowledge(ref: ContactKnowledge) {
  const list = draft.value.knowledge
  if (list.length >= LIMITS.knowledge) {
    refError.value = `知识最多 ${LIMITS.knowledge} 条`
    return
  }
  if (
    list.some(
      (item) =>
        knowledgeTitle(item) === knowledgeTitle(ref) && item.kind === ref.kind,
    )
  )
    return
  refError.value = ''
  setKnowledge([...list, ref])
}

async function addFile() {
  const path = await selectFile({ title: '选一个参考文件' })
  if (path)
    addKnowledge({ id: newId('kr'), kind: 'file', path, use: 'on_demand' })
}

async function addFolder() {
  const path = await selectDirectory()
  if (path)
    addKnowledge({ id: newId('kr'), kind: 'folder', path, use: 'on_demand' })
}

function addTyped() {
  const value = refInput.value.trim()
  if (!value) return
  if (!/^https:\/\/\S+$/.test(value)) {
    refError.value = '网址要以 https:// 开头'
    return
  }
  addKnowledge({
    id: newId('kr'),
    kind: 'url',
    url: value,
    use: 'on_demand',
  })
  refInput.value = ''
}

function addNote() {
  const title = noteTitle.value.trim()
  const text = noteText.value.trim()
  if (!title || !text) {
    refError.value = '笔记要有标题和内容'
    return
  }
  addKnowledge({
    id: newId('kr'),
    kind: 'note',
    title,
    text,
    use: 'on_demand',
  })
  noteTitle.value = ''
  noteText.value = ''
}

function removeKnowledge(index: number) {
  setKnowledge(draft.value.knowledge.filter((_, at) => at !== index))
}

function togglePinned(index: number) {
  setKnowledge(
    draft.value.knowledge.map((item, at) =>
      at === index && item.kind !== 'url'
        ? { ...item, use: item.use === 'pinned' ? 'on_demand' : 'pinned' }
        : item,
    ),
  )
}

// 能力：Skill 与 MCP（CP-02），只从当前安装的目录里选。
const skillChoices = computed(() =>
  (ctx.boot?.value?.skills ?? []).filter((skill) => skill.status === 'active'),
)

const mcpChoices = computed(() => {
  const servers = ctx.boot?.value?.mcp?.servers ?? []
  return servers.map((server) => ({
    serverId: server.serverName,
    state: server.state,
    tools: [...(server.tools ?? [])],
  }))
})

function skillSelected(name: string): boolean {
  return draft.value.skills.some((skill) => skill.name === name)
}

function toggleSkill(name: string): void {
  const current = draft.value.skills
  if (current.some((skill) => skill.name === name))
    change('capabilities', {
      skills: current.filter((skill) => skill.name !== name),
    })
  else {
    const found = skillChoices.value.find((skill) => skill.name === name)
    if (!found) return
    const next: ContactSkillSelection = {
      id: newId('sk'),
      sourceId: found.source ?? 'user',
      name: found.name,
    }
    change('capabilities', { skills: [...current, next] })
  }
}

function mcpSelected(serverId: string): boolean {
  return draft.value.mcp.some((server) => server.serverId === serverId)
}

/** CG-CT-01: one service switch; runtime still filters each named tool. */
function toggleMcp(serverId: string): void {
  if (mcpSelected(serverId)) {
    change('capabilities', {
      mcp: draft.value.mcp.filter((server) => server.serverId !== serverId),
    })
    return
  }
  const server = mcpChoices.value.find((item) => item.serverId === serverId)
  if (!server || server.state !== 'ready') return
  const next: ContactMcpSelection = {
    serverId,
    toolNames: [...server.tools],
  }
  change('capabilities', { mcp: [...draft.value.mcp, next] })
}

// 能力
const presets = ref<ToolPresetTable | null>(null)

const MODEL_HINTS: Readonly<Record<string, string>> = {
  reasoning: '推理强的模型',
  balanced: '均衡的模型',
  fast: '快的模型',
  vision: '能看图的模型',
  long_context: '上下文长的模型',
}

const modelValue = computed(() => {
  const model = draft.value.capabilities.model
  return model === 'inherit' ? 'inherit' : model.profileId
})

const modelOptions = computed(() => {
  const options = [
    {
      value: 'inherit',
      label: '默认模型',
      description: '跟随「设置 › 模型」里正在用的模型',
    },
    ...models.value.map((entry) => ({
      value: entry.entryId,
      label: entry.effectiveDisplayName || entry.modelId,
      description: entry.modelId,
    })),
  ]
  const current = modelValue.value
  if (
    current !== 'inherit' &&
    !options.some((option) => option.value === current)
  )
    options.push({
      value: current,
      label: `${current}（已不在模型列表里）`,
      description: '运行时会先问你要不要换成默认模型',
    })
  return options
})

const reasoningOptions = computed(() => {
  const entry = models.value.find((item) => item.entryId === modelValue.value)
  const efforts = entry?.resolvedProfile?.reasoningEfforts ?? []
  const labels: Record<string, string> = { low: '低', medium: '中', high: '高' }
  return [
    { value: 'default', label: '模型默认' },
    ...(['low', 'medium', 'high'] as const)
      .filter((effort) => efforts.includes(effort))
      .map((effort) => ({
        value: effort,
        label: `推理强度：${labels[effort]}`,
      })),
  ]
})

const reasoningValue = computed(() => {
  const model = draft.value.capabilities.model
  return model === 'inherit' ? 'default' : (model.reasoning ?? 'default')
})

function setModel(value: string) {
  change('capabilities', {
    capabilities: {
      ...draft.value.capabilities,
      model: value === 'inherit' ? 'inherit' : { profileId: value },
    },
  })
}

function setReasoning(value: string) {
  const model = draft.value.capabilities.model
  if (model === 'inherit') return
  const next = {
    profileId: model.profileId,
    ...(model.model ? { model: model.model } : {}),
  }
  change('capabilities', {
    capabilities: {
      ...draft.value.capabilities,
      model:
        value === 'low' || value === 'medium' || value === 'high'
          ? { ...next, reasoning: value }
          : next,
    },
  })
}

const PRESET_OPTIONS: ReadonlyArray<{
  value: ContactToolPreset
  label: string
}> = [
  { value: 'read_only', label: '只读' },
  { value: 'research', label: '调研' },
  { value: 'writer', label: '写作' },
  { value: 'engineer', label: '工程' },
  { value: 'custom', label: '自定义' },
]

const chips = computed(() =>
  presets.value ? toolChips(draft.value.capabilities.tools, presets.value) : [],
)

function choosePreset(preset: ContactToolPreset) {
  if (!presets.value) return
  change('capabilities', {
    capabilities: {
      ...draft.value.capabilities,
      tools: setPreset(draft.value.capabilities.tools, preset, presets.value),
    },
  })
}

function flipTool(name: string) {
  if (!presets.value) return
  change('capabilities', {
    capabilities: {
      ...draft.value.capabilities,
      tools: toggleTool(draft.value.capabilities.tools, name, presets.value),
    },
  })
}

const permissionOptions = computed(() => [
  { value: 'inherit' as const, label: '跟随新会话的权限' },
  { value: 'read_only' as const, label: '只读' },
  {
    value: 'workspace_write' as const,
    label: '可以改工作区',
    disabled: !workspaceWriteAllowed(globalPermission.value),
  },
])

function setPermission(value: EditorDraft['capabilities']['permission']) {
  change('capabilities', {
    capabilities: { ...draft.value.capabilities, permission: value },
  })
}

// 群聊习惯
const SPEAK_OPTIONS = [
  { value: 'mentioned' as const, label: '只在被点名时' },
  { value: 'relevant' as const, label: '和职责相关时举手' },
  { value: 'always' as const, label: '总是发言' },
]
const LENGTH_OPTIONS = [
  { value: 'brief' as const, label: '简明' },
  { value: 'detailed' as const, label: '详细' },
]

// ── the side: preview, completeness, trial ───────────────────────────

const preview = ref<ContactPreview | null>(null)
const previewing = ref(false)
const previewError = ref('')
let previewTimer: ReturnType<typeof setTimeout> | null = null
let previewRun = 0

const input = computed(() => draftInput(draft.value))

async function refreshPreview() {
  const run = ++previewRun
  previewing.value = true
  try {
    const result = await core('contacts.preview', {
      draft: JSON.parse(JSON.stringify(input.value)),
    })
    if (run !== previewRun) return
    preview.value = result
    presets.value = result.presets ?? null
    previewError.value = ''
  } catch (error) {
    if (run === previewRun) previewError.value = failureText(error)
  } finally {
    if (run === previewRun) previewing.value = false
  }
}

watch(
  [input, loading],
  () => {
    if (loading.value || loadError.value) return
    if (previewTimer) clearTimeout(previewTimer)
    previewTimer = setTimeout(() => void refreshPreview(), 400)
  },
  { deep: true },
)

onBeforeUnmount(() => {
  if (previewTimer) clearTimeout(previewTimer)
})

const checks = computed(() =>
  completeness(draft.value, {
    tools: preview.value?.tools ?? null,
    globalPermission: globalPermission.value,
    trialRan: trialRan.value,
  }),
)

function onRan(result: ContactTrialResult) {
  if (result.status === 'completed') trialRan.value = true
}

// ── limits and saving ─────────────────────────────────────────────────

const hints = computed(() => ({
  name: charHint(draft.value.name, LIMITS.name),
  intro: charHint(draft.value.intro, LIMITS.intro),
  mission: charHint(draft.value.role.mission, LIMITS.mission),
  deliverable: charHint(draft.value.role.deliverable, LIMITS.deliverable),
  playbook: charHint(draft.value.role.playbook, LIMITS.playbook),
  boundaries: charHint(draft.value.role.boundaries, LIMITS.boundaries),
}))

const nameError = computed(() => {
  const name = draft.value.name.trim()
  if (!name) return dirty.value || saveError.value ? '名字不能为空' : undefined
  if (name.includes('@')) return '名字里不能有 @（群里用 @名字 点名）'
  return hints.value.name.over ? hints.value.name.text : undefined
})

const canSave = computed(
  () =>
    !loading.value &&
    !readOnly.value &&
    !saving.value &&
    draft.value.name.trim() !== '' &&
    !nameError.value &&
    // A builtin keeps its shipped card (Emperor's is the long persona).
    !(locked.value ? [hints.value.intro] : Object.values(hints.value)).some(
      (hint) => hint.over,
    ),
)

function filled(section: SectionKey): boolean {
  const { role } = draft.value
  switch (section) {
    case 'identity':
      return draft.value.name.trim() !== '' && draft.value.intro.trim() !== ''
    case 'mission':
      return role.mission.trim() !== '' && role.deliverable.trim() !== ''
    case 'playbook':
      return role.playbook.trim() !== ''
    case 'knowledge':
      return draft.value.knowledge.length > 0
    case 'boundaries':
      return role.boundaries.trim() !== ''
    default:
      return false
  }
}

async function save() {
  if (!canSave.value) return
  saving.value = true
  saveError.value = ''
  try {
    if (draft.value.id) {
      const saved = await core('contacts.update', {
        id: draft.value.id,
        patch: JSON.parse(JSON.stringify(updatePatch(draft.value))),
      })
      draft.value = draftFromContact(saved)
      drafted.value = new Set()
      dirty.value = false
      ctx.showToast(`已保存「${saved.name}」`)
    } else {
      const saved = await core(
        'contacts.create',
        JSON.parse(JSON.stringify(createInput(draft.value))),
      )
      dirty.value = false
      ctx.showToast(`已保存「${saved.name}」`)
      // A new contact lands on its profile (GRP-05); 编辑 comes back here.
      await router.replace({ name: 'contact', params: { id: saved.id } })
    }
  } catch (error) {
    saveError.value = failureText(error)
  } finally {
    saving.value = false
  }
}

async function cancel() {
  if (
    dirty.value &&
    !(await confirm({
      title: '放弃没保存的改动？',
      body: '这个联系人的改动还没有保存。',
      confirmLabel: '放弃',
      tone: 'danger',
    }))
  )
    return
  dirty.value = false
  if (window.history.state?.back) router.back()
  else await router.push({ name: 'contacts' }).catch(() => undefined)
}

const title = computed(() =>
  isNew.value
    ? '新建联系人'
    : `编辑联系人${draft.value.name ? ` · ${draft.value.name}` : ''}`,
)
</script>

<template>
  <div class="contact-editor" data-contact-editor>
    <header class="bar">
      <div class="titles">
        <h1 class="title">{{ title }}</h1>
        <span class="muted">按岗位建，像写一份岗位说明书</span>
      </div>
      <div class="actions">
        <Button size="sm" @click="cancel">取消</Button>
        <Button
          size="sm"
          variant="primary"
          :loading="saving"
          :disabled="!canSave"
          @click="save"
          >保存联系人</Button
        >
      </div>
    </header>

    <div class="body">
      <main class="main">
        <Notice
          v-if="loadError"
          tone="error"
          title="联系人没有打开"
          :description="loadError"
        />
        <Notice
          v-if="readOnly"
          tone="warn"
          title="联系人现在只能查看"
          :description="readOnly.message"
        />
        <Notice
          v-if="saveError"
          tone="error"
          title="没有保存"
          :description="saveError"
        />
        <Notice
          v-if="locked"
          tone="info"
          title="内置联系人只能改头像和简介"
          description="它的岗位说明书、能力和群聊习惯随 Emperor 更新，这里不显示。"
        />
        <Notice
          v-else-if="external"
          tone="info"
          title="外部联系人"
          description="模型和权限跟随「设置 › 子智能体」，在这里只改岗位说明书。"
        />

        <template v-if="isNew && !loadError">
          <ContactMethods v-model="method" />
          <TemplatePicker
            v-if="method === 'template'"
            :templates="templates"
            :selected="draft.templateId ?? null"
            @pick="pickTemplate"
          />
          <div v-else-if="method === 'brief'" class="start" data-brief>
            <Field
              label="说说你要什么人"
              hint="做什么工作、交出什么、有什么不做的。Emperor 用你的默认模型起草，最多先问 3 个问题。"
            >
              <TextArea
                v-model="brief"
                :min-rows="3"
                :max-rows="8"
                :disabled="drafting"
                placeholder="例如：帮我审 TypeScript 改动里的安全问题，只读不改，发现高危马上说"
              />
            </Field>
            <ul v-if="questions.length" class="questions">
              <li
                v-for="(question, index) in questions"
                :key="question"
                data-brief-question
              >
                <Field :label="question">
                  <TextField
                    v-model="answers[index]"
                    size="sm"
                    :disabled="drafting"
                    placeholder="不想答可以空着"
                  />
                </Field>
              </li>
            </ul>
            <p v-if="briefError" class="error" role="alert">{{ briefError }}</p>
            <div class="start-actions">
              <Button
                v-if="questions.length"
                size="sm"
                variant="secondary"
                :loading="drafting"
                :disabled="!brief.trim()"
                @click="draftBrief(true)"
                >交给 Emperor 起草</Button
              >
              <Button
                v-else
                size="sm"
                variant="secondary"
                :loading="drafting"
                :disabled="!brief.trim()"
                @click="draftBrief(false)"
                >起草</Button
              >
              <span class="note">起草会调用一次模型，按用量计费。</span>
            </div>
          </div>
          <div v-else-if="method === 'import'" class="start" data-import>
            <p class="note">
              选一个 Claude Code 的岗位文件（.claude/agents 里的
              .md）或现成的提示词文件。只读你选的这一个文件，不超过 64
              KB；导入后先在下面看，保存前不生效。
            </p>
            <div class="start-actions">
              <Button
                size="sm"
                variant="secondary"
                :loading="importing"
                @click="importFile"
                >选择文件…</Button
              >
            </div>
            <p v-if="importError" class="error" role="alert">
              {{ importError }}
            </p>
            <ul v-if="importNotes.length" class="notes" data-import-notes>
              <li v-for="note in importNotes" :key="note">{{ note }}</li>
            </ul>
          </div>
          <div v-else class="start" data-copy>
            <div
              v-if="copySources.length"
              class="sources"
              role="group"
              aria-label="复制哪个联系人"
            >
              <Tag
                v-for="source in copySources"
                :key="source.id"
                :data-copy-source="source.id"
                :label="source.name"
                :title="source.intro"
                @click="copyFrom(source)"
              >
                <template #leading>
                  <Avatar
                    v-bind="contactAvatarProps(source.avatar, source.name)"
                    :size="16"
                  />
                </template>
              </Tag>
            </div>
            <EmptyState
              v-else
              variant="inline"
              title="还没有可以复制的联系人"
              description="先从岗位模板建一个"
            />
          </div>
        </template>

        <div v-if="!loadError" class="form">
          <!-- 1 身份 -->
          <section class="section" data-section="identity">
            <h3 class="section-title">
              <span class="num">1</span> 身份
              <small>名字、头像、一句话简介、领域</small>
              <Badge
                v-if="drafted.has('identity')"
                data-ai-drafted
                tone="accent"
                label="AI 起草"
              />
              <span v-else-if="filled('identity')" class="ok">已填</span>
            </h3>
            <AvatarRecommend
              v-model="draft.avatar"
              :template-id="draft.templateId ?? null"
              :in-use="inUse"
              :origin="avatarOrigin"
              :epoch="avatarEpoch"
              :name="draft.name"
              :disabled="!!readOnly"
              @picked="avatarPicked = true"
            />
            <div class="grid">
              <Field
                label="名字"
                data-field="name"
                :hint="hints.name.text"
                :error="nameError"
              >
                <TextField
                  :model-value="draft.name"
                  :disabled="locked"
                  placeholder="例如：安全审计"
                  @update:model-value="change('identity', { name: $event })"
                />
              </Field>
              <Field label="领域" hint="最多 3 个" data-field="domains">
                <div class="tags">
                  <Tag
                    v-for="domain in DOMAINS"
                    :key="domain.value"
                    :label="domain.label"
                    :selected="draft.domains.includes(domain.value)"
                    :disabled="
                      locked ||
                      (!draft.domains.includes(domain.value) &&
                        draft.domains.length >= LIMITS.domains)
                    "
                    @click="toggleDomain(domain.value)"
                  />
                </div>
              </Field>
            </div>
            <Field
              label="简介"
              data-field="intro"
              :hint="hints.intro.text"
              :error="hints.intro.over ? hints.intro.text : undefined"
            >
              <TextField
                :model-value="draft.intro"
                placeholder="一句话：它做什么、怎么做"
                @update:model-value="change('identity', { intro: $event })"
              />
            </Field>
          </section>

          <!-- 2 职责与交付 -->
          <section v-if="!locked" class="section" data-section="mission">
            <h3 class="section-title">
              <span class="num">2</span> 职责与交付
              <small>负责什么、交出什么</small>
              <Badge
                v-if="drafted.has('mission')"
                data-ai-drafted
                tone="accent"
                label="AI 起草"
              />
              <span v-else-if="filled('mission')" class="ok">已填</span>
            </h3>
            <Field
              label="职责"
              data-field="mission"
              :hint="hints.mission.text"
              :error="hints.mission.over ? hints.mission.text : undefined"
            >
              <TextArea
                :model-value="draft.role.mission"
                :min-rows="2"
                :max-rows="10"
                :disabled="locked"
                placeholder="负责什么"
                @update:model-value="changeRole('mission', 'mission', $event)"
              />
            </Field>
            <Field
              label="交付"
              data-field="deliverable"
              :hint="hints.deliverable.text"
              :error="
                hints.deliverable.over ? hints.deliverable.text : undefined
              "
            >
              <TextArea
                :model-value="draft.role.deliverable"
                :min-rows="2"
                :max-rows="10"
                :disabled="locked"
                placeholder="交出什么、什么格式，越具体越好"
                @update:model-value="
                  changeRole('mission', 'deliverable', $event)
                "
              />
            </Field>
          </section>

          <!-- 3 工作方法 -->
          <section v-if="!locked" class="section" data-section="playbook">
            <h3 class="section-title">
              <span class="num">3</span> 工作方法
              <small>步骤与检查清单</small>
              <Badge
                v-if="drafted.has('playbook')"
                data-ai-drafted
                tone="accent"
                label="AI 起草"
              />
              <span v-else-if="filled('playbook')" class="ok">已填</span>
            </h3>
            <Field
              label="步骤与检查清单"
              data-field="playbook"
              :hint="`${hints.playbook.text} · 用 1. 2. 3. 写步骤`"
              :error="hints.playbook.over ? hints.playbook.text : undefined"
            >
              <TextArea
                :model-value="draft.role.playbook"
                :min-rows="5"
                :max-rows="16"
                :disabled="locked"
                placeholder="1. 先弄清……&#10;2. 再……"
                @update:model-value="changeRole('playbook', 'playbook', $event)"
              />
            </Field>
          </section>

          <!-- 4 知识 -->
          <section v-if="!locked" class="section" data-section="knowledge">
            <h3 class="section-title">
              <span class="num">4</span> 知识
              <small>只读参考资料，回答时注明出处</small>
              <span v-if="filled('knowledge')" class="ok"
                >{{ draft.knowledge.length }} 项</span
              >
            </h3>
            <div
              v-if="draft.knowledge.length"
              class="tags"
              data-field="knowledge"
            >
              <span
                v-for="(item, index) in draft.knowledge"
                :key="item.id"
                class="knowledge"
              >
                <Tag
                  :label="knowledgeLabel(item)"
                  :title="knowledgeTitle(item)"
                  removable
                  :disabled="locked"
                  @remove="removeKnowledge(index)"
                />
                <Tag
                  v-if="item.kind !== 'url'"
                  label="常驻上下文"
                  :selected="item.use === 'pinned'"
                  :disabled="locked"
                  :title="'常驻的资料合计不超过 8 KB，直接放进提示词'"
                  @click="togglePinned(index)"
                />
              </span>
            </div>
            <div class="row">
              <Button
                size="sm"
                variant="secondary"
                :disabled="locked"
                @click="addFile"
                >+ 文件</Button
              >
              <Button
                size="sm"
                variant="secondary"
                :disabled="locked"
                @click="addFolder"
                >+ 文件夹</Button
              >
              <TextField
                v-model="refInput"
                size="sm"
                class="ref-input"
                :disabled="locked"
                placeholder="https:// 网址"
                aria-label="网址"
                @keydown.enter="addTyped"
              />
              <Button
                size="sm"
                :disabled="locked || !refInput.trim()"
                @click="addTyped"
                >添加</Button
              >
            </div>
            <div class="note-row">
              <TextField
                v-model="noteTitle"
                size="sm"
                :disabled="locked"
                placeholder="笔记标题"
                aria-label="笔记标题"
              />
              <TextField
                v-model="noteText"
                size="sm"
                :disabled="locked"
                placeholder="笔记内容（≤4000 字）"
                aria-label="笔记内容"
              />
              <Button
                size="sm"
                :disabled="locked || !noteTitle.trim() || !noteText.trim()"
                @click="addNote"
                >+ 笔记</Button
              >
            </div>
            <p v-if="refError" class="error" role="alert">{{ refError }}</p>
            <label class="memory">
              <Switch
                :model-value="draft.memory.enabled"
                :disabled="locked"
                aria-label="个人记忆"
                @update:model-value="
                  change('knowledge', { memory: { enabled: $event } })
                "
              />
              <span
                >个人记忆：你对它的反馈（「这类不用报」「以后先报高危」）会记下来，只对这个联系人生效。</span
              >
            </label>
          </section>

          <!-- 5 边界 -->
          <section v-if="!locked" class="section" data-section="boundaries">
            <h3 class="section-title">
              <span class="num">5</span> 边界
              <small>不做什么、什么时候交还</small>
              <Badge
                v-if="drafted.has('boundaries')"
                data-ai-drafted
                tone="accent"
                label="AI 起草"
              />
              <span v-else-if="filled('boundaries')" class="ok">已填</span>
            </h3>
            <Field
              label="边界"
              data-field="boundaries"
              :hint="hints.boundaries.text"
              :error="hints.boundaries.over ? hints.boundaries.text : undefined"
            >
              <TextArea
                :model-value="draft.role.boundaries"
                :min-rows="2"
                :max-rows="10"
                :disabled="locked"
                placeholder="不做什么、什么时候交还、不确定时怎么标"
                @update:model-value="
                  changeRole('boundaries', 'boundaries', $event)
                "
              />
            </Field>
          </section>

          <!-- 6 能力 -->
          <section v-if="!locked" class="section" data-section="capabilities">
            <h3 class="section-title">
              <span class="num">6</span> 能力
              <small>模型、工具、权限；不能高于新会话的权限</small>
              <Badge
                v-if="drafted.has('capabilities')"
                data-ai-drafted
                tone="accent"
                label="AI 起草"
              />
            </h3>
            <p v-if="external || locked" class="note">
              {{
                external
                  ? '模型和权限跟随「设置 › 子智能体」。外部智能体暂不支持在 Emperor 里绑定 Skill 或 MCP。'
                  : '内置联系人用 Emperor 自己的模型、工具和权限。'
              }}
            </p>
            <template v-else>
              <div class="grid">
                <Field
                  label="模型"
                  :hint="
                    template
                      ? `建议：${MODEL_HINTS[template.modelHint] ?? ''}`
                      : undefined
                  "
                >
                  <Select
                    :model-value="modelValue"
                    :options="modelOptions"
                    block
                    @update:model-value="setModel(String($event))"
                  />
                </Field>
                <Field v-if="modelValue !== 'inherit'" label="推理强度">
                  <Select
                    :model-value="reasoningValue"
                    :options="reasoningOptions"
                    block
                    @update:model-value="setReasoning(String($event))"
                  />
                </Field>
              </div>
              <Field label="工具" hint="点工具可以单独加上或去掉">
                <div class="stack">
                  <Segmented
                    :model-value="draft.capabilities.tools.preset"
                    :options="PRESET_OPTIONS"
                    aria-label="工具预设"
                    @update:model-value="
                      choosePreset($event as ContactToolPreset)
                    "
                  />
                  <div class="tags" data-field="tools">
                    <Tag
                      v-for="chip in chips"
                      :key="chip.name"
                      :data-tool="chip.name"
                      :label="chip.label"
                      :selected="chip.on"
                      :title="chip.name"
                      @click="flipTool(chip.name)"
                    />
                  </div>
                </div>
              </Field>
              <Field
                label="工作技能 Skill"
                hint="只列当前安装里可用的 Skill；选中的 Skill 才会出现在它的工作里"
              >
                <div class="tags" data-field="skills">
                  <Tag
                    v-for="skill in skillChoices"
                    :key="skill.name"
                    :data-skill="skill.name"
                    :label="skill.name"
                    :selected="skillSelected(skill.name)"
                    :title="skill.description ?? skill.name"
                    @click="toggleSkill(skill.name)"
                  />
                </div>
                <p v-if="!skillChoices.length" class="hint">
                  安装里还没有可用的 Skill：在「能力 › Skills」里添加。
                </p>
              </Field>
              <Field
                label="外部连接 MCP"
                hint="一次选择整个服务当前的全部工具；以后新增的工具不会自动授权"
              >
                <div
                  v-for="server in mcpChoices"
                  :key="server.serverId"
                  class="mcp-server"
                  :data-mcp="server.serverId"
                >
                  <span class="mcp-name">
                    {{ server.serverId }}
                    <small>{{ server.state }}</small>
                  </span>
                  <div class="tags">
                    <Tag
                      :data-mcp-service="server.serverId"
                      :label="`整个服务 · ${server.tools.length} 个工具`"
                      :selected="mcpSelected(server.serverId)"
                      :disabled="server.state !== 'ready'"
                      @click="toggleMcp(server.serverId)"
                    />
                  </div>
                </div>
                <p v-if="!mcpChoices.length" class="hint">
                  还没有配置 MCP：在「能力 › MCP」里添加服务。
                </p>
              </Field>
              <Field label="权限" hint="不能高于「设置 › 常规」里新会话的权限">
                <Segmented
                  :model-value="draft.capabilities.permission"
                  :options="permissionOptions"
                  aria-label="权限"
                  @update:model-value="
                    setPermission(
                      $event as EditorDraft['capabilities']['permission'],
                    )
                  "
                />
              </Field>
            </template>
          </section>

          <!-- 7 群聊习惯 -->
          <section v-if="!locked" class="section" data-section="groupHabit">
            <h3 class="section-title">
              <span class="num">7</span> 群聊习惯
              <small>在群里什么时候开口</small>
              <Badge
                v-if="drafted.has('groupHabit')"
                data-ai-drafted
                tone="accent"
                label="AI 起草"
              />
            </h3>
            <div class="grid">
              <Field label="什么时候开口">
                <Segmented
                  :model-value="draft.groupHabit.speak"
                  :options="SPEAK_OPTIONS"
                  aria-label="什么时候开口"
                  @update:model-value="
                    !locked &&
                    change('groupHabit', {
                      groupHabit: {
                        ...draft.groupHabit,
                        speak: $event as EditorDraft['groupHabit']['speak'],
                      },
                    })
                  "
                />
              </Field>
              <Field label="发言篇幅">
                <Segmented
                  :model-value="draft.groupHabit.length"
                  :options="LENGTH_OPTIONS"
                  aria-label="发言篇幅"
                  @update:model-value="
                    !locked &&
                    change('groupHabit', {
                      groupHabit: {
                        ...draft.groupHabit,
                        length: $event as EditorDraft['groupHabit']['length'],
                      },
                    })
                  "
                />
              </Field>
            </div>
          </section>
        </div>
      </main>

      <aside class="side" aria-label="检查与试用">
        <CompletenessPanel v-if="!locked && !external" :items="checks" />
        <TrialBench
          :draft="input"
          :default-task="draft.role.trialTask ?? ''"
          :disabled="external || !!loadError"
          :disabled-reason="
            external ? 'Claude Code、Codex 的联系人还不能在试用台试用。' : ''
          "
          @ran="onRan"
          @update:task="setTrialTask"
        />
        <CompiledPromptPreview
          :prompt="preview?.prompt ?? ''"
          :chars="preview?.chars ?? 0"
          :version="draft.version ?? null"
          :loading="previewing"
          :error="previewError"
        />
      </aside>
    </div>
  </div>
</template>

<style scoped>
.contact-editor {
  container: contact-editor / inline-size;
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  height: 100%;
  background: rgb(var(--surface-base));
  color: rgb(var(--text-1));
}

.bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2-5);
  min-height: 50px;
  padding: var(--space-2-5) var(--space-5);
  box-shadow: inset 0 -0.5px 0 var(--hairline);
}

.titles {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--space-2-5);
  min-width: 0;
}

.title {
  margin: 0;
  overflow: hidden;
  color: rgb(var(--text-1));
  font-size: var(--fs-s);
  line-height: var(--lh-s);
  font-weight: var(--weight-semibold);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.muted {
  color: rgb(var(--text-3));
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
}

.actions {
  display: flex;
  gap: var(--space-2);
  margin-left: auto;
}

.body {
  display: grid;
  flex: 1;
  grid-template-columns: minmax(0, 1fr) 300px;
  min-height: 0;
}

.main {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  min-width: 0;
  min-height: 0;
  padding: var(--space-4) var(--space-6) var(--space-6);
  overflow-y: auto;
}

.side {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  min-width: 0;
  min-height: 0;
  padding: var(--space-3-5);
  overflow-y: auto;
  box-shadow: inset 0.5px 0 0 var(--hairline);
}

.start {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-3-5);
  border-radius: var(--r-md);
  background: rgb(var(--surface-raised));
  box-shadow: inset 0 0 0 0.5px var(--hairline);
}

.start-actions,
.row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}

.questions,
.notes {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin: 0;
  padding: 0;
  list-style: none;
}

.notes {
  gap: var(--space-1);
  color: rgb(var(--text-2));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
}

.sources,
.tags {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1-5);
}

.knowledge {
  display: inline-flex;
  gap: var(--space-1);
}

.ref-input {
  flex: 1;
  min-width: 180px;
}

.note-row {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  align-items: center;
  margin-top: var(--space-2);
}

.note-row > :nth-child(2) {
  flex: 1;
  min-width: 220px;
}

.mcp-server {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-1-5) 0;
  box-shadow: inset 0 -0.5px 0 var(--hairline);
}

.mcp-name {
  min-width: 120px;
  color: rgb(var(--text-1));
  font-size: var(--fs-xxs);
}

.mcp-name small {
  margin-left: var(--space-1);
  color: rgb(var(--text-3));
}

.note {
  margin: 0;
  color: rgb(var(--text-3));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
}

.error {
  margin: 0;
  color: rgb(var(--error));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
}

.form {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.section {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-3-5);
  border-radius: var(--r-md);
  background: rgb(var(--surface-raised));
  box-shadow: inset 0 0 0 0.5px var(--hairline);
}

.section-title {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--space-2);
  margin: 0;
  color: rgb(var(--text-1));
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  font-weight: var(--weight-semibold);
}

.section-title small {
  color: rgb(var(--text-3));
  font-size: var(--fs-xxs);
  font-weight: var(--weight-regular);
}

.section-title .ok,
.section-title :deep(.ds-badge) {
  margin-left: auto;
}

.section-title .ok {
  color: rgb(var(--ok));
  font-size: var(--fs-xxs);
  font-weight: var(--weight-regular);
}

.num {
  color: rgb(var(--text-3));
  font-variant-numeric: tabular-nums;
}

.grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-3);
}

.stack {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-width: 0;
}

.memory {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2-5);
  color: rgb(var(--text-3));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
}

@container contact-editor (max-width: 860px) {
  /* One column: the checks, the trial and the prompt under the form. */
  .body {
    display: block;
    overflow-y: auto;
  }

  .main,
  .side {
    overflow-y: visible;
  }

  .side {
    box-shadow: inset 0 0.5px 0 var(--hairline);
  }
}

@container contact-editor (max-width: 560px) {
  .main {
    padding: var(--space-3) var(--space-4) var(--space-5);
  }

  .grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
