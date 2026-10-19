<script setup lang="ts">
/**
 * Settings › 语音 — editor dictation (VO-02; macOS only for now), choices
 * first:
 * - a SettingsNotice on top only while something stops dictation: the
 *   dictation helper unavailable (why, and 重新检测) or a permission denied
 *   or restricted (with 打开系统设置); another one if a choice could not be
 *   saved for the next start;
 * - 听写: this window's microphone, language and shortcut
 *   (dictation/settings.ts). Only the devices and languages the helper
 *   reports are offered;
 * - 系统权限, last: the two permissions macOS asks for the first time you
 *   dictate, one line while they agree (「麦克风和语音识别 · 已允许」).
 * The wording is voice/voiceSettingsModel.ts. The helper is asked again
 * from the header's refresh and whenever the window regains focus, e.g.
 * after changing a permission in System Settings. Elsewhere the page says
 * 暂不支持.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import {
  EmptyState,
  Select,
  SettingsGroup,
  SettingsNotice,
  SettingsRow,
  SettingsSection,
  StatusBadge,
  refreshAction,
  useSettingsHeader,
} from './ui'
import Button from '../ui/Button.vue'
import ShortcutEditor from './ui/ShortcutEditor.vue'
import {
  dictationStatus,
  openDictationPrivacy,
  type DictationPrivacyPane,
  type DictationStatus,
} from '../../api/dictation'
import { shortcutConflict } from '../../dictation/model'
import {
  DEFAULT_DICTATION_SHORTCUT,
  useDictationSettings,
} from '../../dictation/settings'
import { detectShortcutPlatform } from '../../shortcuts'
import {
  deviceChoice,
  localeChoice,
  permissionRows,
  voiceNotice,
  type VoiceNoticeAction,
} from './voice/voiceSettingsModel'

const mac = detectShortcutPlatform() === 'mac'
const { settings, update } = useDictationSettings()
const status = ref<DictationStatus | null>(null)
const openFailed = ref<DictationPrivacyPane | null>(null)
const saveFailed = ref(false)

const supported = computed(() => status.value?.supported !== false)
const ready = computed(() => status.value?.available === true)
const notice = computed(() => voiceNotice(status.value, openFailed.value))
const permissions = computed(() => permissionRows(status.value))
const device = computed(() =>
  status.value ? deviceChoice(status.value, settings.value) : null,
)
const locale = computed(() =>
  status.value ? localeChoice(status.value, settings.value) : null,
)

async function load(): Promise<void> {
  status.value = await dictationStatus()
}

function save(patch: Parameters<typeof update>[0]): void {
  saveFailed.value = !update(patch)
}

function chooseDevice(value: string | undefined): void {
  const chosen = status.value?.devices.find((entry) => entry.id === value)
  if (!value) save({ device: null, deviceName: null })
  else if (chosen) save({ device: chosen.id, deviceName: chosen.name })
}

function chooseLocale(value: string | undefined): void {
  if (!value) save({ locale: null })
  else if (status.value?.locales.some((entry) => entry.id === value))
    save({ locale: value })
}

function saveShortcut(accelerator: string | null): void {
  save({ shortcut: accelerator ?? DEFAULT_DICTATION_SHORTCUT })
}

function conflict(accelerator: string): string | null {
  return shortcutConflict(accelerator, { mac })
}

async function openPrivacy(pane: DictationPrivacyPane): Promise<void> {
  openFailed.value = (await openDictationPrivacy(pane)) ? null : pane
}

function runNoticeAction(action: VoiceNoticeAction): void {
  if (action.kind === 'open') void openPrivacy(action.pane)
  else void load()
}

useSettingsHeader({
  actions: () => [refreshAction(() => load(), { label: '重新检测听写组件' })],
})

function onFocus(): void {
  void load()
}

onMounted(() => {
  void load()
  window.addEventListener('focus', onFocus)
})

onBeforeUnmount(() => {
  window.removeEventListener('focus', onFocus)
})
</script>

<template>
  <SettingsSection>
    <EmptyState
      v-if="!supported"
      title="暂不支持"
      :description="status?.reason ?? '听写目前只支持 macOS'"
      framed
    />
    <template v-else>
      <SettingsNotice
        v-if="notice"
        class="voice-notice"
        :tone="notice.tone"
        :title="notice.title"
        :description="notice.description"
        :data-voice-notice="notice.id"
      >
        <template v-if="notice.actions.length" #actions>
          <Button
            v-for="action in notice.actions"
            :key="action.kind === 'open' ? action.pane : action.kind"
            size="sm"
            variant="secondary"
            @click="runNoticeAction(action)"
            >{{ action.label }}</Button
          >
        </template>
      </SettingsNotice>
      <SettingsNotice
        v-if="saveFailed"
        class="voice-notice"
        tone="error"
        title="没能保存到本机"
        description="这次更改只在本次打开期间有效。"
      />

      <SettingsGroup
        title="听写"
        description="在输入框里用说话代替打字，识别在这台 Mac 上完成"
      >
        <SettingsRow title="麦克风" :description="device?.description">
          <template v-if="device?.tone" #badge>
            <StatusBadge :tone="device.tone">需要留意</StatusBadge>
          </template>
          <Select
            size="sm"
            aria-label="听写使用的麦克风"
            :model-value="settings.device ?? ''"
            :options="device?.options ?? []"
            :disabled="!ready"
            @update:model-value="chooseDevice"
          />
        </SettingsRow>
        <SettingsRow title="识别语言" :description="locale?.description">
          <template v-if="locale?.tone" #badge>
            <StatusBadge :tone="locale.tone">需要留意</StatusBadge>
          </template>
          <Select
            size="sm"
            aria-label="听写识别的语言"
            :model-value="settings.locale ?? ''"
            :options="locale?.options ?? []"
            :disabled="!ready"
            @update:model-value="chooseLocale"
          />
        </SettingsRow>
        <SettingsRow
          title="快捷键"
          description="在输入框里按下开始，再按一次结束"
        >
          <ShortcutEditor
            :accelerator="settings.shortcut"
            :default-accelerator="DEFAULT_DICTATION_SHORTCUT"
            capture-label="按下新的听写快捷键"
            test-id="dictation-shortcut"
            :check="conflict"
            show-current
            @save="saveShortcut"
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup v-if="permissions.length" title="系统权限">
        <SettingsRow
          v-for="permission in permissions"
          :key="permission.id"
          :title="permission.title"
          :description="permission.description"
          :data-testid="
            permission.id === 'both' ? 'dictation-permissions' : undefined
          "
          :data-permission="permission.id"
        >
          <StatusBadge
            :tone="permission.tone"
            :dot="permission.tone === 'ok'"
            >{{ permission.badge }}</StatusBadge
          >
        </SettingsRow>
      </SettingsGroup>
    </template>
  </SettingsSection>
</template>

<style scoped>
.voice-notice + .voice-notice {
  margin-top: var(--space-2);
}
</style>
