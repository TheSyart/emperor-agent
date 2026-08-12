<script setup lang="ts">
import AttachmentChip from './AttachmentChip.vue'
import CapabilityPicker from './CapabilityPicker.vue'
import ComposerLifecycleIndicator from './ComposerLifecycleIndicator.vue'
import {
  COMPOSER_ACCEPT_LIST,
  COMPOSER_QUEUE_FULL_MESSAGE,
  useComposerController,
  type ComposerControllerProps,
  type ComposerEmit,
} from './composerController'

const props = defineProps<ComposerControllerProps>()
const emit = defineEmits<ComposerEmit>()
const controller = useComposerController(props, emit)
const {
  actionIcons,
  value,
  shell,
  input,
  highlightLayer,
  fileInput,
  modelButton,
  modelMenu,
  modeButton,
  modeMenu,
  drafts,
  uploading,
  dragActive,
  onFileInput,
  onDragEnter,
  onDragOver,
  onDragLeave,
  onDrop,
  removeDraft,
  modelMenuOpen,
  modeMenuOpen,
  modelMenuStyle,
  modelMenuPlacement,
  modeMenuStyle,
  modeMenuPlacement,
  paletteMode,
  paletteGroups,
  activePaletteItem,
  paletteHeading,
  paletteHint,
  inlineSegments,
  hasInlineTokens,
  composerSlashParts,
  attachTitle,
  modeOptions,
  currentMode,
  modeTitle,
  permissionAppliesAfterPlan,
  goalCaptureActive,
  goalCaptureStarting,
  otherModelEntries,
  showModelSwitcher,
  currentModelLabel,
  currentProviderLabel,
  currentProviderIcon,
  currentProviderIconMonochrome,
  currentProviderMaskStyle,
  currentProviderFallback,
  currentModelId,
  currentProtocolLabel,
  currentReasoningLabel,
  currentReasoningValue,
  modelTitle,
  reasoningOptions,
  arcLength,
  arcColor,
  percentLabel,
  contextLabel,
  sendDisabled,
  stopPresentation,
  resize,
  syncHighlightScroll,
  submit,
  handleKeydown,
  applyPaletteItem,
  toggleAddMenu,
  closeComposerMenus,
  toggleModeMenu,
  closeModeMenu,
  selectMode,
  toggleModelMenu,
  onModelMenuKeydown,
  selectModel,
  selectReasoning,
  fmt,
  modelEntryLabel,
  providerLabel,
  providerIcon,
  providerFallback,
  protocolLabel,
} = controller

const ACCEPT_LIST = COMPOSER_ACCEPT_LIST
const QUEUE_FULL_MESSAGE = COMPOSER_QUEUE_FULL_MESSAGE
defineExpose(controller.expose)
</script>

