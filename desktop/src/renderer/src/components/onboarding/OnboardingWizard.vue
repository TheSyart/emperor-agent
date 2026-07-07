<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import type { BootstrapPayload, ProviderOption } from '../../types'
import { actionIcons, brandIcon } from '../../icons'
import {
  createOnboardingDraft,
  hasExistingCredential,
  onboardingValidationErrors,
  wizardSettingsFromDraft,
  type WizardModelSettings,
} from './onboardingModel'

const props = defineProps<{
  payload: BootstrapPayload | null
  open: boolean
  save: (settings: WizardModelSettings) => Promise<void>
}>()

const emit = defineEmits<{
  close: []
}>()

const visible = computed(() => props.open && Boolean(props.payload))
const draft = reactive(createOnboardingDraft(props.payload))
const saving = ref(false)
const error = ref('')

const providerOptions = computed(() => props.payload?.modelConfig?.providerOptions || [])
const providerSpec = computed<ProviderOption | undefined>(() =>
  providerOptions.value.find((option) => option.name === draft.provider),
)
const keyOptional = computed(() =>
  Boolean(providerSpec.value?.isLocal || providerSpec.value?.isOauth || hasExistingCredential(props.payload, draft.provider)),
)
const existingKeyLabel = computed(() =>
  hasExistingCredential(props.payload, draft.provider) ? '已保存，将保留' : '',
)
const errors = computed(() => onboardingValidationErrors(draft, props.payload))

watch(() => props.payload, () => {
  if (!props.open) return
  Object.assign(draft, createOnboardingDraft(props.payload))
  error.value = ''
}, { deep: true })

watch(() => props.open, (open) => {
  if (!open) {
    error.value = ''
    return
  }
  Object.assign(draft, createOnboardingDraft(props.payload))
  error.value = ''
})

function onProviderChange() {
  const spec = providerSpec.value
  if (!spec) return
  draft.apiBase = spec.defaultApiBase || ''
  if (spec.isLocal || spec.isOauth) draft.apiKey = ''
}

async function submit() {
  error.value = ''
  const validation = errors.value
  if (validation.length) {
    error.value = validation.join('；')
    return
  }
  saving.value = true
  try {
    await props.save(wizardSettingsFromDraft(draft, props.payload))
    emit('close')
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div v-if="visible" class="onboarding-backdrop" role="presentation">
    <form class="onboarding-shell" role="dialog" aria-modal="true" aria-labelledby="onboarding-title" @submit.prevent="submit">
      <header class="onboarding-head">
        <div class="onboarding-brand">
          <component :is="brandIcon" :size="22" :stroke-width="1.8" />
        </div>
        <div>
          <h2 id="onboarding-title">配置模型</h2>
          <p>model_config.json</p>
        </div>
      </header>

      <div class="onboarding-grid">
        <label class="form-row">
          <span class="form-label">Provider</span>
          <select v-model="draft.provider" class="form-select" @change="onProviderChange">
            <option v-for="option in providerOptions" :key="option.name" :value="option.name">
              {{ option.displayName || option.name }}
            </option>
          </select>
        </label>

        <label class="form-row">
          <span class="form-label">Entry Name</span>
          <input v-model="draft.name" class="form-input" autocomplete="off" />
        </label>

        <label class="form-row">
          <span class="form-label">Display Label</span>
          <input v-model="draft.label" class="form-input" autocomplete="off" placeholder="可选" />
        </label>

        <label class="form-row">
          <span class="form-label">API Base</span>
          <input v-model="draft.apiBase" class="form-input" autocomplete="off" :placeholder="providerSpec?.defaultApiBase || ''" />
        </label>

        <label v-if="!providerSpec?.isLocal && !providerSpec?.isOauth" class="form-row span-2">
          <span class="form-label">API Key <small v-if="existingKeyLabel">{{ existingKeyLabel }}</small></span>
          <input v-model="draft.apiKey" class="form-input" type="password" autocomplete="off" :placeholder="keyOptional ? '留空保留现有值' : 'sk-...'" />
        </label>

        <div v-else class="onboarding-note span-2">
          当前 provider 不需要在这里填写 API Key。
        </div>

        <label class="form-row">
          <span class="form-label">Main Model ID</span>
          <input v-model="draft.mainModelId" class="form-input" autocomplete="off" />
        </label>

        <label class="form-row">
          <span class="form-label">Secondary Model ID</span>
          <input v-model="draft.secondaryModelId" class="form-input" autocomplete="off" />
        </label>

        <label class="form-row">
          <span class="form-label">Max Tokens</span>
          <input v-model.number="draft.maxTokens" class="form-input" type="number" min="1" step="100" />
        </label>

        <label class="form-row">
          <span class="form-label">Context Window</span>
          <input v-model.number="draft.contextWindowTokens" class="form-input" type="number" min="1000" step="1000" />
        </label>

        <label class="form-row">
          <span class="form-label">Temperature</span>
          <input v-model.number="draft.temperature" class="form-input" type="number" min="0" max="2" step="0.05" />
        </label>

        <label class="form-row">
          <span class="form-label">Reasoning Effort</span>
          <select v-model="draft.reasoningEffort" class="form-select">
            <option value="">provider default</option>
            <option value="minimal">minimal</option>
            <option value="low">low</option>
            <option value="medium">medium</option>
            <option value="high">high</option>
            <option value="xhigh">xhigh</option>
          </select>
        </label>
      </div>

      <div v-if="error" class="onboarding-error">{{ error }}</div>

      <footer class="onboarding-actions">
        <span>{{ errors.length ? errors[0] : '配置会保存到全局私有数据目录的 model_config.json' }}</span>
        <button class="tool-button" type="button" :disabled="saving" @click="emit('close')">
          稍后配置
        </button>
        <button class="tool-button ink asset-button primary-action" type="submit" :disabled="saving || errors.length > 0">
          <component :is="saving ? actionIcons.statusBusy : actionIcons.save" class="action-icon" :class="{ spin: saving }" :size="16" />
          <span>{{ saving ? '保存中' : '保存配置' }}</span>
        </button>
      </footer>
    </form>
  </div>
</template>
