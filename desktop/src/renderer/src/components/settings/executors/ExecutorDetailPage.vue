<script setup lang="ts">
/**
 * 设置 › 子智能体 › Claude Code / Codex (AGT-10): everything the main page
 * leaves out, in plain words — the status and its fix (for a missing
 * claude, the official install command), Claude's sign-in (AGT-12: its own
 * login in macOS Terminal, the Console sign-in, 退出登录, 使用 API Key and
 * what outranks the login), the default model and custom models, what it
 * is good at, and what Core verified about it (「联网搜索：已验证」).
 * Saved at once; the text editors save on 保存 / 完成.
 */
import { computed, ref } from 'vue'
import type { ExecutorProfile } from '@emperor/core/runtime-contract'
import { executorSpecialties } from '@emperor/core/runtime-contract'
import { openExternal } from '../../../api/backend'
import Button from '../../ui/Button.vue'
import LinkButton from '../../ui/LinkButton.vue'
import { writeClipboard } from '../../ui/useCopyFeedback'
import { DsRefresh } from '../../icons/ds'
import {
  Badge,
  DefinitionList,
  Notice,
  Select,
  SettingsGroup,
  SettingsRow,
  SettingsSection,
  TextField,
} from '../ui'
import {
  authIssue,
  capabilityLines,
  CLAUDE_INSTALL_COMMAND,
  claudeMissing,
  compatibilityWarning,
  consentText,
  executorName,
  hasEmperorKey,
  hasIssue,
  precedenceText,
  signedInWithClaude,
  signInText,
  signsInHere,
  statusDetail,
  statusLabel,
  statusTone,
  versionText,
} from './executorText'
import { ADD_CUSTOM_MODEL, useExecutorSettings } from './useExecutorSettings'

const props = defineProps<{ backend: 'claude-code' | 'codex' }>()

const s = useExecutorSettings()
const { busy, tokenBusy, catalogs, catalogBusy, runtimes, signInPending } = s
const name = computed(() => executorName(props.backend))
const row = computed(() => s.rowOf(props.backend))
const profile = computed(() => row.value.profile)
const facts = computed(() => (profile.value ? s.factsOf(profile.value) : {}))

// ── 状态 ─────────────────────────────────────────────────────────────

const pathEditing = ref(false)
const pathText = ref('')
function editPath() {
  pathEditing.value = !pathEditing.value
  pathText.value = profile.value?.executablePath ?? ''
}
function savePath(target: ExecutorProfile) {
  const path = pathText.value.trim()
  if (!path) return
  pathEditing.value = false
  void s.changeProfile(target.id, (p) => {
    p.executablePath = path
  })
}
const copied = ref(false)
async function copyInstall() {
  copied.value = await writeClipboard(CLAUDE_INSTALL_COMMAND)
}
async function installHelp(target: ExecutorProfile) {
  try {
    await openExternal(
      target.backend === 'codex'
        ? 'https://learn.chatgpt.com/docs/codex/cli'
        : 'https://code.claude.com/docs/en/setup',
    )
  } catch {
    s.error.value = '无法打开安装说明，请检查系统浏览器后重试。'
  }
}

// ── 默认模型 ──────────────────────────────────────────────────────────

const addingModel = ref(false)
const modelText = ref('')
function selectModel(target: ExecutorProfile, id: string | null | undefined) {
  if (id === ADD_CUSTOM_MODEL) {
    addingModel.value = true
    modelText.value = ''
    return
  }
  addingModel.value = false
  void s.changeProfile(target.id, (p) => {
    if (id) p.defaultModel = id
    else delete p.defaultModel
  })
}
function modelError(target: ExecutorProfile): string {
  const text = modelText.value.trim()
  if (!text) return '请输入模型 ID'
  if (text.length > 256) return '模型 ID 最多 256 字'
  if (
    [...text].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) ||
    text === ADD_CUSTOM_MODEL
  )
    return '模型 ID 无效'
  if (
    (target.customModels?.length ?? 0) >= 64 &&
    !target.customModels?.includes(text)
  )
    return '最多保存 64 个自定义模型'
  return ''
}
function addModel(target: ExecutorProfile) {
  if (modelError(target)) return
  const id = modelText.value.trim()
  addingModel.value = false
  void s.changeProfile(target.id, (p) => {
    p.customModels = [...new Set([...(p.customModels ?? []), id])]
    p.defaultModel = id
  })
}

// ── 擅长的任务 ────────────────────────────────────────────────────────

