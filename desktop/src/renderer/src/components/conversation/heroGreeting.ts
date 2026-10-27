/**
 * The empty session's words, by mode (UI-S17, MOD-03, docs/design/modes.md
 * § 首页). Chat greets by the profile's 称呼 — 「小周，今天想聊点什么？」, a
 * long name cut to 12 characters — and stays 「今天想聊点什么？」 without
 * one; Build asks for a project and Group for someone, never by name. Build
 * and Group say in one line under the headline how they work.
 */
import type { AppMode } from '../../runtime/appMode'

const QUESTION: Record<AppMode, string> = {
  chat: '今天想聊点什么？',
  build: '今天推进哪个项目？',
  group: '今天找谁帮忙？',
}

const NOTE: Record<AppMode, string> = {
  chat: '',
  build: '构建会话都在某个项目文件夹里运行，可以读写文件、跑命令。',
  group: '@ 一位联系人就是单聊；@ 几位，会建一个临时群。',
}

const PLACEHOLDER: Record<AppMode, string> = {
  chat: '问任何问题，或者让我写点什么；/ 调用技能，@ 引用插件',
  build: '描述要做的改动，或者粘贴报错；/ 调用技能，@ 引用插件',
  group: '@ 提到联系人，说说要做什么',
}

const NAME_LIMIT = 12

export function heroHeadline(
  addressName: string | null | undefined,
  mode: AppMode = 'chat',
): string {
  const question = QUESTION[mode]
  const name = String(addressName ?? '').trim()
  if (mode !== 'chat' || !name) return question
  const chars = Array.from(name)
  const short =
    chars.length > NAME_LIMIT ? `${chars.slice(0, NAME_LIMIT).join('')}…` : name
  return `${short}，${question}`
}

/** The line under the headline ('' for Chat). */
export function heroNote(mode: AppMode): string {
  return NOTE[mode]
}

/** The composer's placeholder on the home. */
export function heroPlaceholder(mode: AppMode): string {
  return PLACEHOLDER[mode]
}
