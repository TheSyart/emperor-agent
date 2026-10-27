/**
 * 宫廷用语 (BRD-06): an optional, off-by-default way of putting a few of
 * Emperor's words. Only visible words change, and an action always keeps
 * its plain meaning — in the label (「准奏（允许本次）」) and as its
 * accessible name. Members' speeches in a group, conversation text, code
 * and costs never change. The switch is 设置 › 常规 › 外观 › 宫廷用语
 * (a per-Mac UI preference, useUiPreferences `courtlyCopy`). Pure.
 */
import type { AppMode } from '../runtime/appMode'

const HEADLINES: Readonly<Record<AppMode, string>> = {
  chat: '朕今日要办何事？',
  build: '今日推进哪桩差事？',
  group: '今日宣谁议事？',
}

export const COURTLY = Object.freeze({
  /** The composer's + menu item. */
  planMode: '内阁票拟（计划模式）',
  /** Group's primary sidebar button (its accessible name stays 新建群聊). */
  newGroup: '召集议事',
  /** Words on the stickers beside an approval (the picture carries none). */
  askSticker: '嗯？',
})

/** Everything this table changes: three headlines, two verbs and the above. */
export const COURTLY_ENTRIES =
  Object.keys(HEADLINES).length + 2 + Object.keys(COURTLY).length

/** A home's headline in court words (no 称呼: the court addresses no one). */
export function courtlyHeadline(mode: AppMode): string {
  return HEADLINES[mode]
}

/** An approval's button: 准奏 or 驳回, then what it does in plain words. */
export function courtlyAction(plain: string, deny: boolean): string {
  return `${deny ? '驳回' : '准奏'}（${plain}）`
}
