<script setup lang="ts">
/**
 * Step 1 of the add-model dialog (MOD-04): find the provider by name or a
 * pasted address (国内 / 海外 / 本地 / 其他; local servers show whether
 * they run), enter the key (or keep the saved one), adjust the protocol and
 * address under 高级, then 连接并获取模型 probes the connection and reads
 * its model list. Errors say what to do and offer the fix.
 */
import { computed, ref } from 'vue'
import { openExternal } from '../../../api/backend'
import Avatar from '../../ui/Avatar.vue'
import Button from '../../ui/Button.vue'
import Checkbox from '../../ui/Checkbox.vue'
import Field from '../../ui/Field.vue'
import LinkButton from '../../ui/LinkButton.vue'
import Notice from '../../ui/Notice.vue'
import SearchField from '../../ui/SearchField.vue'
import Segmented from '../../ui/Segmented.vue'
import TextField from '../../ui/TextField.vue'
import { useAddModel } from './addModelController'

const add = useAddModel()
const advanced = ref(false)

const needsKey = computed(() => !add.isLocal)
const canConnect = computed(
  () =>
    Boolean(add.connection.provider) &&
    Boolean(add.connection.apiBase.trim()) &&
    (!needsKey.value ||
      add.connection.useSavedKey ||
      Boolean(add.connection.apiKey.trim())),
)
const showAddress = computed(
  () => advanced.value || add.connection.provider === 'custom',
)
const listUrl = computed(
  () => `${add.connection.apiBase.replace(/\/+$/, '')}/models`,
)
const keyError = computed(() => (add.error?.kind === 'key' ? add.error : null))
const otherError = computed(() =>
  add.error && add.error.kind !== 'key' ? add.error : null,
)

function localLabel(name: string): string {
  const status = add.local[name]
  if (!status) return ''
  if (!status.running) return '未运行'
  return status.count === null ? '运行中' : `运行中 · ${status.count} 个模型`
}

function protocolLabel(value: string): string {
  return value === 'anthropic' ? 'Anthropic 协议' : 'OpenAI 兼容'
}
</script>

