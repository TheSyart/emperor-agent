/**
 * The profile-interview prompt shows once (UI-S04): on the hero of the
 * first empty chat that opens while the interview is pending. That chat
 * keeps it for the rest of the window's life (until it is answered); other
 * chats never show it, and after a restart it is not offered again — the
 * interview stays in 设置 › 记忆 › 用户档案.
 */
export const PROFILE_PROMPT_KEY = 'emperor.profilePrompt.v1'

/** The chat whose hero shows the prompt in this window. */
let owner: string | null = null
let shownBefore = readShown()

function readShown(): boolean {
  try {
    return globalThis.localStorage?.getItem(PROFILE_PROMPT_KEY) === 'shown'
  } catch {
    return false
  }
}

function rememberShown(): void {
  try {
    globalThis.localStorage?.setItem(PROFILE_PROMPT_KEY, 'shown')
  } catch {
    // Storage blocked: the prompt may come back after a restart.
  }
}

/**
 * May the hero of `sessionId` show the prompt? The first chat that asks
 * gets it (and it is remembered as shown); the same chat keeps it.
 */
export function claimProfilePrompt(sessionId: string): boolean {
  if (!sessionId) return false
  if (owner !== null) return owner === sessionId
  if (shownBefore) return false
  owner = sessionId
  rememberShown()
  return true
}

/** Tests: forget this window's owner (and, unless kept, the stored flag). */
export function resetProfilePromptForTest(
  options: { keepStorage?: boolean } = {},
): void {
  owner = null
  if (!options.keepStorage) {
    try {
      globalThis.localStorage?.removeItem(PROFILE_PROMPT_KEY)
    } catch {
      // ignore
    }
  }
  shownBefore = readShown()
}
