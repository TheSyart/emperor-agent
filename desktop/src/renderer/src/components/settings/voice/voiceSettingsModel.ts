/**
 * Settings › 语音: what the page says about the dictation helper, the two
 * permissions and the microphone and language choices. Only devices and
 * languages the helper reports are offered; a saved choice that went away
 * stays in the list, marked, and the editor uses the default meanwhile
 * (dictation/model.ts `dictationRequest`).
 */
import type {
  DictationPermission,
  DictationPrivacyPane,
  DictationStatus,
} from '../../../api/dictation'
import { resolveDictationLocale } from '../../../dictation/model'
import type { DictationSettings } from '../../../dictation/settings'
import type { SelectOption } from '../ui'

export type VoiceTone = 'ok' | 'warn' | 'error' | 'neutral'

export interface PermissionView {
  label: string
  tone: VoiceTone
  hint: string
  /** Denied: a button opens the System Settings list. */
  canOpen: boolean
}

const PANE_NAMES: Readonly<Record<DictationPrivacyPane, string>> = {
  microphone: '麦克风',
  speech: '语音识别',
}

export function permissionView(
  pane: DictationPrivacyPane,
  state: DictationPermission,
): PermissionView {
  switch (state) {
    case 'granted':
      return {
        label: '已允许',
        tone: 'ok',
        hint:
          pane === 'microphone'
            ? '只在听写时打开麦克风'
            : '在这台 Mac 上识别，不联网',
        canOpen: false,
      }
    case 'undetermined':
      return {
        label: '尚未询问',
        tone: 'neutral',
        hint: '第一次听写时 macOS 会询问',
        canOpen: false,
      }
    case 'denied':
      return {
        label: '已拒绝',
        tone: 'error',
        hint: `到「系统设置 › 隐私与安全性 › ${PANE_NAMES[pane]}」允许 Emperor，再回到这里`,
        canOpen: true,
      }
    case 'restricted':
      return {
        label: '受限制',
        tone: 'warn',
        hint: '这台 Mac 的管理设置不允许，请联系管理员',
        canOpen: false,
      }
    default:
      return {
        label: '未知',
        tone: 'neutral',
        hint: '听写组件可用后才能读到',
        canOpen: false,
      }
  }
}

export interface HelperView {
  badge: string
  tone: VoiceTone
  description: string
}

const ENGINE_NAMES: Readonly<Record<string, string>> = {
  'sf-speech': 'SFSpeechRecognizer',
  'speech-analyzer': 'SpeechAnalyzer',
}

/** null: still asking the helper. */
export function helperView(status: DictationStatus | null): HelperView {
  if (!status)
    return {
      badge: '检测中',
      tone: 'neutral',
      description: '正在连接 Emperor Dictation Helper…',
    }
  if (!status.available)
    return {
      badge: '不可用',
      tone: 'error',
      description: status.reason ?? '无法连接 Emperor Dictation Helper',
    }
  const engine = status.engine
    ? (ENGINE_NAMES[status.engine] ?? status.engine)
    : '本机识别'
  return {
    badge: status.active ? '听写中' : '可用',
    tone: 'ok',
    description: `本机识别 · ${engine}`,
  }
}

export interface ChoiceView {
  /** `''` is the default (system microphone, or follow the system). */
  options: SelectOption[]
  description: string
  /** Set when the row needs attention. */
  tone: VoiceTone | null
}

/** The helper is away: keep showing the saved choice, claim nothing else. */
function unknownChoice(
  defaultLabel: string,
  saved: SelectOption | null,
): ChoiceView {
  return {
    options: [{ value: '', label: defaultLabel }, ...(saved ? [saved] : [])],
    description: '听写组件可用后才能更改',
    tone: null,
  }
}

export function deviceChoice(
  status: DictationStatus,
  settings: DictationSettings,
): ChoiceView {
  if (!status.available)
    return unknownChoice(
      '系统默认',
      settings.device === null
        ? null
        : {
            value: settings.device,
            label: settings.deviceName ?? '选定的麦克风',
          },
    )
  const fallback = status.devices.find((device) => device.default)
  const options: SelectOption[] = [
    {
      value: '',
      label: fallback ? `系统默认（${fallback.name}）` : '系统默认',
    },
    ...status.devices.map((device) => ({
      value: device.id,
      label: device.name,
    })),
  ]
  const saved = settings.device
  if (saved !== null && !status.devices.some((device) => device.id === saved)) {
    options.push({
      value: saved,
      label: `${settings.deviceName ?? '选定的麦克风'}（未连接）`,
      description: '连接后自动使用',
    })
    return {
      options,
      description: '选定的麦克风没有连接，听写时先用系统默认',
      tone: 'warn',
    }
  }
  if (status.devices.length === 0)
    return { options, description: '没有找到麦克风', tone: 'error' }
  return { options, description: '听写时使用的麦克风', tone: null }
}

const MORE_LANGUAGES = '「系统设置 › 键盘 › 听写」'

export function localeChoice(
  status: DictationStatus,
  settings: DictationSettings,
): ChoiceView {
  if (!status.available)
    return unknownChoice(
      '跟随系统',
      settings.locale === null
        ? null
        : { value: settings.locale, label: settings.locale },
    )
  const followed = status.systemLocale
    ? resolveDictationLocale(null, status.systemLocale, status.locales)
    : null
  const options: SelectOption[] = [
    {
      value: '',
      label: followed ? `跟随系统（${followed.name}）` : '跟随系统',
    },
    ...status.locales.map((locale) => ({
      value: locale.id,
      label: locale.name,
    })),
  ]
  const saved = settings.locale
  if (saved !== null && !status.locales.some((locale) => locale.id === saved)) {
    options.push({
      value: saved,
      label: `${saved}（不能本机识别）`,
      description: '现在跟随系统',
    })
    return {
      options,
      description: '选定的语言在这台 Mac 上不能本机识别，听写时跟随系统',
      tone: 'warn',
    }
  }
  if (status.locales.length === 0)
    return {
      options,
      description: `这台 Mac 还没有能本机识别的语言：到${MORE_LANGUAGES}打开听写并添加语言`,
      tone: 'error',
    }
  if (saved === null && !followed)
    return {
      options,
      description: `系统语言不能在这台 Mac 上本机识别：选一门语言，或到${MORE_LANGUAGES}添加`,
      tone: 'warn',
    }
  return {
    options,
    description: `只列出这台 Mac 能在本机识别的语言；要更多语言，到${MORE_LANGUAGES}添加`,
    tone: null,
  }
}
