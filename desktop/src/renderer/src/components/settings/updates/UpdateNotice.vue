<script setup lang="ts">
/**
 * UpdateNotice — the top of 设置 › 常规 while there is something to do about
 * an update (REL-02); nothing otherwise:
 * - a newer release: 「Emperor 0.2.1 可用」 · 查看更新说明 · 下载;
 * - downloading: a progress bar, 已下载 x / y MB, 取消;
 * - verifying: which check is running (SHA-256, then the attestation);
 * - verified: what the check covered, the three install steps and
 *   在访达中显示 (Emperor never opens or installs the DMG);
 * - failed: why (a SHA-256 mismatch says the file was deleted), 重新下载.
 */
import { computed } from 'vue'
import type { UpdateDownloadState } from '@emperor/core/runtime-contract'
import Button from '../../ui/Button.vue'
import Notice from '../../ui/Notice.vue'
import {
  UPDATE_INSTALL_STEPS,
  attestationText,
  downloadFraction,
  downloadProgressText,
} from './updateModel'
import { useUpdateStatus } from './useUpdateStatus'

const updates = useUpdateStatus()
const status = updates.status
const busy = updates.busy

const release = computed(() =>
  status.value?.enabled ? status.value.available : null,
)
const download = computed<UpdateDownloadState>(
  () => status.value?.download ?? { phase: 'idle' },
)
const fraction = computed(() => downloadFraction(download.value))
const progressText = computed(() => downloadProgressText(download.value))
const version = computed(() =>
  download.value.phase === 'idle'
    ? (release.value?.version ?? '')
    : download.value.version,
)
const visible = computed(
  () => download.value.phase !== 'idle' || Boolean(release.value),
)
</script>

<template>
  <div v-if="visible" class="update-notice" data-update-notice>
    <Notice
      v-if="download.phase === 'downloading' || download.phase === 'verifying'"
      tone="info"
      :title="
        download.phase === 'downloading'
          ? `正在下载 Emperor ${version}`
          : `正在核对 Emperor ${version}`
      "
      data-update-state="downloading"
    >
      <div
        class="progress"
        role="progressbar"
        aria-label="下载进度"
        :aria-valuenow="Math.round(fraction * 100)"
        aria-valuemin="0"
        aria-valuemax="100"
      >
        <span class="fill" :style="{ transform: `scaleX(${fraction})` }" />
      </div>
      <span class="line">{{ progressText }}</span>
      <template v-if="download.phase === 'downloading'" #actions>
        <Button
          size="sm"
          variant="secondary"
          :disabled="busy === 'cancel'"
          @click="updates.cancel()"
          >取消</Button
        >
      </template>
    </Notice>

    <Notice
      v-else-if="download.phase === 'ready'"
      tone="ok"
      :title="`Emperor ${version} 已下载并通过校验`"
      data-update-state="ready"
    >
      <span class="line">{{ attestationText(download.attestation) }}</span>
      <ol class="steps">
        <li v-for="step in UPDATE_INSTALL_STEPS" :key="step">{{ step }}</li>
      </ol>
      <template #actions>
        <Button
          size="sm"
          variant="secondary"
          :disabled="busy === 'reveal'"
          @click="updates.reveal()"
          >在访达中显示</Button
        >
      </template>
    </Notice>

    <Notice
      v-else-if="download.phase === 'failed'"
      tone="error"
      :title="`Emperor ${version} 没有下载成功`"
      :description="download.message"
      data-update-state="failed"
    >
      <template #actions>
        <Button
          v-if="release"
          size="sm"
          variant="secondary"
          :disabled="busy === 'download'"
          @click="updates.download()"
          >重新下载</Button
        >
        <Button
          v-if="release"
          size="sm"
          :disabled="busy === 'notes'"
          @click="updates.openNotes()"
          >查看更新说明</Button
        >
      </template>
    </Notice>

    <Notice
      v-else-if="release"
      tone="accent"
      :title="`Emperor ${release.version} 可用`"
      description="下载后 Emperor 会核对安装包，再在访达中显示；替换旧版本由你来做。"
      data-update-state="available"
    >
      <template #actions>
        <Button
          size="sm"
          :disabled="busy === 'notes'"
          @click="updates.openNotes()"
          >查看更新说明</Button
        >
        <Button
          size="sm"
          variant="primary"
          :loading="busy === 'download'"
          data-update-download
          @click="updates.download()"
          >下载</Button
        >
      </template>
    </Notice>
  </div>
</template>

<style scoped>
.update-notice {
  margin-bottom: var(--space-5);
}

.progress {
  position: relative;
  height: 4px;
  margin: var(--space-2) 0 var(--space-1);
  overflow: hidden;
  border-radius: var(--radius-pill);
  background: var(--surface-hover-strong);
}

.fill {
  position: absolute;
  inset: 0;
  background: rgb(var(--accent));
  transform-origin: left center;
}

.line {
  display: block;
}

.steps {
  margin: var(--space-2) 0 0;
  padding-left: var(--space-5);
}

.steps li + li {
  margin-top: var(--space-1);
}
</style>
