<script setup lang="ts">
/**
 * ComposerCard — dsh InputBar card (max 780 = content 748 + 32, radius 22,
 * input-major fill, lv2 shadow; input 16/24 growing to 336px). Left
 * toolbar: `+` (attach / plan / goal / capabilities), PermissionChip,
 * PlanChip; right: ModelPicker, ContextMeter, 34px send / stop. All
 * behaviour (drafts, slash palette, reference chips, attachments, queue
 * rules, goal capture) lives in composerController.ts — this is its view.
 *
 * The input is the rich ComposerEditor (skill chips, RF-02); the old
 * textarea with its marker overlay stays behind COMPOSER_INPUT_FLAG until
 * the editor is accepted.
 *
 * Dictation (VO-03, composerDictation.ts): the mic before send and the
 * shortcut from 设置 › 语音, on macOS and in the rich editor only.
 * `dictationChat` names the chat on screen; a change stops the recording,
 * and a result that arrives afterwards waits above the input of its own
 * chat (插入 / 丢弃).
 */
import { computed, ref } from 'vue'
import AttachmentChip from '../chat/AttachmentChip.vue'
import CapabilityPicker from '../chat/CapabilityPicker.vue'
import {
  COMPOSER_ACCEPT_LIST,
  COMPOSER_QUEUE_FULL_MESSAGE,
  useComposerController,
  type ComposerControllerProps,
  type ComposerEmit,
} from '../chat/composerController'
import {
  DsArrowUp,
  DsGoal,
  DsLoading,
  DsPaperclip,
  DsPlan,
  DsPlus,
  DsQueue,
  DsSkill,
  DsStopSquare,
} from '../icons/ds'
import Menu from '../ui/Menu.vue'
import MenuItem from '../ui/MenuItem.vue'
import ContextMeter from './ContextMeter.vue'
import ComposerEditor from './editor/ComposerEditor.vue'
import DictationButton from './DictationButton.vue'
import { useComposerDictation } from './composerDictation'
import ModelPicker from './ModelPicker.vue'
import PermissionChip from './PermissionChip.vue'
import PlanChip from './PlanChip.vue'

const props = defineProps<
  ComposerControllerProps & { hero?: boolean; dictationChat?: string | null }
>()
const emit = defineEmits<ComposerEmit>()
const controller = useComposerController(props, emit)
const {
  value,
  richInput,
  editor,
  catalog,
  onEditorChange,
  onEditorTrigger,
  focusInput,
  shell,
  input,
  highlightLayer,
  fileInput,
  drafts,
  uploading,
  dragActive,
  onFileInput,
  onDragEnter,
  onDragOver,
  onDragLeave,
  onDrop,
  removeDraft,
  paletteMode,
  paletteGroups,
  activePaletteItem,
  paletteHeading,
  paletteHint,
  inlineSegments,
  hasInlineTokens,
  composerSlashParts,
  modeOptions,
  currentMode,
  modeTitle,
  permissionAppliesAfterPlan,
  goalCaptureActive,
  goalCaptureStarting,
  activeModelId,
  showModelSwitcher,
  currentModelLabel,
  currentReasoningLabel,
  currentReasoningValue,
  modelTitle,
  reasoningOptions,
  sendDisabled,
  stopPresentation,
  resize,
  syncHighlightScroll,
  submit,
  handleKeydown,
  applyPaletteItem,
  toggleAddMenu,
  closeComposerMenus,
  selectMode,
  selectModel,
  selectReasoning,
} = controller

const dictation = useComposerDictation({
  editor,
  chat: () => props.dictationChat ?? null,
  onError: (message) => emit('error', message),
})
const {
  supported: dictationSupported,
  phase: dictationPhase,
  shortcut: dictationShortcut,
  keptText: dictationKept,
} = dictation

/** The dictation shortcut first, then the composer's own keys. */
function editorKeydown(event: KeyboardEvent): void {
  if (dictation.handleKey(event)) return
  handleKeydown(event)
}

const addOpen = ref(false)
const addAnchor = ref<HTMLElement | null>(null)

const placeholder = computed(() =>
  props.busy
    ? '输入消息，按 Enter 加入队列'
    : goalCaptureStarting.value
      ? '正在启动 Goal...'
      : goalCaptureActive.value
        ? '描述要持续完成的目标'
        : props.sendBlockedReason ||
          (props.hero
            ? '有什么需要推进的？可用 / 调用命令，拖入图片或文档'
            : '继续对话，/ 调用命令'),
)
const hasDraft = computed(
  () => value.value.trim().length > 0 || drafts.value.length > 0,
)

