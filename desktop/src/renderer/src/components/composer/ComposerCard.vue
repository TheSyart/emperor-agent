<script setup lang="ts">
/**
 * ComposerCard — the chat composer: a raised card (UI-S04 look: r-xl 24,
 * `--composer-fill`, `--composer-edge` — dark `--elev-1`, light hairline +
 * `--elev-1`) with the rich editor above the bottom bar. Left: `+` (上传图片
 * 或文件, 插入 Skill 或插件, 截图 on macOS, Plan 模式, Goal 模式),
 * PermissionChip, PlanChip; right: ModelPicker, ContextMeter and the send
 * slot — the microphone while the composer is empty (where dictation
 * exists), send once there is a draft, stop while a turn runs (with 加入
 * 队列 beside it once there is a draft). The input area of a one-line draft
 * is at least 56px tall. All behaviour lives in composerController.ts —
 * this is its view.
 *
 * Dictation (VO-03, composerDictation.ts): the mic and the shortcut from
 * 设置 › 语音, on macOS. While it records, the recording bar takes the
 * bottom row (RV-06): × cancel, the waveform and ■ stop (DictationBar),
 * then send, which ends the dictation and sends once the final text is in.
 * `dictationChat` names the chat on screen; a change stops the recording,
 * and a result that arrives afterwards waits above the input of its own
 * chat (插入 / 丢弃).
 */
import { Camera } from 'lucide-vue-next'
import {
  computed,
  nextTick,
  ref,
  watch,
  type ComponentPublicInstance,
} from 'vue'
import { screenshotSupported } from '../../api/screenshot'
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
  DsPaperclip,
  DsPlan,
  DsPlus,
  DsQueue,
  DsSkill,
  DsStopSquare,
} from '../icons/ds'
import { requestAddModel } from '../settings/model/addModelRequest'
import { useSettingsRoute } from '../settings/useSettingsRoute'
import Button from '../ui/Button.vue'
import IconButton from '../ui/IconButton.vue'
import Menu from '../ui/Menu.vue'
import MenuItem from '../ui/MenuItem.vue'
import Spinner from '../ui/Spinner.vue'
import ContextMeter from './ContextMeter.vue'
import DictationBar from './DictationBar.vue'
import DictationButton from './DictationButton.vue'
import ModelPicker from './ModelPicker.vue'
import PermissionChip from './PermissionChip.vue'
import PlanChip from './PlanChip.vue'
import { useComposerDictation } from './composerDictation'
import ComposerEditor from './editor/ComposerEditor.vue'

const props = defineProps<
  ComposerControllerProps & { hero?: boolean; dictationChat?: string | null }
>()
const emit = defineEmits<ComposerEmit>()
const controller = useComposerController(props, emit)
const {
  editor,
  catalog,
  onEditorChange,
  onEditorTrigger,
  focusInput,
  shell,
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
  handleFiles,
  hasDraft,
  unknownSlashHint,
  secretPrompt,
  resolveSecretPrompt,
  paletteMode,
  paletteGroups,
  activePaletteItem,
  paletteHeading,
  paletteHint,
  modeOptions,
  currentMode,
  modeTitle,
  planEnabled,
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
  submit,
  handleKeydown,
  applyPaletteItem,
  toggleAddMenu,
  closeComposerMenus,
  pickFiles,
  takeScreenshot,
  selectMode,
  selectModel,
  selectReasoning,
} = controller

const dictation = useComposerDictation({
  editor,
  chat: () => props.dictationChat ?? null,
  onError: (message) => emit('error', message),
  onSend: () => submit(),
})
const {
  supported: dictationSupported,
  phase: dictationPhase,
  levels: dictationLevels,
  sending: dictationSending,
  shortcut: dictationShortcut,
  keptText: dictationKept,
} = dictation
/** Recording: the recording bar holds the bottom row. */
const dictationActive = computed(() => dictationPhase.value !== 'idle')
const dictationSendDisabled = computed(
  () =>
    dictationPhase.value === 'starting' ||
    dictationSending.value ||
    goalCaptureStarting.value ||
    Boolean(props.interactionBlocked),
)
/** The send slot holds the microphone until there is something to send. */
const micInSendSlot = computed(
  () =>
    dictationSupported &&
    !props.busy &&
    !hasDraft.value &&
    !goalCaptureStarting.value,
)

/**
 * The mic, or the recording bar, leaves with the row it is in. Focus that
 * was there (or got lost with it) goes to the editor, so typing and the
 * shortcut keep working; focus elsewhere in the window stays put.
 */
watch(dictationActive, () => {
  const focused = document.activeElement
  const inRow =
    focused !== null &&
    shell.value?.contains(focused) === true &&
    focused.closest('.composer-editor') === null
  if (!inRow && focused !== null && focused !== document.body) return
  void nextTick(() => {
    const now = document.activeElement
    if (now === null || now === document.body) focusInput()
  })
})

/** The dictation shortcut first, then the composer's own keys. */
function editorKeydown(event: KeyboardEvent): void {
  if (dictation.handleKey(event)) return
  handleKeydown(event)
}

