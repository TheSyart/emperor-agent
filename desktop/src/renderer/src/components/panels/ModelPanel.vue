<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { cloneJson } from '../../api/http'
import { testModelEntry } from '../../api/model'
import type {
  ModelConfigPayload,
  ModelConfigRaw,
  ModelEntry,
  ModelTestResult,
  ProviderOption,
  ProviderRegion,
} from '../../types'
import { actionAssets, brandAssets } from '../../assets'
import ModelEntryList from './model/ModelEntryList.vue'
import ModelTestPanel from './model/ModelTestPanel.vue'

const props = defineProps<{ payload: ModelConfigPayload | null }>()
const emit = defineEmits<{
  save: [config: ModelConfigRaw]
  error: [message: string]
  refresh: []
}>()

// ────────────────────────────────────────────────────────────
// 状态：本地 entries 副本 + 当前编辑下标 + defaults
// ────────────────────────────────────────────────────────────

const entries = ref<ModelEntry[]>([])
const defaultName = ref<string>('')
const editingIndex = ref<number>(-1)
const defaults = reactive({
  maxTokens: 8192,
  temperature: 0.1,
  reasoningEffort: '' as string,
  contextWindowTokens: 128000,
})

const REGION_LABEL: Record<ProviderRegion, string> = {
  foreign: '海外大厂',
  aggregator: '聚合 / 转发',
  cloud: '云厂商',
  cn: '国内',
  local: '本地部署',
  other: 'OAuth / 其它',
}
const REGION_ORDER: ProviderRegion[] = ['foreign', 'aggregator', 'cloud', 'cn', 'local', 'other']

const options = computed<ProviderOption[]>(() => props.payload?.providerOptions || [])
const current = computed(() => props.payload?.current)

const groupedOptions = computed(() => {
  const groups = new Map<ProviderRegion, ProviderOption[]>()
  for (const opt of options.value) {
    const region = (opt.region || 'other') as ProviderRegion
    if (!groups.has(region)) groups.set(region, [])
    groups.get(region)!.push(opt)
  }
  return REGION_ORDER
    .filter(r => groups.has(r))
    .map(r => ({ region: r, label: REGION_LABEL[r], items: groups.get(r)! }))
})

const editing = computed<ModelEntry | null>(() =>
  editingIndex.value >= 0 ? entries.value[editingIndex.value] : null
)

const editingProviderSpec = computed<ProviderOption | undefined>(() =>
  editing.value ? options.value.find(o => o.name === editing.value!.provider) : undefined
)

const editingHidesApiKey = computed(() =>
  !!(editingProviderSpec.value?.isOauth || editingProviderSpec.value?.isLocal)
)

// ────────────────────────────────────────────────────────────
// 从 payload 同步进本地 state
// ────────────────────────────────────────────────────────────

function hydrate() {
  const config = props.payload?.config
  const incoming = (config?.models || []) as ModelEntry[]
  entries.value = incoming.map(cloneEntry)
  defaultName.value = String(config?.agents?.defaults?.model || '')
  defaults.maxTokens = Number(config?.agents?.defaults?.maxTokens ?? 8192)
  defaults.temperature = Number(config?.agents?.defaults?.temperature ?? 0.1)
  defaults.reasoningEffort = String(config?.agents?.defaults?.reasoningEffort || '')
  defaults.contextWindowTokens = Number(config?.agents?.defaults?.contextWindowTokens ?? 128000)

  // 旧 schema 兼容：models[] 空但后端合成了一个临时 entry，UI 把它预填给用户。
  // 用户保存后真正写入 models[]，完成 schema 升级。
  if (entries.value.length === 0 && current.value?.entryName) {
    const synth: ModelEntry = {
      name: current.value.entryName,
      id: current.value.mainModelId || current.value.model || current.value.entryName,
      mainModelId: current.value.mainModelId || current.value.model || current.value.entryName,
      secondaryModelId: current.value.secondaryModelId || '',
      provider: current.value.provider || 'custom',
      apiKey: '',  // 后端脱敏过；让用户主动重填
      apiBase: current.value.apiBase || null,
      label: current.value.entryLabel || '',
    }
    entries.value.push(synth)
    defaultName.value = synth.name
  }

  // 默认编辑当前激活 entry
  const activeName = current.value?.entryName || defaultName.value
  const idx = entries.value.findIndex(e => e.name === activeName)
  editingIndex.value = idx >= 0 ? idx : (entries.value.length ? 0 : -1)
}

