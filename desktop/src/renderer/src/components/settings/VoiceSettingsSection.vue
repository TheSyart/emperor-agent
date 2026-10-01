<script setup lang="ts">
/**
 * Settings › 语音 — editor dictation (VO-02; macOS only for now): the two
 * permissions macOS asks for the first time you dictate (one row once both
 * are granted), and this window's microphone, language and shortcut
 * (dictation/settings.ts). The dictation helper gets a row only when it is
 * unavailable, to say why. Only the devices and languages the helper
 * reports are offered (voice/voiceSettingsModel.ts). The helper is asked
 * again from the header's refresh and whenever the window regains focus,
 * e.g. after changing a permission in System Settings. Elsewhere the page
 * says 暂不支持.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import {
  EmptyState,
  Select,
  SettingsGroup,
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
  helperView,
  localeChoice,
  permissionView,
} from './voice/voiceSettingsModel'

const mac = detectShortcutPlatform() === 'mac'
const { settings, update } = useDictationSettings()
const status = ref<DictationStatus | null>(null)
const openFailed = ref<DictationPrivacyPane | null>(null)
const saveFailed = ref(false)

const helper = computed(() => helperView(status.value))
const supported = computed(() => status.value?.supported !== false)
const ready = computed(() => status.value?.available === true)
const microphone = computed(() =>
  permissionView(
    'microphone',
    status.value?.permissions.microphone ?? 'unknown',
  ),
)
const speech = computed(() =>
  permissionView('speech', status.value?.permissions.speech ?? 'unknown'),
)
/** Nothing to decide about the permissions: one row says so. */
const permissionsGranted = computed(
  () =>
    status.value?.permissions.microphone === 'granted' &&
    status.value.permissions.speech === 'granted',
)
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
  <SettingsSection
    :intro="
      supported
        ? '在聊天输入框里用说话代替打字。识别在这台 Mac 上完成，声音和文字都不会发到网络。'
        : undefined
    "
  >
    <EmptyState
      v-if="!supported"
      title="暂不支持"
      :description="status?.reason ?? '听写目前只支持 macOS'"
    />
    <template v-else>
      <SettingsRow
        v-if="status && !status.available"
        title="听写组件"
        :description="helper.description"
      >
        <StatusBadge :tone="helper.tone" dot data-testid="dictation-helper">{{
          helper.badge
        }}</StatusBadge>
      </SettingsRow>

      <SettingsGroup
        title="系统权限"
        :description="
          permissionsGranted
            ? undefined
            : '第一次听写时 macOS 会询问这两项；以后可以在系统设置里更改。'
        "
      >
        <SettingsRow
          v-if="permissionsGranted"
          title="麦克风和语音识别"
          description="只在听写时打开麦克风，在这台 Mac 上识别，不联网"
          data-testid="dictation-permissions"
        >
          <StatusBadge tone="ok">已允许</StatusBadge>
        </SettingsRow>
        <template v-else>
          <SettingsRow title="麦克风权限" :description="microphone.hint">
            <div class="voice-permission">
              <StatusBadge :tone="microphone.tone">{{
                microphone.label
              }}</StatusBadge>
              <Button
                v-if="microphone.canOpen"
                size="sm"
                variant="outline"
                @click="openPrivacy('microphone')"
                >打开系统设置</Button
              >
            </div>
          </SettingsRow>
          <SettingsRow title="语音识别权限" :description="speech.hint">
            <div class="voice-permission">
              <StatusBadge :tone="speech.tone">{{ speech.label }}</StatusBadge>
              <Button
                v-if="speech.canOpen"
                size="sm"
                variant="outline"
                @click="openPrivacy('speech')"
                >打开系统设置</Button
              >
            </div>
          </SettingsRow>
        </template>
        <p v-if="openFailed" class="voice-note" role="alert">
          没能打开系统设置，请手动前往「系统设置 › 隐私与安全性 ›
          {{ openFailed === 'microphone' ? '麦克风' : '语音识别' }}」。
        </p>
      </SettingsGroup>

      <SettingsGroup title="听写">
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
          description="在聊天输入框里按下开始听写，再按一次结束；只在 Emperor 窗口里有效。"
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
        <p v-if="saveFailed" class="voice-note" role="alert">
          这次更改只在本次打开期间有效：无法保存到本机。
        </p>
      </SettingsGroup>
    </template>
  </SettingsSection>
</template>

<style scoped>
.voice-permission {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-2);
}

.voice-note {
  margin: var(--space-2) 0 0;
  color: rgb(var(--state-error-label));
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
}
</style>