const addOpen = ref(false)
const addAnchor = ref<HTMLElement | null>(null)
const canScreenshot = screenshotSupported()
/** The <button> behind a component ref (Menu anchors to an element). */
function anchorElement(instance: unknown): HTMLElement | null {
  const el = (instance as ComponentPublicInstance | null)?.$el
  return el instanceof HTMLElement ? el : null
}

/** No session here (F1): every control is off, and nothing shows another session's state. */
const unavailable = computed(() => Boolean(props.unavailableReason))

const placeholder = computed(() =>
  props.unavailableReason
    ? props.unavailableReason
    : props.busy
      ? '输入消息，按 Enter 加入队列'
      : goalCaptureStarting.value
        ? '正在启动目标...'
        : goalCaptureActive.value
          ? '描述要持续完成的目标'
          : props.sendBlockedReason ||
            (props.hero
              ? '有什么需要推进的？/ 调用技能，@ 引用插件，可拖入图片或文档'
              : '继续对话，/ 调用技能，@ 引用插件'),
)

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

const settingsRoute = useSettingsRoute()

/** 添加模型… in the model menu: open 设置 › 模型 with the add dialog. */
function addModel(): void {
  requestAddModel()
  void settingsRoute.openSettings('model')
}
</script>

<template>
  <div
    ref="shell"
    class="composer-root"
    :data-hero="hero || undefined"
    v-on="
      unavailable
        ? {}
        : {
            dragenter: onDragEnter,
            dragover: onDragOver,
            dragleave: onDragLeave,
            drop: onDrop,
          }
    "
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
          :owner="dictationChat || ''"
          :group="drafts"
          removable
          @remove="removeDraft(index)"
        />
        <div
          v-for="[uploadId, name] in Array.from(uploading)"
          :key="uploadId"
          class="uploading"
          :title="name"
        >
          <Spinner size="sm" />
          <span>{{ name }}</span>
        </div>
      </div>

      <div v-if="dictationKept" class="accessory dictation-kept" role="status">
        <span class="dictation-kept-text"
          >听写结果还没放进输入框：{{ dictationKept }}</span
        >
        <Button
          size="sm"
          variant="secondary"
          aria-label="插入听写内容"
          @click="dictation.insertKept()"
        >
          插入
        </Button>
        <Button
          size="sm"
          aria-label="丢弃听写内容"
          @click="dictation.discardKept()"
        >
          丢弃
        </Button>
      </div>

      <div
        v-if="secretPrompt"
        class="accessory composer-notice"
        role="alertdialog"
        aria-label="消息里可能包含密钥"
      >
        <span class="composer-notice-text"
          >消息里可能包含密钥（API Key、令牌或私钥）</span
        >
        <Button
          size="sm"
          variant="secondary"
          @click="resolveSecretPrompt('mask')"
        >
          遮掩后发送
        </Button>
        <Button size="sm" @click="resolveSecretPrompt('send')">仍然发送</Button>
        <Button size="sm" @click="resolveSecretPrompt('cancel')">取消</Button>
      </div>
      <div
        v-else-if="unknownSlashHint"
        class="accessory composer-notice"
        role="status"
      >
        <span class="composer-notice-text">{{ unknownSlashHint }}</span>
      </div>

      <ComposerEditor
        ref="editor"
        class="rich-input"
        :placeholder="placeholder"
        :disabled="
          unavailable || goalCaptureStarting || props.interactionBlocked
        "
        :hero="hero"
        :catalog="catalog"
        :keydown="editorKeydown"
        @change="onEditorChange"
        @trigger="onEditorTrigger"
        @focus="closeComposerMenus"
        @files="handleFiles"
      />

      <div v-if="dictationActive" class="composer-bar dictation-row">
        <DictationBar
          :phase="dictationPhase"
          :levels="dictationLevels"
          :shortcut="dictationShortcut"
          @cancel="dictation.cancel()"
          @stop="dictation.stop()"
        />
        <IconButton
          label="结束听写并发送"
          size="md"
          variant="primary"
          shape="circle"
          :disabled="dictationSendDisabled"
          @click="dictation.stopAndSend()"
        >
          <Spinner v-if="dictationSending" size="md" />
          <DsArrowUp v-else :size="16" />
        </IconButton>
      </div>
      <div v-else class="composer-bar">
        <IconButton
          :ref="(c) => (addAnchor = anchorElement(c))"
          label="添加附件与能力"
          size="sm"
          shape="circle"
          :active="addOpen"
          :aria-expanded="addOpen"
          :disabled="unavailable || goalCaptureStarting"
          @click="addOpen = !addOpen"
        >
          <DsPlus :size="16" />
        </IconButton>
        <PermissionChip
          :options="modeOptions"
          :current="currentMode"
          :disabled="unavailable || props.busy"
          :after-plan="planEnabled"
          :title="modeTitle"
          @select="selectMode"
        />
        <PlanChip
          :mode="unavailable ? null : (props.lifecycleMode ?? null)"
          :busy="props.busy || goalCaptureStarting"
          @dismiss="emit('dismiss-lifecycle')"
        />
        <span class="spacer" />
        <ModelPicker
          v-if="showModelSwitcher"
          :entries="props.modelEntries"
          :active-id="activeModelId"
          :label="currentModelLabel"
          :reasoning-label="currentReasoningLabel"
          :reasoning-value="currentReasoningValue"
          :reasoning-options="reasoningOptions"
          :provider-options="props.providerOptions"
          :disabled="unavailable || props.busy"
          :title="modelTitle"
          @select-model="selectModel"
          @select-reasoning="selectReasoning"
          @add-model="addModel"
        />
        <ContextMeter
          v-if="props.contextMax > 0 && !unavailable"
          :used="props.contextUsed"
          :max="props.contextMax"
        />
        <DictationButton
          v-if="micInSendSlot"
          :shortcut="dictationShortcut"
          :disabled="unavailable || props.interactionBlocked"
          @start="dictation.toggle()"
        />
        <template v-else-if="props.busy && !unavailable">
          <IconButton
            v-if="hasDraft"
            :label="
              props.queueOccupied ? COMPOSER_QUEUE_FULL_MESSAGE : '加入队列'
            "
            size="md"
            variant="tonal"
            shape="circle"
            :disabled="sendDisabled"
            @click="submit('queue')"
          >
            <DsQueue :size="16" />
          </IconButton>
          <IconButton
            :label="stopPresentation.label"
            :tooltip="stopPresentation.title"
            size="md"
            variant="tonal"
            shape="circle"
            @click="emit('stop')"
          >
            <DsStopSquare :size="16" />
          </IconButton>
        </template>
        <IconButton
          v-else
          type="submit"
          :label="goalCaptureStarting ? '正在启动目标' : '发送'"
          :tooltip="
            goalCaptureStarting
              ? '正在启动目标'
              : props.sendBlockedReason || '发送'
          "
          size="md"
          variant="primary"
          shape="circle"
          :disabled="sendDisabled"
        >
          <Spinner v-if="goalCaptureStarting" size="md" />
          <DsArrowUp v-else :size="16" />
        </IconButton>
      </div>
    </form>

    <Menu v-model:open="addOpen" :anchor="addAnchor" :width="220" label="添加">
      <MenuItem @select="pickFiles">
        <template #icon><DsPaperclip :size="16" /></template>
        上传图片或文件
      </MenuItem>
      <MenuItem @select="toggleAddMenu">
        <template #icon><DsSkill :size="16" /></template>
        插入 Skill 或插件
      </MenuItem>
      <MenuItem v-if="canScreenshot" @select="takeScreenshot">
        <template #icon><Camera :size="16" :stroke-width="1.5" /></template>
        截图
      </MenuItem>
      <MenuItem variant="separator" />
      <MenuItem
        :disabled="props.busy || props.lifecycleMode === 'plan'"
        description="先规划，确认后再执行"
        @select="emit('activate-plan')"
      >
        <template #icon><DsPlan :size="16" /></template>
        计划模式
      </MenuItem>
      <MenuItem
        :disabled="props.busy || props.lifecycleMode === 'goal'"
        description="持续推进直到目标完成"
        @select="emit('activate-goal')"
      >
        <template #icon><DsGoal :size="16" /></template>
        目标模式
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