function pickFiles(): void {
  fileInput.value?.click()
}

function openCapabilities(): void {
  toggleAddMenu()
}

function focusCard(event: MouseEvent): void {
  const target = event.target as HTMLElement
  if (
    target.closest(
      'button, a, input, textarea, [role="menu"], [contenteditable="true"]',
    )
  )
    return
  focusInput()
}

defineExpose(controller.expose)
</script>

<template>
  <div
    ref="shell"
    class="composer-root"
    :data-hero="hero || undefined"
    @dragenter="onDragEnter"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop="onDrop"
  >
    <form
      class="card"
      :data-drag="dragActive || undefined"
      @submit.prevent="submit()"
      @keydown.esc="closeComposerMenus"
      @click="focusCard"
    >
      <CapabilityPicker
        v-if="paletteMode"
        class="palette"
        :groups="paletteGroups"
        :heading="paletteHeading"
        :hint="paletteHint"
        :mode="paletteMode"
        :active-id="activePaletteItem?.id"
        @select="applyPaletteItem"
      />

      <input
        ref="fileInput"
        type="file"
        multiple
        :accept="COMPOSER_ACCEPT_LIST"
        class="file-input"
        @change="onFileInput"
      />

      <div
        v-if="drafts.length || uploading.size"
        class="accessory composer-attachments-tray"
        aria-label="待发送附件"
      >
        <AttachmentChip
          v-for="(draft, index) in drafts"
          :key="draft.id"
          :data="draft"
          removable
          @remove="removeDraft(index)"
        />
        <div
          v-for="name in Array.from(uploading)"
          :key="name"
          class="uploading"
          :title="name"
        >
          <DsLoading :size="14" class="spin" />
          <span>{{ name }}</span>
        </div>
      </div>

      <div
        v-if="richInput && dictationKept"
        class="accessory dictation-kept"
        role="status"
      >
        <span class="dictation-kept-text"
          >听写结果还没放进输入框：{{ dictationKept }}</span
        >
        <button
          type="button"
          class="dictation-kept-action"
          aria-label="插入听写内容"
          @click="dictation.insertKept()"
        >
          插入
        </button>
        <button
          type="button"
          class="dictation-kept-action"
          aria-label="丢弃听写内容"
          @click="dictation.discardKept()"
        >
          丢弃
        </button>
      </div>

      <ComposerEditor
        v-if="richInput"
        ref="editor"
        class="rich-input"
        :placeholder="placeholder"
        :disabled="goalCaptureStarting || props.interactionBlocked"
        :hero="hero"
        :catalog="catalog"
        :keydown="editorKeydown"
        @change="onEditorChange"
        @trigger="onEditorTrigger"
        @focus="closeComposerMenus"
      />
      <div v-else class="scroll">
        <div
          v-if="composerSlashParts || hasInlineTokens"
          ref="highlightLayer"
          class="backdrop"
          aria-hidden="true"
        >
          <template v-if="hasInlineTokens">
            <template v-for="(segment, index) in inlineSegments" :key="index">
              <span
                v-if="segment.kind === 'token'"
                class="token composer-inline-token"
                :data-kind="segment.tokenKind"
                >{{ segment.tokenKind === 'skill' ? 'Skill' : 'MCP' }} ·
                {{ segment.name }}</span
              >
              <span v-else>{{ segment.text }}</span>
            </template>
          </template>
          <template v-else-if="composerSlashParts">
            <span class="token composer-skill-slash">{{
              composerSlashParts.token
            }}</span
            ><span>{{ composerSlashParts.rest }}</span>
          </template>
        </div>
        <textarea
          ref="input"
          v-model="value"
          class="input"
          :data-overlay="composerSlashParts || hasInlineTokens || undefined"
          rows="1"
          aria-label="消息输入框"
          :disabled="goalCaptureStarting || props.interactionBlocked"
          :placeholder="placeholder"
          @focus="closeComposerMenus"
          @input="resize"
          @scroll="syncHighlightScroll"
          @keydown="handleKeydown"
        />
      </div>

      <div class="row">
        <div class="tools">
          <button
            ref="addAnchor"
            type="button"
            class="add"
            aria-label="添加附件与能力"
            title="添加附件与能力"
            :aria-expanded="addOpen"
            :disabled="goalCaptureStarting"
            @click="addOpen = !addOpen"
          >
            <DsPlus :size="16" />
          </button>
          <div class="modes">
            <PermissionChip
              :options="modeOptions"
              :current="currentMode"
              :disabled="props.busy"
              :after-plan="permissionAppliesAfterPlan"
              :title="modeTitle"
              @select="selectMode"
            />
            <PlanChip
              :mode="props.lifecycleMode ?? null"
              :busy="props.busy || goalCaptureStarting"
              @dismiss="emit('dismiss-lifecycle')"
            />
          </div>
        </div>
        <div class="trailing">
          <ModelPicker
            v-if="showModelSwitcher"
            :entries="props.modelEntries"
            :active-id="activeModelId"
            :label="currentModelLabel"
            :reasoning-label="currentReasoningLabel"
            :reasoning-value="currentReasoningValue"
            :reasoning-options="reasoningOptions"
            :provider-options="props.providerOptions"
            :disabled="props.busy"
            :title="modelTitle"
            @select-model="selectModel"
            @select-reasoning="selectReasoning"
          />
          <ContextMeter
            v-if="props.contextMax > 0"
            :used="props.contextUsed"
            :max="props.contextMax"
          />
          <DictationButton
            v-if="richInput && dictationSupported"
            :phase="dictationPhase"
            :shortcut="dictationShortcut"
            :disabled="goalCaptureStarting || props.interactionBlocked"
            @toggle="dictation.toggle()"
            @cancel="dictation.cancel()"
          />
          <template v-if="props.busy">
            <button
              v-if="hasDraft"
              type="button"
              class="primary secondary"
              :disabled="sendDisabled"
              :title="
                props.queueOccupied ? COMPOSER_QUEUE_FULL_MESSAGE : '加入队列'
              "
              :aria-label="
                props.queueOccupied ? COMPOSER_QUEUE_FULL_MESSAGE : '加入队列'
              "
              @click="submit('queue')"
            >
              <DsQueue :size="16" />
            </button>
            <button
              type="button"
              class="primary"
              :title="stopPresentation.title"
              :aria-label="stopPresentation.label"
              @click="emit('stop')"
            >
              <DsStopSquare :size="16" />
            </button>
          </template>
          <button
            v-else
            type="submit"
            class="primary"
            :disabled="sendDisabled"
            :title="
              goalCaptureStarting
                ? '正在启动 Goal'
                : props.sendBlockedReason || '发送'
            "
            :aria-label="goalCaptureStarting ? '正在启动 Goal' : '发送'"
          >
            <DsLoading v-if="goalCaptureStarting" :size="18" class="spin" />
            <DsArrowUp v-else :size="18" />
          </button>
        </div>
      </div>
    </form>

    <Menu v-model:open="addOpen" :anchor="addAnchor" :width="220" label="添加">
      <MenuItem @select="pickFiles">
        <template #icon><DsPaperclip :size="16" /></template>
        上传图片或文件
      </MenuItem>
      <MenuItem @select="openCapabilities">
        <template #icon><DsSkill :size="16" /></template>
        {{ richInput ? '插入 Skill 或插件' : '插入 Skill / MCP' }}
      </MenuItem>
      <MenuItem variant="separator" />
      <MenuItem
        :disabled="props.busy || props.lifecycleMode === 'plan'"
        description="先规划，确认后再执行"
        @select="emit('activate-plan')"
      >
        <template #icon><DsPlan :size="16" /></template>
        Plan 模式
      </MenuItem>
      <MenuItem
        :disabled="props.busy || props.lifecycleMode === 'goal'"
        description="持续推进直到目标完成"
        @select="emit('activate-goal')"
      >
        <template #icon><DsGoal :size="16" /></template>
        Goal 模式
      </MenuItem>
    </Menu>
  </div>
