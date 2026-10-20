/**
 * The HTML parser (parse5), loaded on first use: only web_fetch, link
 * previews and site icons parse HTML, so it stays out of the main
 * process's startup bundle.
 */

type Parse5 = typeof import('parse5')

let loading: Promise<Parse5> | null = null

export function htmlParser(): Promise<Parse5> {
  loading ??= import('parse5')
  return loading
}
