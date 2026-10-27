/**
 * The Chat home's starters (MOD-03, preview A): five fixed openings under
 * the composer. Picking one only fills the composer with `draft` — it ends
 * with 「：」 where the user goes on typing — and never sends. The copy
 * follows docs/design/writing.md (heroSuggestionsCopy.test.ts).
 */
export interface HeroSuggestion {
  id: string
  /** The chip's text. */
  label: string
  /** What the composer gets. */
  draft: string
}

export const HERO_SUGGESTIONS: readonly HeroSuggestion[] = [
  {
    id: 'research',
    label: '调研一个话题',
    draft: '帮我调研这个话题，列出要点和信息来源：',
  },
  {
    id: 'polish',
    label: '润色一段文字',
    draft: '帮我润色下面这段文字，意思不变，读起来更顺：',
  },
  {
    id: 'translate',
    label: '翻译',
    draft: '把下面这段翻译成中文，原文是中文就翻成英文：',
  },
  {
    id: 'explain',
    label: '解释一个概念',
    draft: '用通俗的话给我解释这个概念，再举一个例子：',
  },
  {
    id: 'minutes',
    label: '整理会议记录',
    draft: '把下面的会议记录整理成要点、决定和待办：',
  },
]