watch(() => props.payload, hydrate, { immediate: true, deep: true })

function cloneEntry(e: ModelEntry): ModelEntry {
  const mainModelId = e.mainModelId || e.id || ''
  return {
    name: e.name || '',
    id: mainModelId,
    mainModelId,
    secondaryModelId: e.secondaryModelId || '',
    provider: e.provider || 'custom',
    apiKey: e.apiKey ?? '',
    apiBase: e.apiBase ?? null,
    extraHeaders: e.extraHeaders ?? null,
    extraBody: e.extraBody ?? null,
    maxTokens: e.maxTokens ?? null,
    temperature: e.temperature ?? null,
    contextWindowTokens: e.contextWindowTokens ?? null,
    reasoningEffort: e.reasoningEffort ?? null,
    label: e.label || '',
    supportsVision: !!e.supportsVision,
  }
}

// ────────────────────────────────────────────────────────────
// 操作
// ────────────────────────────────────────────────────────────

function uniqueName(base: string): string {
  if (!entries.value.some(e => e.name === base)) return base
  for (let i = 2; i < 999; i++) {
    const candidate = `${base}-${i}`
    if (!entries.value.some(e => e.name === candidate)) return candidate
  }
  return `${base}-${Date.now()}`
}

function addEntry() {
  const provider = 'deepseek'
  const id = ''
  const baseName = `${provider}-${id || 'new'}`
  const newEntry: ModelEntry = {
    name: uniqueName(baseName),
    id: '',
    mainModelId: '',
    secondaryModelId: '',
    provider,
    apiKey: '',
    apiBase: null,
    label: '',
  }
  entries.value.push(newEntry)
  editingIndex.value = entries.value.length - 1
  if (!defaultName.value) defaultName.value = newEntry.name
}

function removeEntry(idx: number) {
  if (idx < 0 || idx >= entries.value.length) return
  const removed = entries.value[idx]
  if (removed.name === defaultName.value && entries.value.length > 1) {
    emit('error', '不能删除当前激活的条目，请先把"激活"切到别的条目再删。')
    return
  }
  entries.value.splice(idx, 1)
  if (entries.value.length === 0) {
    defaultName.value = ''
    editingIndex.value = -1
  } else {
    if (defaultName.value === removed.name) defaultName.value = entries.value[0].name
    editingIndex.value = Math.min(idx, entries.value.length - 1)
  }
}

function setActive(idx: number) {
  if (idx < 0 || idx >= entries.value.length) return
  defaultName.value = entries.value[idx].name
}

function pickEditing(idx: number) {
  editingIndex.value = idx
}

function onProviderChange() {
  const e = editing.value
  if (!e) return
  const spec = options.value.find(o => o.name === e.provider)
  if (!spec) return
  // apiBase: 若用户从未自定义（null），用 spec 默认；已经是字符串就不动
  if (e.apiBase === null || e.apiBase === '' || e.apiBase === undefined) {
    e.apiBase = null  // null 表示用 spec 默认
  }
  // OAuth/local 一律不需要 apiKey
  if (spec.isOauth || spec.isLocal) {
    e.apiKey = ''
  }
}

