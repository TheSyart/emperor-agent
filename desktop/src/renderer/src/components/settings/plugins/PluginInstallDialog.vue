<script setup lang="ts">
/**
 * PluginInstallDialog — the Plugin install dialog of Settings › 插件 on
 * ui/Modal. Driven entirely by a PluginInstallFlow (pluginInstall.ts):
 * - step 'url': the https address field, the signature-verification notice
 *   and 「检查」 (`plugins.inspect`);
 * - step 'preview': what will be installed — source, version, digest,
 *   signature, size, capabilities — plus the install scope, then
 *   「确认安装」 (`plugins.install`). A local source opens here directly and
 *   shows its inspection progress / failure until the preview arrives.
 *
 * Escape closes this dialog only (ui/Modal's modal stack), not the settings
 * modal underneath.
 */
import { computed } from 'vue'
import Button from '../../ui/Button.vue'
import Modal from '../../ui/Modal.vue'
import {
  DefinitionList,
  EmptyState,
  Field,
  Select,
  StatusBadge,
  TextField,
  type DefinitionItem,
} from '../ui'
import {
  capabilityChips,
  formatBytes,
  PLUGIN_SCOPE_OPTIONS,
  shortDigest,
  signatureLabel,
  sourceLabel,
  URL_SIGNATURE_NOTICE,
  type PluginInstallFlow,
} from './pluginInstall'

const props = defineProps<{ flow: PluginInstallFlow }>()

const state = computed(() => props.flow.state)
const preview = computed(() => props.flow.state.preview)

const title = computed(() => {
  if (state.value.step === 'url') return '从 URL 安装 Plugin'
  return preview.value ? `安装「${preview.value.name}」` : '检查 Plugin'
})

const facts = computed<DefinitionItem[]>(() => {
  const current = preview.value
  if (!current) return []
  return [
    { term: 'Plugin ID', value: current.pluginId, mono: true },
    { term: '版本', value: current.version, mono: true },
    { term: '来源', value: sourceLabel(current.source) },
    { term: '签名', value: signatureLabel(current.signature.status) },
    { term: 'Digest', value: shortDigest(current.digest), mono: true },
    {
      term: '内容',
      value: `${current.fileCount} 个文件 · ${formatBytes(current.totalBytes)}`,
    },
  ]
})

const chips = computed(() =>
  preview.value ? capabilityChips(preview.value.capabilities) : [],
)
const unverified = computed(
  () => preview.value?.signature.status === 'unverified',
)

const scope = computed({
  get: () => props.flow.state.scope,
  set: (value) => props.flow.setScope(value),
})

const url = computed({
  get: () => props.flow.state.url,
  set: (value: string) => props.flow.setUrl(value),
})
</script>

<template>
  <Modal
    :open="flow.open.value"
    :title="title"
    :description="preview?.description || undefined"
    :width="460"
    @update:open="(value: boolean) => !value && flow.close()"
  >
    <div class="install-body" data-testid="plugin-install-dialog">
      <template v-if="state.step === 'url'">
        <Field
          label="Plugin 压缩包地址"
          hint="https:// 开头的 .zip 地址"
          :error="state.error || undefined"
        >
          <TextField
            v-model="url"
            type="url"
            monospace
            autocomplete="off"
            spellcheck="false"
            placeholder="https://example.com/plugin.zip"
            data-testid="plugin-source"
            @keydown.enter="flow.inspectUrl()"
          />
        </Field>
        <p class="notice" data-tone="warn">{{ URL_SIGNATURE_NOTICE }}</p>
      </template>

      <template v-else-if="!preview">
        <EmptyState
          v-if="state.busy"
          title="正在检查 Plugin…"
          description="读取清单并计算内容摘要。"
          variant="plain"
          compact
        />
        <p v-else-if="state.error" class="error" role="alert">
          {{ state.error }}
        </p>
      </template>

      <template v-else>
        <DefinitionList :items="facts" />
        <div v-if="chips.length" class="chips" aria-label="包含的能力">
          <StatusBadge v-for="chip in chips" :key="chip" mono>
            {{ chip }}
          </StatusBadge>
        </div>
        <Field label="安装范围">
          <Select v-model="scope" :options="PLUGIN_SCOPE_OPTIONS" block />
        </Field>
        <p v-if="unverified" class="notice" data-tone="warn">
          签名未验证：安装后不会激活。{{
            preview.source.kind === 'url'
              ? '信任该来源时，请下载后用本地安装。'
              : ''
          }}
        </p>
        <p v-if="state.error" class="error" role="alert">{{ state.error }}</p>
      </template>
    </div>

    <template #footer>
      <template v-if="state.step === 'url'">
        <Button variant="outline" size="sm" @click="flow.close()">取消</Button>
        <Button
          variant="primary"
          size="sm"
          data-testid="inspect-plugin"
          :disabled="state.busy || !state.url.trim()"
          @click="flow.inspectUrl()"
        >
          {{ state.busy ? '检查中…' : '检查' }}
        </Button>
      </template>
      <template v-else-if="!preview">
        <Button variant="outline" size="sm" @click="flow.close()">
          {{ state.busy ? '取消' : '关闭' }}
        </Button>
      </template>
      <template v-else>
        <Button variant="outline" size="sm" @click="flow.close()">取消</Button>
        <Button
          variant="primary"
          size="sm"
          data-testid="confirm-plugin-install"
          :disabled="state.busy"
          @click="flow.confirm()"
        >
          {{ state.busy ? '安装中…' : '确认安装' }}
        </Button>
      </template>
    </template>
  </Modal>
</template>

<style scoped>
.install-body {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  min-width: 0;
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1-5);
}

.notice {
  margin: 0;
  padding: var(--space-2-5) var(--space-3);
  border-radius: var(--radius-row);
  background: rgb(var(--state-warn-soft));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  color: rgb(var(--state-warn-label));
  overflow-wrap: anywhere;
}

.error {
  margin: 0;
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  color: rgb(var(--state-error-label));
  overflow-wrap: anywhere;
}
</style>