<template>
  <section class="connect" data-step="connect">
    <SearchField
      :model-value="add.query"
      placeholder="搜索供应商或粘贴 API 地址"
      @update:model-value="add.setQuery"
    />

    <div v-if="!add.connection.provider" class="providers">
      <div v-for="group in add.groups" :key="group.key" class="group">
        <h3 class="group-label">{{ group.label }}</h3>
        <div class="tiles">
          <button
            v-for="item in group.options"
            :key="item.name"
            type="button"
            class="tile"
            :data-provider="item.name"
            @click="add.pickProvider(item.name)"
          >
            <Avatar
              kind="logo"
              :icon-id="item.iconId ?? null"
              :label="item.displayName ?? item.name"
              :size="24"
            />
            <span class="tile-text">
              <span class="tile-name">{{ item.displayName ?? item.name }}</span>
              <span v-if="item.isLocal" class="tile-meta">{{
                localLabel(item.name)
              }}</span>
            </span>
          </button>
        </div>
      </div>
    </div>

    <div v-else class="form">
      <div class="chosen" :data-provider="add.connection.provider">
        <Avatar
          kind="logo"
          :icon-id="add.option?.iconId ?? null"
          :label="add.option?.displayName ?? add.connection.provider"
          :size="28"
        />
        <span class="chosen-name">{{
          add.option?.displayName ?? add.connection.provider
        }}</span>
        <span v-if="add.isLocal" class="chosen-meta">{{
          localLabel(add.connection.provider)
        }}</span>
        <LinkButton @click="add.connection.provider = null">换一个</LinkButton>
      </div>

      <template v-if="needsKey">
        <Checkbox
          v-if="add.savedKey"
          v-model="add.connection.useSavedKey"
          :label="`沿用已保存的 Key（···${add.savedKey.tail}）`"
        />
        <Field
          v-if="!add.connection.useSavedKey"
          label="API Key"
          :error="keyError?.message"
        >
          <TextField
            v-model="add.connection.apiKey"
            type="password"
            autocomplete="off"
            aria-label="API Key"
          />
          <template #hint>
            <LinkButton
              v-if="add.option?.apiKeyUrl"
              @click="openExternal(add.option.apiKeyUrl)"
              >获取 Key ↗</LinkButton
            >
          </template>
        </Field>
        <p v-if="add.keyHint" class="key-hint" role="status">
          {{ add.keyHint.label }}
          <LinkButton @click="add.pickProvider(add.keyHint.provider)"
            >切换</LinkButton
          >
        </p>
        <Notice
          v-if="keyError && add.connection.useSavedKey"
          tone="error"
          :title="keyError.message"
        />
      </template>

      <Field v-if="add.protocols.length > 1" label="协议">
        <Segmented
          :model-value="add.connection.protocol"
          :options="
            add.protocols.map((value) => ({
              value,
              label: protocolLabel(value),
            }))
          "
          aria-label="协议"
          @update:model-value="(value) => value && add.setProtocol(value)"
        />
      </Field>

      <LinkButton
        v-if="add.connection.provider !== 'custom'"
        class="advanced-toggle"
        :aria-expanded="advanced"
        @click="advanced = !advanced"
        >{{ advanced ? '收起高级' : '高级' }}</LinkButton
      >
      <Field
        v-if="showAddress"
        label="API 地址"
        :hint="`将请求 GET ${listUrl}`"
      >
        <TextField
          v-model="add.connection.apiBase"
          monospace
          aria-label="API 地址"
        />
      </Field>

      <Notice
        v-if="otherError"
        :tone="otherError.kind === 'rate' ? 'warn' : 'error'"
        :title="otherError.message"
      >
        <template #actions>
          <Button
            v-if="otherError.fixApiBase || otherError.fixProvider"
            size="sm"
            variant="secondary"
            @click="add.applyFix()"
            >改为 {{ otherError.fixApiBase ?? otherError.fixProvider }}</Button
          >
          <Button v-else size="sm" variant="secondary" @click="add.connect()"
            >重试</Button
          >
        </template>
      </Notice>
      <Notice
        v-if="keyError?.fixApiBase"
        tone="info"
        :title="`这个 Key 可以在 ${keyError.fixApiBase} 使用`"
      >
        <template #actions>
          <Button size="sm" variant="secondary" @click="add.applyFix()"
            >改为 {{ keyError.fixApiBase }}</Button
          >
        </template>
      </Notice>
      <p v-if="add.note" class="note" role="status">{{ add.note }}</p>

      <div class="actions">
        <Button
          variant="primary"
          :loading="add.connecting"
          :disabled="!canConnect"
          @click="add.connect()"
          >连接并获取模型</Button
        >
      </div>
    </div>
  </section>
</template>

<style scoped>
.connect {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.providers {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  max-height: 420px;
  overflow-y: auto;
}

.group {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.group-label {
  margin: 0;
  font-size: var(--fs-xs);
  font-weight: var(--weight-medium);
  color: rgb(var(--text-3));
}

.tiles {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: var(--space-2);
}

.tile {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  height: var(--control-lg);
  padding: 0 var(--space-3);
  border: none;
  border-radius: var(--r-sm);
  background: var(--surface-hover);
  color: rgb(var(--text-1));
  text-align: left;
  cursor: pointer;
}

.tile:hover {
  background: var(--surface-hover-strong);
}

.tile:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px rgb(var(--focus-ring) / 0.55);
}

.tile-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.tile-name {
  overflow: hidden;
  font-size: var(--fs-xs);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tile-meta,
.chosen-meta {
  font-size: var(--fs-xxs);
  color: rgb(var(--text-3));
}

.form {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.chosen {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.chosen-name {
  font-weight: var(--weight-medium);
}

.key-hint,
.note {
  margin: 0;
  font-size: var(--fs-xs);
  color: rgb(var(--text-2));
}

.advanced-toggle {
  align-self: flex-start;
}

.actions {
  display: flex;
  justify-content: flex-end;
}
</style>
