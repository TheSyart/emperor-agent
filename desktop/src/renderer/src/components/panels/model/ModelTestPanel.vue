<script setup lang="ts">
import type { ModelEntry, ModelTestResult } from '../../../types'
import { modelIcons } from '../../../icons'

defineProps<{
  editing: ModelEntry
  hasChanges: boolean
  testing: { mainText: boolean; secondaryText: boolean; vision: boolean }
  lastResult: ModelTestResult | null
}>()

const emit = defineEmits<{
  runTest: [kind: 'text' | 'vision', role: 'main' | 'secondary']
}>()

function truncate(value: string | undefined, limit: number): string {
  if (!value) return ''
  return value.length > limit ? `${value.slice(0, limit)}…` : value
}
</script>

<template>
  <div class="test-row">
    <div class="test-label">
      <span>连通测试</span>
      <small class="hint">
        用一次最小请求验证 entry 是否能跑；视觉测试通过会自动给本条目打视觉标记
      </small>
    </div>
    <div class="test-actions">
      <button
        type="button"
        class="tool-button model-test-button"
        :disabled="hasChanges || testing.mainText"
        :title="hasChanges ? '请先保存配置再测试' : '发一次 ping（约消耗几十 token）'"
        @click="emit('runTest', 'text', 'main')"
      >
        <component :is="modelIcons.text" class="model-test-icon" :size="16" />
        <span v-if="testing.mainText">…测试中</span>
        <span v-else>测试主模型</span>
      </button>
      <button
        type="button"
        class="tool-button model-test-button"
        :disabled="hasChanges || testing.secondaryText || !editing.secondaryModelId"
        :title="!editing.secondaryModelId ? '请先填写 Secondary Model ID' : hasChanges ? '请先保存配置再测试' : '发一次 ping 验证次模型'"
        @click="emit('runTest', 'text', 'secondary')"
      >
        <component :is="modelIcons.text" class="model-test-icon" :size="16" />
        <span v-if="testing.secondaryText">…测试中</span>
        <span v-else>测试次模型</span>
      </button>
      <button
        type="button"
        class="tool-button model-test-button"
        :disabled="hasChanges || testing.vision"
        :title="hasChanges
          ? '请先保存配置再测试'
          : '发一张红色测试图（约几十 token）；通过即标视觉能力'"
        @click="emit('runTest', 'vision', 'main')"
      >
        <component :is="modelIcons.vision" class="model-test-icon" :size="16" />
        <span v-if="testing.vision">…测试中</span>
        <span v-else>测试视觉</span>
      </button>
    </div>
    <div
      v-if="lastResult"
      class="test-result"
      :class="{ ok: lastResult.ok, fail: !lastResult.ok }"
    >
      <template v-if="lastResult.ok">
        <span class="badge with-icon">
          <component :is="modelIcons.testOk" :size="14" />
          {{ lastResult.kind === 'vision' ? '视觉通' : '文本通' }}
        </span>
        <span class="meta">
          {{ lastResult.latencyMs }}ms · {{ lastResult.modelRole || 'main' }} · {{ lastResult.model }}
        </span>
        <code class="sample">{{ lastResult.sample }}</code>
        <span
          v-if="lastResult.kind === 'vision' && lastResult.visionMarked"
          class="meta jade"
        >已自动写入视觉标记</span>
      </template>
      <template v-else>
        <span class="badge with-icon">
          <component :is="modelIcons.testFail" :size="14" />
          失败
        </span>
        <span class="meta" :title="lastResult.error">
          {{ truncate(lastResult.error, 100) }}
        </span>
        <code v-if="lastResult.sample" class="sample">{{ lastResult.sample }}</code>
      </template>
    </div>
  </div>
</template>
