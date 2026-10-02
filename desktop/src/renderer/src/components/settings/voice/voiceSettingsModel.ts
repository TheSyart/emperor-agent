/**
 * Settings › 语音: what the page says about the dictation helper, the two
 * permissions and the microphone and language choices. Only devices and
 * languages the helper reports are offered; a saved choice that went away
 * stays in the list, marked, and the editor uses the default meanwhile
 * (dictation/model.ts `dictationRequest`).
 *
 * Anything that stops dictation (the helper unavailable, a permission
 * denied or restricted) is one notice for the top of the page, with the
 * fix (`voiceNotice`); the permission card at the end only reports, one
 * line while both permissions agree (`permissionRows`).
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

const PANES: readonly DictationPrivacyPane[] = ['microphone', 'speech']

function paneNames(panes: readonly DictationPrivacyPane[]): string {
  return panes.map((pane) => PANE_NAMES[pane]).join('和')
}

export interface PermissionRow {
  /** 'both': one line for two permissions in the same state. */
  id: 'both' | DictationPrivacyPane
  title: string
  description: string
  badge: string
  tone: VoiceTone
}

/** What each permission is for; a state that needs saying replaces it. */
const PERMISSION_PURPOSE: Readonly<
  Record<PermissionRow['id'], { title: string; purpose: string }>
> = {
  both: { title: '麦克风和语音识别', purpose: '只在听写时打开麦克风，不联网' },
  microphone: { title: '麦克风权限', purpose: '只在听写时打开麦克风' },
  speech: { title: '语音识别权限', purpose: '在这台 Mac 上识别，不联网' },
}

function permissionRow(
  id: PermissionRow['id'],
  state: DictationPermission,
): PermissionRow {
  const view = permissionView(id === 'both' ? 'microphone' : id, state)
  const { title, purpose } = PERMISSION_PURPOSE[id]
  return {
    id,
    title,
    // Not asked yet and restricted say what happens; how to fix a denied
    // one is the notice's job.
    description:
      state === 'undetermined' || state === 'restricted' ? view.hint : purpose,
    badge: view.label,
    tone: view.tone,
  }
}

/**
 * The 系统权限 card: one row while both permissions are in the same state
 * (「麦克风和语音识别 · 已允许」), a row each otherwise; none while the
 * helper cannot read them.
 */
export function permissionRows(
  status: DictationStatus | null,
): PermissionRow[] {
  if (!status?.supported || !status.available) return []
  const { microphone, speech } = status.permissions
  if (microphone === speech) return [permissionRow('both', microphone)]
  return [
    permissionRow('microphone', microphone),
    permissionRow('speech', speech),
  ]
}

export type VoiceNoticeAction =
  | { kind: 'open'; pane: DictationPrivacyPane; label: string }
  | { kind: 'retry'; label: string }

export interface VoiceNotice {
  id: 'helper' | 'permissions'
  tone: 'warn'
  title: string
  description: string
  actions: VoiceNoticeAction[]
}

/**
 * The one notice at the top of 设置 › 语音, while something stops dictation:
 * the helper unavailable first, then a denied or restricted permission.
 * `openFailed` names the list System Settings could not be opened at, so
 * the notice gives the way there by hand. Not asked yet is no problem:
 * macOS asks at the first dictation.
 */
export function voiceNotice(
  status: DictationStatus | null,
  openFailed: DictationPrivacyPane | null = null,
): VoiceNotice | null {
  if (!status?.supported) return null
  if (!status.available)
    return {
      id: 'helper',
      tone: 'warn',
      title: '听写组件不可用',
      description: helperView(status).description,
      actions: [{ kind: 'retry', label: '重新检测' }],
    }
  const denied = PANES.filter((pane) => status.permissions[pane] === 'denied')
  const restricted = PANES.filter(
    (pane) => status.permissions[pane] === 'restricted',
  )
  const managed = restricted.length
    ? `${paneNames(restricted)}受这台 Mac 的管理设置限制，请联系管理员。`
    : ''
  if (denied.length) {
    const where =
      denied.length === 1
        ? `「系统设置 › 隐私与安全性 › ${PANE_NAMES[denied[0]!]}」`
        : '「系统设置 › 隐私与安全性」的「麦克风」和「语音识别」'
    return {
      id: 'permissions',
      tone: 'warn',
      title: `听写需要${paneNames(denied)}权限`,
      description: `${
        openFailed ? `没能打开系统设置，请手动前往${where}` : `到${where}`
      }允许 Emperor，再回到这里。${managed}`,
      actions: denied.map((pane) => ({
        kind: 'open' as const,
        pane,
        label:
          denied.length === 1 ? '打开系统设置' : `打开${PANE_NAMES[pane]}设置`,
      })),
    }
  }
  if (restricted.length)
    return {
      id: 'permissions',
      tone: 'warn',
      title: `这台 Mac 不允许听写使用${paneNames(restricted)}`,
      description: '这是这台 Mac 的管理设置，请联系管理员。',
      actions: [],
    }
  return null
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
  // How to add more is in the manual (语音听写).
  return {
    options,
    description: '只列出这台 Mac 能在本机识别的语言',
    tone: null,
  }
}