/* Raised, r-xl 24, no border; the edge is a shadow (dark) or a hairline
   ring plus the shadow (light): --composer-edge. A one-line draft's input
   area (top padding + one 28px line + the gap to the bar) is 56px. */
.card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  box-sizing: border-box;
  width: 100%;
  max-width: var(--composer-card-max);
  padding-top: var(--space-4);
  border: none;
  border-radius: var(--r-xl);
  background: rgb(var(--composer-fill));
  box-shadow: var(--composer-edge);
  font-size: var(--fs-base);
  line-height: var(--lh-base);
  cursor: text;
}

.card[data-drag] {
  box-shadow:
    var(--composer-edge),
    0 0 0 2px rgb(var(--focus-ring) / 0.5);
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
  color: rgb(var(--text-2));
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

/* One line above the input: a /word that will go out as text, or the key
   prompt. */
.composer-notice {
  flex-wrap: wrap;
  gap: var(--space-1-5);
  padding: 0 var(--space-4);
  color: rgb(var(--text-2));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
}

.composer-notice-text {
  flex: 1;
  min-width: 0;
}

.uploading {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1-5);
  max-width: 220px;
  height: var(--space-7);
  padding: 0 var(--space-2-5);
  border-radius: var(--radius-cell);
  background: var(--surface-hover);
  color: rgb(var(--text-2));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  white-space: nowrap;
}

.uploading span {
  overflow: hidden;
  text-overflow: ellipsis;
}

/* + with the permission and Plan chips on the left; model, context and the
   send slot on the right. */
.composer-bar {
  display: flex;
  align-items: center;
  gap: var(--space-1-5);
  min-width: 0;
  padding: 0 var(--space-2-5) var(--space-2-5) var(--space-3);
  container-type: inline-size;
}

.spacer {
  flex: 1;
  min-width: 0;
}

/* RV-06: the recording bar, then the send button, on one line. */
.dictation-row {
  gap: var(--space-2-5);
}
</style>
