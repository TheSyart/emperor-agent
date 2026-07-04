/** 前端草稿会话（未落盘）的 id 前缀；core 与 renderer 共用此单一来源。 */
export const DRAFT_SESSION_PREFIX = 'draft:'

export function isDraftSessionId(id: string | null | undefined): boolean {
  return typeof id === 'string' && id.startsWith(DRAFT_SESSION_PREFIX)
}