</template>

<style scoped>
.composer-root {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 0 var(--composer-clearance) var(--space-2);
}

.composer-root[data-hero] {
  padding-bottom: 0;
}

.card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  box-sizing: border-box;
  width: 100%;
  max-width: var(--composer-card-max);
  padding-top: var(--space-2-5);
  border: 1px solid var(--border-l2);
  border-radius: var(--radius-composer);
  background: rgb(var(--input-major));
  box-shadow: var(--shadow-lv2);
  font-size: var(--fs-base);
  line-height: var(--lh-base);
  cursor: text;
}

.card:focus-within {
  border-color: var(--border-l3);
}

.card[data-drag] {
  border-color: rgb(var(--accent-fill) / 0.7);
  box-shadow:
    var(--shadow-lv2),
    0 0 0 3px rgb(var(--accent-fill) / 0.15);
}

.palette {
  position: absolute;
  right: 0;
  bottom: calc(100% + var(--space-2));
  left: 0;
  z-index: var(--z-popover);
}

.file-input {
  display: none;
}

.accessory {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  padding: 0 var(--space-3);
}

.dictation-kept {
  flex-wrap: nowrap;
  padding: 0 var(--space-4);
  color: rgb(var(--label-secondary));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
}

.dictation-kept-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dictation-kept-action {
  flex: none;
  padding: var(--space-0-5) var(--space-2);
  border: none;
  border-radius: var(--radius-pill);
  background: rgb(var(--selector-fill));
  color: rgb(var(--label-primary));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  cursor: pointer;
}

