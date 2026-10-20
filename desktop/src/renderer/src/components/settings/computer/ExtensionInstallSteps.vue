<script setup lang="ts">
/**
 * ExtensionInstallSteps — 设置 › 电脑操作 › Chrome 和 Edge › 安装扩展: the
 * four steps of loading the extension, each ticked once it is done and the
 * first open one marked:
 * 1. the folder Emperor fills (`~/.emperor/browser-extension`): 在访达中显示,
 *    拷贝路径;
 * 2. the extensions page (Chrome will not open it for another app, so the
 *    address is copied and pasted) and its 开发者模式;
 * 3. 加载已解压的扩展程序, or the folder dragged onto the page (⌘⇧G pastes
 *    the path in the folder dialog);
 * 4. the extension's own onboarding page: 允许访问网站, then 允许 here.
 *
 * Props: steps (chromeEdgeModel.installSteps), folder, addresses,
 * switchedOff (loaded but off), pending (a pairing code waits below),
 * copied (key of the item just copied), busy.
 * Emits: reveal, copy (text, key).
 */
import { computed } from 'vue'
import Button from '../../ui/Button.vue'
import { DsCheck, DsCopy, DsFolderOpen } from '../../icons/ds'
import { SettingsGroup, SettingsRow } from '../ui'
import type { ExtensionAddress, InstallStep, StepKey } from './chromeEdgeModel'

const props = defineProps<{
  steps: readonly InstallStep[]
  folder: { path: string; displayPath: string; ready: boolean }
  addresses: readonly ExtensionAddress[]
  switchedOff: boolean
  pending: boolean
  copied: string | null
  busy: boolean
}>()
const emit = defineEmits<{ reveal: []; copy: [text: string, key: string] }>()

const state = computed(
  () =>
    Object.fromEntries(
      props.steps.map((step) => [step.key, step.state]),
    ) as Record<StepKey, InstallStep['state']>,
)
const ORDER: StepKey[] = ['folder', 'developer', 'load', 'connect']
const STATE_WORDS = { done: '已完成', now: '当前步骤', todo: '未开始' }

function marker(key: StepKey): string {
  return `第 ${ORDER.indexOf(key) + 1} 步，${STATE_WORDS[state.value[key]]}`
}

const SHORT = { chrome: 'Chrome', edge: 'Edge' } as const
function copyLabel(address: ExtensionAddress): string {
  if (props.copied === address.url) return '已拷贝'
  return props.addresses.length > 1
    ? `拷贝 ${SHORT[address.browser]} 地址`
    : '拷贝地址'
}
</script>

<template>
  <SettingsGroup
    title="安装扩展"
    description="约 1 分钟；Chrome 和 Edge 用同一个扩展"
    data-testid="chrome-install-steps"
  >
    <SettingsRow data-step="folder" :data-state="state.folder">
      <template #leading>
        <span
          class="marker"
          :data-state="state.folder"
          role="img"
          :aria-label="marker('folder')"
          ><DsCheck v-if="state.folder === 'done'" :size="13" /><template v-else
            >1</template
          ></span
        >
      </template>
      <template #title>{{
        folder.ready ? '扩展已准备好' : '把扩展放进文件夹'
      }}</template>
      <template #description>
        {{
          folder.ready
            ? '每次升级 Emperor 会自动更新这个文件夹'
            : '点右上角「安装扩展程序」，Emperor 会把扩展放进这个文件夹'
        }}
        <code class="path">{{ folder.displayPath }}</code>
      </template>
      <Button
        size="sm"
        variant="secondary"
        :disabled="busy || !folder.ready"
        data-action="reveal-extension"
        @click="emit('reveal')"
      >
        <template #icon><DsFolderOpen :size="14" /></template>
        在访达中显示
      </Button>
      <Button
        size="sm"
        variant="secondary"
        :disabled="!folder.ready"
        data-action="copy-extension-path"
        @click="emit('copy', folder.path, 'path')"
      >
        <template #icon><DsCopy :size="14" /></template>
        {{ copied === 'path' ? '已拷贝' : '拷贝路径' }}
      </Button>
    </SettingsRow>

    <SettingsRow data-step="developer" :data-state="state.developer">
      <template #leading>
        <span
          class="marker"
          :data-state="state.developer"
          role="img"
          :aria-label="marker('developer')"
          ><DsCheck v-if="state.developer === 'done'" :size="13" /><template
            v-else
            >2</template
          ></span
        >
      </template>
      <template #title>打开扩展页，开启「开发者模式」</template>
      <template #description>
        在 Chrome 或 Edge 的地址栏粘贴扩展页地址，打开右上角的「开发者模式」
        <span class="paths">
          <code v-for="address in addresses" :key="address.url" class="path">{{
            address.url
          }}</code>
        </span>
      </template>
      <Button
        v-for="address in addresses"
        :key="address.url"
        size="sm"
        variant="secondary"
        :data-action="`copy-${address.browser}-address`"
        @click="emit('copy', address.url, address.url)"
      >
        <template #icon><DsCopy :size="14" /></template>
        {{ copyLabel(address) }}
      </Button>
    </SettingsRow>

    <SettingsRow data-step="load" :data-state="state.load">
      <template #leading>
        <span
          class="marker"
          :data-state="state.load"
          role="img"
          :aria-label="marker('load')"
          ><DsCheck v-if="state.load === 'done'" :size="13" /><template v-else
            >3</template
          ></span
        >
      </template>
      <template #title>加载扩展</template>
      <template #description>
        点「加载已解压的扩展程序」，选择上面的文件夹；也可以把文件夹直接拖进扩展页。选择框里按
        ⌘⇧G 可以粘贴路径。
        <template v-if="switchedOff"
          >扩展已停用：在扩展页打开它的开关。</template
        >
      </template>
    </SettingsRow>

    <SettingsRow data-step="connect" :data-state="state.connect">
      <template #leading>
        <span
          class="marker"
          :data-state="state.connect"
          role="img"
          :aria-label="marker('connect')"
          ><DsCheck v-if="state.connect === 'done'" :size="13" /><template
            v-else
            >4</template
          ></span
        >
      </template>
      <template #title>允许访问网站，完成配对</template>
      <template #description>
        {{
          pending
            ? '验证码与浏览器引导页上的一致时，在下面的「连接」里点「允许」'
            : '扩展装好后会自动打开引导页：点「允许访问网站」，再回到这里点「允许」'
        }}
      </template>
    </SettingsRow>
  </SettingsGroup>
</template>

<style scoped>
.marker {
  display: grid;
  place-items: center;
  width: var(--space-6);
  height: var(--space-6);
  border-radius: var(--radius-pill);
  font-size: var(--fs-xxs);
  font-weight: var(--weight-semibold);
  line-height: 1;
}

.marker[data-state='done'] {
  background: rgb(var(--state-ok-soft));
  color: rgb(var(--state-ok-label));
}

.marker[data-state='now'] {
  border: 1.5px solid rgb(var(--accent));
  background: rgb(var(--accent-soft));
  color: rgb(var(--text-link));
}

.marker[data-state='todo'] {
  border: 1px solid var(--stroke-3);
  color: rgb(var(--text-3));
}

.paths {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1-5);
}

.path {
  display: block;
  width: fit-content;
  max-width: 100%;
  margin-top: var(--space-1-5);
  padding: var(--space-0-5) var(--space-2);
  border: 1px solid var(--stroke-1);
  border-radius: var(--r-sm);
  background: rgb(var(--settings-card-control-fill));
  color: rgb(var(--text-2));
  font-family: var(--font-mono);
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  overflow-wrap: anywhere;
}
</style>
