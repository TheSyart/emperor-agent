/**
 * Sizing rules of the 终端 pane (FIX-05, UI-10 / UI-35).
 *
 * - Below TERMINAL_MIN_COLS × TERMINAL_MIN_ROWS the pane is being hidden or
 *   squeezed (the workspace column animating shut, a narrow window): the
 *   terminal keeps its size instead of fitting, so the PTY never reflows its
 *   output to two columns.
 * - Fits wait until the size has settled for TERMINAL_RESIZE_DEBOUNCE_MS,
 *   and the PTY hears only about a size it has not been sent yet.
 * - xterm measures glyphs on a canvas, which cannot resolve CSS `var()`:
 *   it gets the font family as computed by the page.
 */

export const TERMINAL_MIN_COLS = 20
export const TERMINAL_MIN_ROWS = 5
export const TERMINAL_RESIZE_DEBOUNCE_MS = 100

const FALLBACK_MONO_FONT = "ui-monospace, 'SF Mono', Menlo, monospace"

export interface TerminalSize {
  cols: number
  rows: number
}

/** A proposed size the terminal may fit to (never a squeezed one). */
export function fitAllowed(
  size: TerminalSize | undefined | null,
): size is TerminalSize {
  return Boolean(
    size &&
    Number.isFinite(size.cols) &&
    Number.isFinite(size.rows) &&
    size.cols >= TERMINAL_MIN_COLS &&
    size.rows >= TERMINAL_MIN_ROWS,
  )
}

/**
 * The font family xterm should use: the computed `--font-mono` of the
 * document (the design token, any `var()` inside already substituted), else
 * the element's computed `font-family` (the surface sets the same token),
 * else a system monospace stack. Never a `var()` reference.
 */
export function terminalFontFamily(element?: Element | null): string {
  const candidates = [
    getComputedStyle(document.documentElement).getPropertyValue('--font-mono'),
    element ? getComputedStyle(element).fontFamily : '',
  ]
  for (const raw of candidates) {
    const family = raw?.trim()
    if (family && !family.includes('var(')) return withMonospace(family)
  }
  return FALLBACK_MONO_FONT
}

function withMonospace(family: string): string {
  return /(?:^|,)\s*monospace\s*$/.test(family)
    ? family
    : `${family}, monospace`
}