const editingSpecialties = ref(false)
const specialtyText = ref('')
const specialtyError = computed(() => {
  const items = splitSpecialties(specialtyText.value)
  if (items.length > 6) return '最多 6 项专长'
  if (items.some((item) => [...item].length > 24)) return '每项最多 24 字'
  return ''
})
function splitSpecialties(text: string): string[] {
  return text
    .split(/[,，、;；\n]/)
    .map((item) => item.trim())
    .filter(Boolean)
}
function editSpecialties(target: ExecutorProfile) {
  editingSpecialties.value = !editingSpecialties.value
  specialtyText.value = executorSpecialties(target).join('，')
}
function saveSpecialties(target: ExecutorProfile) {
  if (specialtyError.value) return
  const items = splitSpecialties(specialtyText.value)
  editingSpecialties.value = false
  void s.changeProfile(target.id, (p) => {
    p.specialties = items
  })
}
function resetSpecialties(target: ExecutorProfile) {
  editingSpecialties.value = false
  void s.changeProfile(target.id, (p) => {
    delete p.specialties
  })
}

// ── 能力与运行信息 ─────────────────────────────────────────────────────

const runFacts = computed(() => {
  const target = profile.value
  if (!target) return []
  const runtime = runtimes.value[target.id]
  const catalog = catalogs.value[target.id]
  const list = (items?: readonly string[] | null) =>
    items && items.length ? items.join('、') : undefined
  return [
    { key: 'version', term: '版本', value: versionText(target, facts.value) },
    {
      key: 'configured',
      term: '使用的模型',
      value:
        target.defaultModel ??
        catalog?.configuredModel ??
        runtime?.configuredModel ??
        '跟随本机 CLI',
    },
    {
      key: 'reported',
      term: '最近一次运行',
      value: runtime?.reportedModel ?? '还没有运行过',
    },
    {
      key: 'source',
      term: '模型从哪来',
      value: runtime?.modelSource
        ? runtime.modelSource +
          (runtime.provider ? ` · ${runtime.provider}` : '')
        : '还没有运行报告',
    },
    { key: 'provider', term: '提供方', value: catalog?.provider ?? '未知' },
    {
      key: 'catalog',
      term: '模型列表',
      value: catalog?.checkedAt
        ? `${new Date(catalog.checkedAt).toLocaleString()} 更新 · 列出的模型不代表账号都能用`
        : '还没有获取',
    },
    {
      key: 'allowed',
      term: '允许的工具',
      value: list(runtime?.hostAllowedTools) ?? '未知',
    },
    {
      key: 'advertised',
      term: '它报告的工具',
      value: list(runtime?.advertisedTools) ?? '未知',
    },
    {
      key: 'observed',
      term: '用过的工具',
      value: list(runtime?.observedTools) ?? '还没有用过',
    },
  ]
})
</script>