<template>
  <div
    ref="shell"
    class="composer-shell"
    :class="{ 'composer-drag-active': dragActive }"
    @dragenter="onDragEnter"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop="onDrop"
  >
    <slot name="queue" />

    <CapabilityPicker
      v-if="paletteMode"
      :groups="paletteGroups"
      :heading="paletteHeading"
      :hint="paletteHint"
      :mode="paletteMode"
      :active-id="activePaletteItem?.id"
      @select="applyPaletteItem"
    />

    <div
      v-if="drafts.length || uploading.size"
      class="composer-drafts composer-attachments-tray"
      aria-label="待发送附件"
    >
      <AttachmentChip
        v-for="(d, i) in drafts"
        :key="d.id"
        :data="d"
        removable
        @remove="removeDraft(i)"
      />
      <div
        v-for="name in Array.from(uploading)"
        :key="name"
        class="attach-chip uploading"
        :title="name"
      >
        <span class="attach-doc-icon">
          <component
            :is="actionIcons.statusBusy"
            class="animate-spin"
            :size="14"
          />
        </span>
        <div class="attach-meta">
          <div class="attach-name">{{ name }}</div>
          <div class="attach-sub">上传中…</div>
        </div>
      </div>
    </div>

    <form
      class="composer"
      @submit.prevent="submit()"
      @keydown.esc="closeComposerMenus"
    >
      <input
        ref="fileInput"
        type="file"
        multiple
        :accept="ACCEPT_LIST"
        class="hidden-file-input"
        @change="onFileInput"
      />

      <div class="composer-input-row">
        <div
          class="composer-textarea-wrap"
          :class="{
            'has-skill-slash': composerSlashParts,
            'has-inline-tokens': hasInlineTokens,
          }"
        >
          <div
            v-if="composerSlashParts || hasInlineTokens"
            ref="highlightLayer"
            class="composer-highlight-layer"
            aria-hidden="true"
          >
            <template v-if="hasInlineTokens">
              <template v-for="(segment, index) in inlineSegments" :key="index">
                <span
                  v-if="segment.kind === 'token'"
                  class="composer-inline-token"
                  :data-kind="segment.tokenKind"
                >
                  {{ segment.tokenKind === 'skill' ? 'Skill' : 'MCP' }} ·
                  {{ segment.name }}
                </span>
                <span v-else>{{ segment.text }}</span>
              </template>
            </template>
            <template v-else-if="composerSlashParts">
              <span class="composer-skill-slash">{{
                composerSlashParts.token
              }}</span
              ><span>{{ composerSlashParts.rest }}</span>
            </template>
          </div>
          <textarea
            ref="input"
            v-model="value"
            rows="2"
            :disabled="goalCaptureStarting || props.interactionBlocked"
            :placeholder="
              props.busy
                ? '输入消息，按 Enter 加入队列'
                : goalCaptureStarting
                  ? '正在启动 Goal...'
                  : goalCaptureActive
                    ? '描述要持续完成的目标'
                    : props.sendBlockedReason ||
                      '描述要推进的任务。可用 / 调用命令，拖入图片或文档'
            "
            @focus="closeComposerMenus"
            @input="resize"
            @scroll="syncHighlightScroll"
            @keydown="handleKeydown"
          />
        </div>
      </div>

      <div class="composer-action-row">
        <div class="composer-left-actions">
          <button
            type="button"
            class="attach-button"
            :title="attachTitle"
            :aria-label="attachTitle"
            :disabled="goalCaptureStarting"
            @click="toggleAddMenu"
          >
            <component :is="actionIcons.new" class="action-icon" :size="16" />
          </button>

          <div class="mode-picker">
            <button
              ref="modeButton"
              type="button"
              class="mode-button"
              :aria-expanded="modeMenuOpen"
              :title="modeTitle"
              :disabled="props.busy"
              @click="toggleModeMenu"
            >
              <component :is="currentMode.icon" class="mode-icon" :size="16" />
              <span>{{ currentMode.short }}</span>
              <component
                :is="actionIcons.caretDown"
                class="mode-caret"
                :size="12"
              />
            </button>
          </div>

          <span
            v-if="props.lifecycleMode"
            class="composer-action-divider"
            aria-hidden="true"
          />
          <ComposerLifecycleIndicator
            v-if="props.lifecycleMode"
            :kind="props.lifecycleMode"
            :busy="props.busy || goalCaptureStarting"
            @dismiss="emit('dismiss-lifecycle')"
          />
        </div>

        <div class="composer-right-actions">
          <div
            v-if="props.contextMax > 0"
            class="context-ring"
            tabindex="0"
            role="status"
            :aria-label="contextLabel"
          >
            <svg viewBox="0 0 36 36" class="ring-svg">
              <circle class="ring-track" cx="18" cy="18" r="15.915" />
              <circle
                class="ring-arc"
                cx="18"
                cy="18"
                r="15.915"
                :stroke="arcColor"
                :stroke-dasharray="`${arcLength} ${100 - arcLength}`"
                stroke-dashoffset="25"
              />
            </svg>
            <div class="context-tooltip" role="tooltip">
              <strong>上下文长度</strong>
              <span
                >{{ fmt(props.contextUsed) }} /
                {{ fmt(props.contextMax) }}</span
              >
              <em>已用 {{ percentLabel }}</em>
            </div>
          </div>

          <div v-if="showModelSwitcher" class="model-picker">
            <button
              ref="modelButton"
              type="button"
              class="model-button"
              aria-controls="composer-model-menu"
              :aria-expanded="modelMenuOpen"
              :title="modelTitle"
              :disabled="props.busy"
              @click="toggleModelMenu"
            >
              <span
                class="model-provider-avatar bare compact"
                aria-hidden="true"
              >
                <span
                  v-if="currentProviderIcon && currentProviderIconMonochrome"
                  class="model-provider-mask"
                  :style="currentProviderMaskStyle"
                />
                <img
                  v-else-if="currentProviderIcon"
                  :src="currentProviderIcon"
                  alt=""
                />
                <span v-else>{{ currentProviderFallback }}</span>
              </span>
              <span class="model-button-label">{{ currentModelLabel }}</span>
              <component
                :is="actionIcons.caretDown"
                class="model-caret"
                :size="12"
              />
            </button>
          </div>

          <template v-if="props.busy">
            <button
              type="button"
              class="send-button"
              :disabled="sendDisabled"
              :title="props.queueOccupied ? QUEUE_FULL_MESSAGE : '加入队列'"
              :aria-label="
                props.queueOccupied ? QUEUE_FULL_MESSAGE : '加入队列'
              "
              @click="submit('queue')"
            >
              <component
                :is="actionIcons.send"
                class="action-icon send-icon"
                :size="18"
              />
              <span class="sr-only">
                {{ props.queueOccupied ? QUEUE_FULL_MESSAGE : '加入队列' }}
              </span>
            </button>
            <button
              type="button"
              class="send-button stop-button"
              :title="stopPresentation.title"
              :aria-label="stopPresentation.label"
              @click="emit('stop')"
            >
              <component
                :is="actionIcons.stop"
                class="action-icon send-icon"
                :size="16"
              />
            </button>
          </template>
          <button
            v-else
            class="send-button"
            :disabled="sendDisabled"
            :title="
              goalCaptureStarting
                ? '正在启动 Goal'
                : props.sendBlockedReason || '发送'
            "
            :aria-label="goalCaptureStarting ? '正在启动 Goal' : '发送'"
            type="submit"
          >
            <component
              :is="
                goalCaptureStarting ? actionIcons.statusBusy : actionIcons.send
              "
              class="action-icon send-icon"
              :class="{ 'animate-spin': goalCaptureStarting }"
              :size="18"
            />
            <span class="sr-only">{{
              goalCaptureStarting ? '正在启动 Goal' : '发送'
            }}</span>
          </button>
        </div>
      </div>
    </form>

    <Teleport to="body">
      <div
        v-if="modeMenuOpen"
        ref="modeMenu"
        class="mode-menu mode-menu-floating"
        :data-placement="modeMenuPlacement"
        :style="modeMenuStyle"
        @keydown.esc="closeModeMenu"
      >
        <div class="mode-menu-head">
          <span>执行权限</span>
          <em>{{
            permissionAppliesAfterPlan ? '规划结束后使用' : '立即应用到下一轮'
          }}</em>
        </div>
        <button
          v-for="option in modeOptions"
          :key="option.value"
          type="button"
          class="mode-option"
          :data-active="currentMode.value === option.value"
          @click="selectMode(option.value)"
        >
          <component :is="option.icon" class="mode-option-icon" :size="16" />
          <span>
            <strong>{{ option.label }}</strong>
            <small>{{ option.description }}</small>
          </span>
          <b>{{ option.short }}</b>
        </button>
      </div>
    </Teleport>

    <Teleport to="body">
      <div
        v-if="modelMenuOpen"
        id="composer-model-menu"
        ref="modelMenu"
        class="model-menu model-menu-floating"
        role="dialog"
        aria-label="模型与思考"
        :data-placement="modelMenuPlacement"
        :style="modelMenuStyle"
        @keydown="onModelMenuKeydown"
      >
        <div class="model-menu-head">
          <span>模型</span>
          <em>下一轮生效</em>
        </div>
        <div class="model-current-card">
          <span class="model-provider-avatar" aria-hidden="true">
            <img v-if="currentProviderIcon" :src="currentProviderIcon" alt="" />
            <span v-else>{{ currentProviderFallback }}</span>
          </span>
          <span class="model-current-copy">
            <small>当前模型</small>
            <strong>{{ currentModelLabel }}</strong>
            <code>{{ currentModelId || '未配置模型 ID' }}</code>
            <span>
              {{ currentProviderLabel }} · {{ currentProtocolLabel }} · 思考
              {{ currentReasoningLabel }}
            </span>
          </span>
        </div>
        <div v-if="reasoningOptions.length > 1" class="reasoning-row">
          <span>思考强度</span>
          <div class="reasoning-control" role="group" aria-label="思考强度">
            <button
              v-for="option in reasoningOptions"
              :key="option.label"
              type="button"
              class="reasoning-choice"
              :data-active="(option.value || '') === currentReasoningValue"
              :disabled="props.busy"
              @click="selectReasoning(option.value)"
            >
              {{ option.label }}
            </button>
          </div>
        </div>

        <div class="model-menu-label">其他模型</div>
        <button
          v-for="entry in otherModelEntries"
          :key="entry.entryId"
          type="button"
          class="model-option"
          @click="entry.entryId && selectModel(entry.entryId)"
        >
          <span class="model-provider-avatar compact" aria-hidden="true">
            <img
              v-if="providerIcon(entry)"
              :src="providerIcon(entry) || ''"
              alt=""
            />
            <span v-else>{{ providerFallback(entry) }}</span>
          </span>
          <span class="model-option-copy">
            <strong>{{ modelEntryLabel(entry) }}</strong>
            <small>{{ entry.modelId || '未配置' }}</small>
            <span class="model-option-meta">
              <em>{{ providerLabel(entry.provider) }}</em>
              <em>{{ protocolLabel(entry.protocol) }}</em>
            </span>
          </span>
          <span class="model-option-badges">
            <b>切换</b>
          </span>
        </button>
        <p v-if="!otherModelEntries.length" class="model-menu-empty">
          没有其他已保存模型。
        </p>
      </div>
    </Teleport>
  </div>
</template>
