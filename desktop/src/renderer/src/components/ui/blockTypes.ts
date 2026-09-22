/** Shared prop shapes for the tool-body block primitives. */

/** One Tabs entry. */
export interface TabItem {
  id: string
  label: string
  disabled?: boolean
}

/** One line of a ReadBlock window. */
export interface ReadBlockLine {
  number: number
  text: string
}

/** One matching line inside a SearchBlock file group. */
export interface SearchLineMatch {
  lineNumber: number
  line: string
}

/** A SearchBlock file group (grep-style matches). */
export interface SearchFileGroup {
  path: string
  matches: SearchLineMatch[]
}

/** A WebBlock search source / citation. */
export interface WebSource {
  url: string
  title?: string
  snippet?: string
  publishedAt?: string
}

/** Only http(s) URLs become links; anything else renders as text. */
export function safeHref(url: string): string | undefined {
  try {
    const { protocol } = new URL(url)
    return protocol === 'http:' || protocol === 'https:' ? url : undefined
  } catch {
    return undefined
  }
}

/** Link label: explicit title, else hostname, else the raw URL. */
export function linkLabel(url: string, title?: string): string {
  if (title) return title
  try {
    const { hostname } = new URL(url)
    return hostname || url
  } catch {
    return url
  }
}