<template>
  <SettingsSection :data-executor-detail="backend">
    <p v-if="!profile" class="detail-note" role="status">
      没有 {{ name }} 的配置。
    </p>
    <template v-else>
      <Notice
        v-if="s.error.value"
        tone="error"
        :title="s.error.value"
        data-executor-error
      />
      <SettingsGroup title="状态">
        <SettingsRow :title="name">
          <template #badge
            ><Badge class="readiness" :tone="statusTone(profile, facts)">{{
              statusLabel(profile, facts)
            }}</Badge></template
          >
          <template #description
            ><span v-if="claudeMissing(profile, facts)"
              >没有找到 claude。Emperor 运行你自己安装的 Claude
              Code，在终端运行下面的命令安装，装好后点「重新检测」。</span
            ><span v-else-if="hasIssue(facts) && !authIssue(profile, facts)">{{
              statusDetail(profile, facts)
            }}</span
            ><span v-else data-executor-consent>{{
              consentText(facts)
            }}</span></template
          >
          <div class="inline-actions">
            <Button
              v-if="facts.probe?.status === 'missing'"
              size="sm"
              variant="ghost"
              data-executor-install-help
              @click="installHelp(profile)"
              >安装说明</Button
            >
            <Button
              size="sm"
              variant="ghost"
              data-executor-recovery
              @click="editPath"
              >更正路径</Button
            >
          </div>
        </SettingsRow>
        <SettingsRow
          v-if="claudeMissing(profile, facts)"
          title="安装命令"
          layout="stacked"
          data-claude-install
        >
          <div class="editor">
            <code class="command" data-claude-install-command>{{
              CLAUDE_INSTALL_COMMAND
            }}</code>
            <Button
              size="sm"
              variant="secondary"
              data-claude-install-copy
              @click="copyInstall"
              >{{ copied ? '已复制' : '复制命令' }}</Button
            >
          </div>
        </SettingsRow>
        <SettingsRow
          v-if="compatibilityWarning(profile, facts)"
          :description="compatibilityWarning(profile, facts)"
          data-executor-warning
        />
        <SettingsRow v-if="pathEditing" title="可执行文件路径" layout="stacked">
          <div class="editor">
            <TextField
              v-model="pathText"
              :aria-label="`${name} 可执行文件路径`"
              :disabled="busy"
              monospace
              autocomplete="off"
              @keydown.enter.prevent="savePath(profile)"
            />
            <Button
              size="sm"
              variant="secondary"
              data-executor-path-save
              :disabled="busy || !pathText.trim()"
              @click="savePath(profile)"
              >保存</Button
            >
          </div>
        </SettingsRow>
        <SettingsRow v-if="row.profiles.length > 1" title="使用的配置">
          <Select
            :model-value="profile.id"
            :options="row.profiles.map((p) => ({ value: p.id, label: p.id }))"
            size="sm"
            data-executor-profile
            :aria-label="`${name} 配置`"
            :disabled="busy"
            @update:model-value="
              (id) => {
                if (id) s.selected.value[backend] = id
              }
            "
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup
        v-if="signsInHere(profile)"
        title="登录"
        data-claude-sign-in
      >
        <SettingsRow title="Claude Code 的登录">
          <template #description
            ><span data-claude-auth-state>{{
              signInText(facts)
            }}</span></template
          >
          <div class="inline-actions">
            <Button
              v-if="signedInWithClaude(facts)"
              size="sm"
              variant="ghost"
              data-claude-sign-out
              :disabled="busy || tokenBusy"
              @click="s.signOut(profile)"
              >退出登录</Button
            ><Button
              size="sm"
              :variant="signedInWithClaude(facts) ? 'ghost' : 'secondary'"
              data-claude-sign-in-start
              :disabled="busy || tokenBusy || claudeMissing(profile, facts)"
              @click="s.signIn(profile)"
              >{{
                signedInWithClaude(facts) ? '重新登录' : '登录 Claude Code'
              }}</Button
            >
          </div>
        </SettingsRow>
        <Notice
          v-if="signInPending[profile.id]"
          tone="info"
          title="已在「终端」里打开登录"
          data-claude-sign-in-pending
        >
          按「终端」里的提示在浏览器里完成登录，回到 Emperor 后会自动重新检测。
          <template #actions>
            <Button
              size="sm"
              variant="secondary"
              :disabled="busy"
              @click="s.recheck(profile)"
              >重新检测</Button
            >
          </template>
        </Notice>
        <Notice
          v-if="precedenceText(facts)"
          tone="info"
          :title="precedenceText(facts)"
          data-claude-precedence
        />
        <SettingsRow
          title="API Key"
          description="也可以用你在 Anthropic Console 创建的 API Key，按用量计费；它优先于上面的登录。"
        >
          <div class="inline-actions">
            <Button
              v-if="hasEmperorKey(facts)"
              size="sm"
              variant="ghost"
              data-claude-api-key-clear
              :disabled="busy || tokenBusy"
              @click="s.clearKey(profile)"
              >移除</Button
            ><Button
              size="sm"
              variant="ghost"
              data-claude-api-key-set
              :disabled="busy || tokenBusy"
              @click="s.apiKeyDialog.value = profile"
              >{{
                hasEmperorKey(facts) ? '更换 API Key' : '使用 API Key'
              }}</Button
            >
          </div>
        </SettingsRow>
        <SettingsRow layout="stacked">
          <p class="sign-in-help" data-claude-sign-in-help>
            「登录 Claude Code」会打开 macOS 的「终端」，按 Claude Code
            自己的流程在浏览器里登录一次。登录由 Claude Code 保存在 Emperor
            为它准备的专用目录里；Emperor 不读取、不保存你的 Claude 登录。
          </p>
          <p class="sign-in-help">
            用 Anthropic Console 账号？<LinkButton
              data-claude-sign-in-console
              :disabled="busy || tokenBusy || claudeMissing(profile, facts)"
              @click="s.signIn(profile, 'console')"
              >用 Console 账号登录（按用量计费）</LinkButton
            >，同样在「终端」里完成。
          </p>
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="默认模型">
        <template #actions
          ><Button
            size="sm"
            variant="ghost"
            data-refresh-models
            :aria-label="`刷新 ${name} 模型`"
            :disabled="catalogBusy[profile.id] || busy"
            @click="s.loadModels(profile, true)"
            ><DsRefresh :size="12" />{{
              catalogBusy[profile.id] ? '获取中…' : '刷新模型'
            }}</Button
          ></template
        >
        <SettingsRow
          title="模型"
          description="沿用它自己的连接与认证；更换后，下次把任务交给它时生效。"
        >
          <Select
            :model-value="profile.defaultModel ?? ''"
            :options="s.modelOptionsOf(profile, true)"
            :aria-label="`${name} 默认模型`"
            size="sm"
            data-default-model
            :disabled="busy"
            @update:model-value="selectModel(profile, $event)"
          />
        </SettingsRow>
        <SettingsRow v-if="addingModel" title="自定义模型 ID" layout="stacked">
          <div class="editor">
            <TextField
              v-model="modelText"
              data-custom-model-input
              :aria-label="`${name} 自定义模型 ID`"
              :disabled="busy"
              placeholder="提供方的模型 ID，如 team/coder-v2"
              autocomplete="off"
              monospace
              @keydown.enter.prevent="addModel(profile)"
              @keydown.esc="addingModel = false"
            />
            <Button size="sm" variant="ghost" @click="addingModel = false"
              >取消</Button
            ><Button
              size="sm"
              variant="secondary"
              data-add-custom-model
              :disabled="busy || !!modelError(profile)"
              @click="addModel(profile)"
              >添加</Button
            >
          </div>
          <p
            :class="
              modelText && modelError(profile) ? 'field-error' : 'field-hint'
            "
          >
            {{
              modelText && modelError(profile)
                ? modelError(profile)
                : '添加后会保存下来，以后可以直接选。'
            }}
          </p>
        </SettingsRow>
        <SettingsRow
          v-if="catalogs[profile.id]?.diagnostic"
          :description="catalogs[profile.id]?.diagnostic ?? ''"
        />
      </SettingsGroup>

      <SettingsGroup title="擅长的任务">
        <template #actions
          ><Button
            v-if="editingSpecialties"
            size="sm"
            variant="ghost"
            data-reset-specialties
            :disabled="busy"
            @click="resetSpecialties(profile)"
            >恢复默认</Button
          ><Button
            size="sm"
            variant="ghost"
            data-edit-specialties
            :disabled="busy"
            @click="editSpecialties(profile)"
            >{{ editingSpecialties ? '收起编辑' : '编辑专长' }}</Button
          ></template
        >
        <SettingsRow
          description="供主会话分配任务时参考，可以清空；不会启用额外工具。"
          layout="stacked"
        >
          <div class="specialty-tags" data-specialties>
            <Badge
              v-for="(text, i) in executorSpecialties(profile)"
              :key="i"
              class="specialty-tag"
              >{{ text }}</Badge
            ><span v-if="!executorSpecialties(profile).length" class="muted"
              >未设置专长</span
            >
          </div>
          <div v-if="editingSpecialties" class="editor">
            <TextField
              v-model="specialtyText"
              data-specialty-input
              :aria-label="`${name} 专长`"
              :invalid="!!specialtyError"
              :disabled="busy"
              placeholder="逗号分隔，最多 6 项，每项 24 字"
              @keydown.enter.prevent="saveSpecialties(profile)"
            />
            <Button
              size="sm"
              variant="secondary"
              data-specialty-save
              :disabled="busy || !!specialtyError"
              @click="saveSpecialties(profile)"
              >完成</Button
            >
          </div>
          <p
            v-if="editingSpecialties && specialtyError"
            class="field-error"
            role="alert"
          >
            {{ specialtyError }}
          </p>
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="能力与运行">
        <SettingsRow
          v-for="line in capabilityLines(profile, facts)"
          :key="line.kind"
          :data-native-capability="line.kind"
          :data-status="line.status"
          :description="line.text"
        />
        <SettingsRow layout="stacked">
          <DefinitionList :items="runFacts" :label-width="96">
            <template #value="{ item }"
              ><span
                :data-run-fact="item.key"
                :data-reported-model="item.key === 'reported' || undefined"
                >{{ item.value }}</span
              ></template
            >
          </DefinitionList>
        </SettingsRow>
      </SettingsGroup>
    </template>
  </SettingsSection>
</template>

<style scoped>
.detail-note,
.muted {
  margin: 0;
  font-size: var(--fs-xs);
  color: rgb(var(--text-3));
}
.inline-actions,
.editor {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.editor > :first-child {
  flex: 1;
  min-width: 0;
}
.command {
  overflow-x: auto;
  padding: var(--space-1) var(--space-2);
  border-radius: var(--r-xs);
  background: rgb(var(--surface-sunken));
  color: rgb(var(--text-1));
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  white-space: nowrap;
}
.sign-in-help {
  margin: 0;
  font-size: var(--fs-xs);
  color: rgb(var(--text-3));
}
.specialty-tags {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1-5);
}
.field-hint,
.field-error {
  margin: 0;
  font-size: var(--fs-xxs);
  color: rgb(var(--text-3));
}
.field-error {
  color: rgb(var(--state-error-label));
}
.readiness {
  font-size: var(--fs-xxxs);
}
</style>