.dictation-kept-action:hover {
  background: rgb(var(--interactive-bg-hover-solid));
}

.uploading {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1-5);
  max-width: 220px;
  height: var(--space-7);
  padding: 0 var(--space-2-5);
  border-radius: var(--radius-cell);
  background: var(--interactive-bg-hover);
  color: rgb(var(--label-secondary));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  white-space: nowrap;
}

.uploading span {
  overflow: hidden;
  text-overflow: ellipsis;
}

.scroll {
  position: relative;
  display: grid;
}

.backdrop,
.input {
  grid-area: 1 / 1;
  box-sizing: border-box;
  min-width: 0;
  margin: 0;
  padding: var(--space-1) var(--space-3) 0 var(--space-4);
  font-family: var(--font-sans);
  font-size: inherit;
  line-height: inherit;
  white-space: pre-wrap;
  word-break: break-word;
  overflow-wrap: anywhere;
}

.backdrop {
  overflow: hidden;
  color: rgb(var(--label-primary));
  pointer-events: none;
}

.token {
  color: rgb(var(--accent-strong));
}

.input {
  width: 100%;
  min-height: var(--space-7);
  max-height: 336px;
  resize: none;
  overflow-y: auto;
  border: none;
  outline: none;
  background: transparent;
  color: rgb(var(--label-primary));
  caret-color: rgb(var(--caret));
}

.input:focus,
.input:focus-visible {
  outline: none;
  box-shadow: none;
}

[data-hero] .input {
  min-height: 52px;
}

.input[data-overlay] {
  color: transparent;
  -webkit-text-fill-color: transparent;
}

.input::placeholder {
  color: rgb(var(--label-caption));
  -webkit-text-fill-color: rgb(var(--label-caption));
}

.input:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}

.row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  min-width: 0;
  padding: var(--space-0-5) var(--space-2) var(--space-1-5);
  container-type: inline-size;
}

.tools,
.modes,
.trailing {
  display: flex;
  align-items: center;
  min-width: 0;
}

.tools {
  gap: var(--space-4);
}

.modes {
  gap: var(--space-3);
}

.trailing {
  flex: none;
  gap: var(--space-3);
  margin-left: auto;
}

.add {
  display: grid;
  place-items: center;
  flex: none;
  width: var(--space-7);
  height: var(--space-7);
  padding: 0;
  border: none;
  border-radius: var(--radius-pill);
  background: rgb(var(--selector-fill));
  color: rgb(var(--label-primary));
  cursor: pointer;
}

.add:hover:not(:disabled),
.add[aria-expanded='true'] {
  background: rgb(var(--interactive-bg-hover-solid));
}

.add:disabled {
  opacity: 0.5;
  cursor: default;
}

.primary {
  display: grid;
  place-items: center;
  flex: none;
  width: calc(var(--space-8) + 2px);
  height: calc(var(--space-8) + 2px);
  padding: 0;
  border: none;
  border-radius: var(--radius-pill);
  background: rgb(var(--accent-fill));
  color: rgb(var(--accent-fg));
  cursor: pointer;
  transform: translateY(-2px);
  transition: background-color var(--duration-ds-fast) ease;
}

.primary:hover:not(:disabled) {
  background: rgb(var(--accent-hover));
}

.primary:disabled {
  opacity: 0.4;
  cursor: default;
}

.primary:focus-visible,
.add:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px rgb(var(--focus-ring) / 0.5);
}

.primary.secondary {
  background: var(--interactive-bg-hover);
  color: rgb(var(--label-primary));
}

.primary.secondary:hover:not(:disabled) {
  background: var(--interactive-bg-active);
}

.spin {
  animation: composer-spin 1s linear infinite;
}

@keyframes composer-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
