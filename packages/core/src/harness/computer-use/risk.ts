/**
 * High-impact heuristics (spec 00 §6.3). A click on — or Enter into — an
 * element whose name reads like paying, ordering, deleting, sending or
 * publishing is escalated to `high-impact`, which always needs a one-time
 * confirmation, even under full access.
 *
 * This is a heuristic first pass, not a guarantee: it cannot recognise
 * every consequential action from names alone. The UI says so, and the
 * confirmation card plus result observation remain the real safeguards.
 */

const HIGH_IMPACT_NAME =
  /\b(pay|payment|buy|purchase|order|checkout|place order|confirm order|delete|remove account|close account|send|publish|post|tweet|transfer|withdraw|donate|subscribe|unsubscribe|install|uninstall|share|invite|grant access|revoke|don[’']t save|discard)\b|付款|支付|购买|下单|提交订单|确认订单|结算|删除|注销|发送|发布|发表|转账|提现|捐赠|订阅|安装|卸载|分享|授权|不存储|不保存|丢弃|放弃更改/i

export interface RiskInput {
  readonly toolName: string
  /** Role and name of the element the action targets, from the last observation. */
  readonly element?: { readonly role: string; readonly name: string }
  /** For `press`: the key combination. */
  readonly key?: string
}

export type HighImpactClassifier = (input: RiskInput) => boolean

/**
 * Menu commands that end the app, the session or data, in addition to the
 * above. Closing a window is ordinary: the app itself asks about unsaved
 * work, and the button that discards it is high impact by name.
 */
const HIGH_IMPACT_MENU =
  /\b(quit|log ?out|sign ?out|restart|shut ?down|empty trash|erase|reset|revert)\b|退出|注销|登出|重新启动|关机|清倒|抹掉|重置|还原/i

/**
 * Shortcuts that quit, delete or log out whatever has focus, with modifiers
 * in alphabetical order (see `chordKey`). A background app runs the menu
 * command a shortcut stands for, so these ask like those commands.
 */
const HIGH_IMPACT_CHORDS: ReadonlySet<string> = new Set([
  'meta+q',
  'meta+backspace',
  'meta+delete',
  'meta+option+backspace',
  'meta+option+delete',
  'meta+shift+q',
  'meta+shift+backspace',
  'meta+shift+delete',
  'meta+option+escape',
  'meta+option+shift+escape',
])

const MODIFIER_NAMES: Readonly<Record<string, string>> = {
  meta: 'meta',
  command: 'meta',
  cmd: 'meta',
  alt: 'option',
  option: 'option',
  control: 'control',
  ctrl: 'control',
  shift: 'shift',
}

/** `Command+Shift+Q` → `meta+shift+q`: modifiers named one way, sorted. */
export function chordKey(key: string): string {
  const parts = key
    .split('+')
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part !== '')
  const last = parts.at(-1) ?? ''
  const modifiers = parts
    .slice(0, -1)
    .map((part) => MODIFIER_NAMES[part] ?? part)
    .sort()
  return [...modifiers, last].join('+')
}

export const defaultHighImpactClassifier: HighImpactClassifier = (input) => {
  if (
    input.toolName.endsWith('_press') &&
    input.key !== undefined &&
    HIGH_IMPACT_CHORDS.has(chordKey(input.key))
  )
    return true
  const element = input.element
  if (element === undefined) return false
  const named = HIGH_IMPACT_NAME.test(element.name)
  if (input.toolName.endsWith('_menu_select'))
    return named || HIGH_IMPACT_MENU.test(element.name)
  if (input.toolName.endsWith('_click')) return named
  if (input.toolName.endsWith('_press'))
    return named && /^(enter|return|space)$/i.test(input.key ?? '')
  return false
}
