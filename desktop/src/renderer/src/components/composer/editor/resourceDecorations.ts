import { Plugin, PluginKey } from 'prosemirror-state'
import type { Node } from 'prosemirror-model'
import { Decoration, DecorationSet } from 'prosemirror-view'
import { resourceUrlSpans } from '../../conversation/resources/resourceModel'
import {
  cachedSiteIcon,
  onSiteIconsChanged,
} from '../../conversation/resources/siteIcons'
const key = new PluginKey<{ composing: boolean; decorations: DecorationSet }>(
  'resource-url-decorations',
)
function decorate(doc: Node): DecorationSet {
  const decorations: Decoration[] = []
  let text = ''
  const runs: Array<{ start: number; end: number; position: number }> = []
  doc.forEach((paragraph, offset, index) => {
    if (index > 0) text += '\n'
    paragraph.forEach((node, inlineOffset) => {
      const start = text.length
      // A chip occupies one document position. Never decorate through it.
      text += node.isText ? (node.text ?? '') : '\uFFFC'
      if (node.isText)
        runs.push({
          start,
          end: text.length,
          position: offset + inlineOffset + 1,
        })
    })
  })
  for (const span of resourceUrlSpans(text, 'composer')) {
    const icon = cachedSiteIcon(span.resource.href)
    const run = runs.find(
      (run) => span.start >= run.start && span.end <= run.end,
    )
    if (run)
      decorations.push(
        Decoration.inline(
          run.position + span.start - run.start,
          run.position + span.end - run.start,
          {
            class: 'composer-url-decoration',
            'data-resource-kind': span.resource.kind,
            ...(icon
              ? {
                  'data-site-icon': 'ready',
                  style: `--composer-site-icon: url("${icon}")`,
                }
              : {}),
            ...(span.resource.kind === 'web'
              ? {
                  'data-site-letter': new URL(span.resource.href).hostname
                    .replace(/^www\./, '')
                    .slice(0, 1)
                    .toUpperCase(),
                }
              : {}),
            title: span.resource.subtitle,
          },
        ),
      )
  }
  return DecorationSet.create(doc, decorations)
}
const REDECORATE = 'resource-redecorate'
/** Pause after typing before the full Markdown pass re-detects resources. */
export const REDECORATE_DELAY_MS = 120
export const resourceDecorationPlugin = new Plugin({
  key,
  state: {
    init: (_, state) => ({
      composing: false,
      decorations: decorate(state.doc),
    }),
    apply(tr, previous) {
      const composing =
        (tr.getMeta(key) as boolean | undefined) ?? previous.composing
      return {
        composing,
        decorations: composing
          ? DecorationSet.empty
          : composing !== previous.composing ||
              tr.getMeta('site-icon-refresh') ||
              tr.getMeta(REDECORATE)
            ? decorate(tr.doc)
            : tr.docChanged
              ? // Typing only maps the old marks; a full Markdown pass runs
                // once the user pauses (see the view below).
                previous.decorations.map(tr.mapping, tr.doc)
              : previous.decorations,
      }
    },
  },
  view(view) {
    let timer: ReturnType<typeof setTimeout> | null = null
    const schedule = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        if (!view.composing && !view.isDestroyed)
          view.dispatch(
            view.state.tr
              .setMeta(REDECORATE, true)
              .setMeta('addToHistory', false),
          )
      }, REDECORATE_DELAY_MS)
    }
    const stop = onSiteIconsChanged(() => {
      if (!view.composing)
        view.dispatch(
          view.state.tr
            .setMeta('site-icon-refresh', true)
            .setMeta('addToHistory', false),
        )
    })
    return {
      update(next, previousState) {
        if (!next.state.doc.eq(previousState.doc)) schedule()
      },
      destroy() {
        if (timer) clearTimeout(timer)
        stop()
      },
    }
  },
  props: {
    decorations(state) {
      return key.getState(state)?.decorations ?? DecorationSet.empty
    },
    handleDOMEvents: {
      compositionstart(view) {
        view.dispatch(view.state.tr.setMeta(key, true))
        return false
      },
      compositionend(view) {
        view.dispatch(view.state.tr.setMeta(key, false))
        return false
      },
    },
  },
})