function onNameChange(newName: string) {
  const e = editing.value
  if (!e) return
  // 重名校验：本地立即提示，但不阻断输入
  const dup = entries.value.some((x, i) => i !== editingIndex.value && x.name === newName)
  if (dup) emit('error', `名称 "${newName}" 已被其它条目占用，保存前请改名。`)
  // 如果当前 entry 是默认条目，跟着改名
  if (defaultName.value === e.name) defaultName.value = newName
  e.name = newName
}

function parseOptionalJsonField(raw: string | null | undefined, label: string): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'string') return null
  const text = raw.trim()
  if (!text) return null
  try {
    const parsed = JSON.parse(text) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`${label} 必须是 JSON 对象`)
    }
    return parsed as Record<string, unknown>
  } catch (err) {
    throw new Error(`${label}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

function normaliseExtra(value: unknown): Record<string, unknown> | null {
  // 已经是对象（来自 watch 同步过的 editing.extra*）→ 原样保留
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  // null / undefined / 空字符串 / "null" 字面值 → 视为未配置
  return null
}

function entryToWire(e: ModelEntry): ModelEntry {
  const mainModelId = (e.mainModelId || e.id || '').trim()
  return {
    name: e.name.trim(),
    id: mainModelId,
    mainModelId,
    secondaryModelId: (e.secondaryModelId || '').trim(),
    provider: e.provider,
    apiKey: e.apiKey ?? '',
    apiBase: e.apiBase || null,
    extraHeaders: normaliseExtra(e.extraHeaders),
    extraBody: normaliseExtra(e.extraBody),
    maxTokens: e.maxTokens || null,
    temperature: e.temperature ?? null,
    contextWindowTokens: e.contextWindowTokens || null,
    reasoningEffort: e.reasoningEffort || null,
    label: e.label?.trim() || '',
    supportsVision: !!e.supportsVision,
  }
}

function save() {
  try {
    if (entries.value.length === 0) {
      emit('error', '请至少添加一个模型条目')
      return
    }
    // 最终校验当前编辑条目里 textarea 的 JSON 文本（watch 静默吞错时兜底）
    if (editing.value) {
      editing.value.extraHeaders = parseOptionalJsonField(extraHeadersText.value, 'Extra Headers')
      editing.value.extraBody = parseOptionalJsonField(extraBodyText.value, 'Extra Body')
    }
    const names = new Set<string>()
    for (const e of entries.value) {
      const n = e.name.trim()
      if (!n) throw new Error('条目名称不能为空')
      if (names.has(n)) throw new Error(`条目名 "${n}" 重复`)
      names.add(n)
      if (!(e.mainModelId || e.id)?.trim()) throw new Error(`条目 "${n}" 的 Main Model ID 不能为空`)
      if (!e.secondaryModelId?.trim()) throw new Error(`条目 "${n}" 的 Secondary Model ID 不能为空`)
      if (!e.provider) throw new Error(`条目 "${n}" 必须选择 provider`)
    }
    if (!names.has(defaultName.value)) {
      defaultName.value = entries.value[0].name
    }

    const config = cloneJson<ModelConfigRaw>(props.payload?.config || {})
    config.agents ||= {}
    config.agents.defaults ||= {}
    config.agents.defaults.model = defaultName.value
    config.agents.defaults.provider = 'auto'  // entry 自带 provider，defaults 不需要锁
    config.agents.defaults.maxTokens = defaults.maxTokens
    config.agents.defaults.temperature = defaults.temperature
    config.agents.defaults.reasoningEffort = defaults.reasoningEffort || null
    config.agents.defaults.contextWindowTokens = defaults.contextWindowTokens
    config.models = entries.value.map(entryToWire)

    emit('save', config)
  } catch (err) {
    emit('error', err instanceof Error ? err.message : String(err))
  }
}

// ────────────────────────────────────────────────────────────
// 高级 JSON 字段（编辑时序列化为字符串方便用户改）
// ────────────────────────────────────────────────────────────

const extraHeadersText = ref('')
const extraBodyText = ref('')

watch(editing, (e) => {
  extraHeadersText.value = e?.extraHeaders ? JSON.stringify(e.extraHeaders, null, 2) : ''
  extraBodyText.value = e?.extraBody ? JSON.stringify(e.extraBody, null, 2) : ''
}, { immediate: true, deep: true })

watch(extraHeadersText, (text) => {
  if (!editing.value) return
  if (!text.trim()) { editing.value.extraHeaders = null; return }
  try {
    const parsed = JSON.parse(text)
    editing.value.extraHeaders = (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
      ? parsed : null
  } catch { /* 容忍错误，保存时再校验 */ }
})

watch(extraBodyText, (text) => {
  if (!editing.value) return
  if (!text.trim()) { editing.value.extraBody = null; return }
  try {
    const parsed = JSON.parse(text)
    editing.value.extraBody = (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
      ? parsed : null
  } catch { /* same as above */ }
})

// ────────────────────────────────────────────────────────────
// dirty 判断：本地状态 vs 服务端 payload 是否有差异
// ────────────────────────────────────────────────────────────

const dirtySignature = computed(() => JSON.stringify({
  entries: entries.value.map(e => ({
    name: e.name, id: e.id, mainModelId: e.mainModelId, secondaryModelId: e.secondaryModelId, provider: e.provider,
    apiKey: e.apiKey || '', apiBase: e.apiBase || null,
    extraHeaders: e.extraHeaders || null, extraBody: e.extraBody || null,
    maxTokens: e.maxTokens ?? null, temperature: e.temperature ?? null,
    contextWindowTokens: e.contextWindowTokens ?? null,
    reasoningEffort: e.reasoningEffort ?? null,
    label: e.label || '',
    supportsVision: !!e.supportsVision,
  })),
  default: defaultName.value,
  defaults: { ...defaults },
}))

const serverSignature = ref('')

watch(() => props.payload, () => {
  // 用 hydrate 后的状态作为基准
  // 用 setTimeout 0 保证 hydrate 已经跑完
  setTimeout(() => { serverSignature.value = dirtySignature.value }, 0)
}, { immediate: true, deep: true })

const hasChanges = computed(() => serverSignature.value !== '' && serverSignature.value !== dirtySignature.value)

// ────────────────────────────────────────────────────────────
// 连通测试 + 视觉徽章
// ────────────────────────────────────────────────────────────

const testing = reactive({ mainText: false, secondaryText: false, vision: false })
const lastResult = ref<ModelTestResult | null>(null)

async function runTest(kind: 'text' | 'vision', role: 'main' | 'secondary' = 'main') {
  if (!editing.value?.name) return
  if (hasChanges.value) {
    emit('error', '请先保存配置再测试')
    return
  }
  const key: 'mainText' | 'secondaryText' | 'vision' =
    kind === 'vision' ? 'vision' : (role === 'secondary' ? 'secondaryText' : 'mainText')
  testing[key] = true
  lastResult.value = null
  try {
    const result = await testModelEntry(editing.value.name, kind, role)
    lastResult.value = result
    if (!result.ok && result.error) {
      // 失败也展示在 chip 上，不再重复 toast
    }
    // 视觉测试通过 → 后端已写入 supportsVision，刷新让 entry 列表立刻点亮。
    if (result.ok && kind === 'vision' && result.visionMarked) {
      emit('refresh')
    }
  } catch (err) {
    lastResult.value = {
      ok: false,
      kind,
      error: err instanceof Error ? err.message : String(err),
    }
  } finally {
    testing[key] = false
  }
}

</script>

<template>
  <div class="panel-content model-panel-shell">
    <div v-if="!props.payload" class="empty-state illustrated-empty seal-empty">
      <img :src="brandAssets.logoMark" alt="" />
      <span>暂无模型配置。</span>
    </div>

    <div v-else-if="entries.length === 0" class="empty-state illustrated-empty">
      <img :src="brandAssets.logoMark" alt="" />
      <span>暂无模型条目。点击下方「+ 添加模型条目」开始配置第一条。</span>
    </div>

    <div v-else class="entry-layout">
      <ModelEntryList
        :entries="entries"
        :default-name="defaultName"
        :editing-index="editingIndex"
        @add="addEntry"
        @pick="pickEditing"
        @set-active="setActive"
      />

      <!-- 右：编辑器 -->
      <section v-if="editing" class="entry-editor">
        <div class="entry-editor-head">
          <div class="entry-editor-title">
            <h3>编辑 · {{ editing.label || editing.name }}</h3>
            <span v-if="editing.name === defaultName" class="entry-active-inline">✓ 当前激活</span>
          </div>
          <div class="flex shrink-0 items-center gap-2">
            <button
              v-if="editing.name !== defaultName"
              class="tool-button ink"
              title="把此条目切为激活（保存后真正生效）"
              @click="setActive(editingIndex)"
            >设为激活</button>
            <button class="tool-button danger" @click="removeEntry(editingIndex)">删除条目</button>
          </div>
        </div>

        <div class="model-form-v2">
          <label class="form-row">
            <span class="form-label">名称（唯一 key）</span>
            <input
              :value="editing.name"
              class="form-input"
              placeholder="deepseek-personal"
              @input="onNameChange(($event.target as HTMLInputElement).value)"
            />
          </label>
          <label class="form-row">
            <span class="form-label">显示标签（可选）</span>
            <input v-model="editing.label" class="form-input" placeholder="DeepSeek 个人 key" />
          </label>

          <label class="form-row">
            <span class="form-label">Provider</span>
            <select v-model="editing.provider" class="form-select" @change="onProviderChange">
              <optgroup v-for="group in groupedOptions" :key="group.region" :label="group.label">
                <option v-for="opt in group.items" :key="opt.name" :value="opt.name">
                  {{ opt.displayName || opt.name }}
                </option>
              </optgroup>
            </select>
          </label>

          <label class="form-row">
            <span class="form-label">Main Model ID</span>
            <input
              :value="editing.mainModelId || editing.id || ''"
              class="form-input"
              placeholder="例：deepseek-chat / claude-opus-4-7 / gpt-5"
              @input="editing.mainModelId = ($event.target as HTMLInputElement).value; editing.id = editing.mainModelId"
            />
          </label>
          <label class="form-row">
            <span class="form-label">Secondary Model ID</span>
            <input
              v-model="editing.secondaryModelId"
              class="form-input"
              placeholder="例：deepseek-chat / gpt-5-mini / qwen-plus"
            />
          </label>

          <label v-if="!editingHidesApiKey" class="form-row">
            <span class="form-label">API Key</span>
            <input
              v-model="editing.apiKey"
              class="form-input"
              type="password"
              :placeholder="editingProviderSpec?.isLocal ? '(本地服务通常不需要)' : '保存为明文，仅本地，不回传明文'"
            />
          </label>
          <div v-else class="empty-note compact">
            <span v-if="editingProviderSpec?.isOauth">该 provider 走 OAuth 授权流程，无需 API Key。</span>
            <span v-else-if="editingProviderSpec?.isLocal">本地服务通常不需要 API Key（除非你单独开了认证）。</span>
          </div>

          <details class="advanced-panel">
            <summary class="advanced-toggle">
              <span>▸ 高级（apiBase / 推理 / 上下文 / extras）</span>
              <small>未填则用 provider 默认 / 全局兜底</small>
            </summary>
            <div class="advanced-grid">
              <label class="form-row">
                <span class="form-label">API Base</span>
                <input
                  :value="editing.apiBase ?? ''"
                  class="form-input"
                  :placeholder="editingProviderSpec?.defaultApiBase || '由 SDK 决定'"
                  @input="editing.apiBase = ($event.target as HTMLInputElement).value || null"
                />
              </label>
              <label class="form-row">
                <span class="form-label">Max Tokens（覆写）</span>
                <input
                  type="number" min="0" step="100"
                  :value="editing.maxTokens ?? ''"
                  class="form-input"
                  :placeholder="String(defaults.maxTokens)"
                  @input="editing.maxTokens = parseInt(($event.target as HTMLInputElement).value) || null"
                />
              </label>
              <label class="form-row">
                <span class="form-label">Temperature（覆写）</span>
                <input
                  type="number" min="0" max="2" step="0.05"
                  :value="editing.temperature ?? ''"
                  class="form-input"
                  :placeholder="String(defaults.temperature)"
                  @input="editing.temperature = parseFloat(($event.target as HTMLInputElement).value) || null"
                />
              </label>
              <label class="form-row">
                <span class="form-label">Context Window（覆写）</span>
                <input
                  type="number" min="1000" step="1000"
                  :value="editing.contextWindowTokens ?? ''"
                  class="form-input"
                  :placeholder="String(defaults.contextWindowTokens)"
                  @input="editing.contextWindowTokens = parseInt(($event.target as HTMLInputElement).value) || null"
                />
              </label>
              <label class="form-row">
                <span class="form-label">Reasoning Effort</span>
                <select
                  :value="editing.reasoningEffort ?? ''"
                  class="form-select"
                  @change="editing.reasoningEffort = ($event.target as HTMLSelectElement).value || null"
                >
                  <option value="">默认（继承全局）</option>
                  <option value="none">none</option>
                  <option value="low">low</option>
                  <option value="medium">medium</option>
                  <option value="high">high</option>
                  <option value="xhigh">xhigh</option>
                </select>
              </label>
              <label class="form-row span-2">
                <span class="form-label">Extra Headers JSON</span>
                <textarea v-model="extraHeadersText" rows="3" placeholder='{"X-Custom": "value"}' />
              </label>
              <label class="form-row span-2">
                <span class="form-label">Extra Body JSON</span>
                <textarea v-model="extraBodyText" rows="3" placeholder='{"enable_thinking": false}' />
              </label>
            </div>
          </details>

          <ModelTestPanel
            :editing="editing"
            :has-changes="hasChanges"
            :testing="testing"
            :last-result="lastResult"
            @run-test="runTest"
          />
        </div>
      </section>
    </div>

    <div class="empty-note">
      <img class="note-mark" :src="brandAssets.logoMark" alt="" width="28" height="28" />
      一个条目共享同一套 provider / apiKey / apiBase，并必须配置 Main 与 Secondary 两个 Model ID。所有 apiKey 仅保存在本地 model_config.json，前端展示时已脱敏。
    </div>

    <!-- 底部 sticky 操作栏 -->
    <div class="model-action-bar" :class="{ dirty: hasChanges }">
      <div class="action-bar-status">
        <template v-if="current?.entryName">
          <span class="status-pill">
            <span class="dot" />
            服务端激活: {{ current.entryLabel || current.entryName }}
          </span>
          <span v-if="current.provider && current.model" class="mini-code">
            {{ current.provider }} / {{ current.model }}
            <template v-if="current.secondaryModelId"> / secondary {{ current.secondaryModelId }}</template>
          </span>
        </template>
        <span v-if="hasChanges" class="dirty-badge">● 有未保存的更改</span>
        <span v-else-if="entries.length" class="saved-badge">✓ 已与服务端同步</span>
      </div>
      <button
        class="tool-button ink asset-button primary-action save-action"
        :disabled="!hasChanges && entries.length > 0"
        :title="hasChanges ? '保存并切换到激活条目' : '当前已与服务端同步'"
        @click="save"
      >
        <img class="action-icon" :src="actionAssets.save" alt="" width="18" height="18" />
        <span>{{ hasChanges ? '保存配置' : '已保存' }}</span>
      </button>
    </div>
  </div>
</template>
