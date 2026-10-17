import { provide, watch } from 'vue'
import { invokeCore, openExternal, revealReference } from '../../api/backend'
import { createLinkStatusSource, LINK_STATUS_KEY } from './parts/linkStatus'
/** Each external output has its own relative-path capability and image cache. */
export function provideDelegationLinks(
  scope: () => { sessionId: string; delegationId: string },
) {
  const links = createLinkStatusSource(
    (href) =>
      invokeCore('references.resolve', {
        ...scope(),
        sourceMessageId: 'delegation-output',
        href,
        label: href,
      }),
    async (reference) => {
      if (!reference.id) return null
      const image = await invokeCore('references.image', {
        sessionId: scope().sessionId,
        referenceId: reference.id,
      })
      return image.kind === 'image' &&
        !image.truncated &&
        image.dataBase64 &&
        /^image\/(png|jpeg|gif|webp)$/.test(image.mimeType)
        ? `data:${image.mimeType};base64,${image.dataBase64}`
        : null
    },
  )
  provide(LINK_STATUS_KEY, links)
  watch(
    () => [scope().sessionId, scope().delegationId],
    () => links.refresh(),
  )
  async function click(event: Event) {
    const anchor = (event.target as HTMLElement | null)?.closest(
      'a.md-link-chip',
    )
    if (!(anchor instanceof HTMLAnchorElement)) return
    event.preventDefault()
    event.stopPropagation()
    const href = anchor.getAttribute('href')
    if (!href) return
    try {
      const reference = await invokeCore('references.resolve', {
        ...scope(),
        sourceMessageId: 'delegation-output',
        href,
        label: anchor.textContent?.trim() || href,
      })
      links.record(href, reference)
      if (!reference.available) return
      if (reference.actions.includes('reveal'))
        await revealReference({
          sessionId: scope().sessionId,
          referenceId: reference.id,
        })
      else if (reference.actions.includes('open_external'))
        await openExternal(reference.tooltip)
    } catch {
      /* A stale capability stays inert. */
    }
  }
  return { links, click }
}
