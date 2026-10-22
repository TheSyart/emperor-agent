/**
 * The empty chat's headline (UI-S17): with the profile's 称呼 it greets the
 * user by name — 「小周，今天想推进什么？」; a long name is cut to 12
 * characters. Without one it stays 「今天想推进什么？」.
 */
const QUESTION = '今天想推进什么？'
const NAME_LIMIT = 12

export function heroHeadline(addressName: string | null | undefined): string {
  const name = String(addressName ?? '').trim()
  if (!name) return QUESTION
  const chars = Array.from(name)
  const short =
    chars.length > NAME_LIMIT ? `${chars.slice(0, NAME_LIMIT).join('')}…` : name
  return `${short}，${QUESTION}`
}
