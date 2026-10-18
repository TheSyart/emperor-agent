/**
 * What local file links in the conversation point at now (E-track contract
 * §4): a file, a directory, or nothing. ConversationView provides one source
 * per session; each MarkdownHtml asks it about the file links it renders and
 * marks missing files and folders. Core resolves each link once until the
 * source is refreshed (a new session, the end of a turn); a click resolves
 * afresh and records what it learned.
 */
import { ref, type InjectionKey, type Ref } from 'vue'

export interface LinkStatus {
  state: 'file' | 'directory' | 'missing'
  /** The full path to show on hover. */
  path: string
}

/** The parts of a Core reference descriptor a status is made from. */
export interface ResolvedLink {
  kind: 'project_file' | 'external_file' | 'web'
  available: boolean
  directory?: boolean
  tooltip: string
}

export interface LinkStatusSource {
  /** Bumps when statuses may have changed: rendered links check again. */
  readonly version: Readonly<Ref<number>>
  /** The status of a file link; null when Core cannot tell. */
  status(href: string, sourceMessageId?: string): Promise<LinkStatus | null>
}

export const LINK_STATUS_KEY: InjectionKey<LinkStatusSource> =
  Symbol('link-status')

const MAX_IN_FLIGHT = 4

export function linkStatusOf(reference: ResolvedLink): LinkStatus | null {
  if (reference.kind === 'web') return null
  const state = !reference.available
    ? 'missing'
    : reference.directory
      ? 'directory'
      : 'file'
  return { state, path: reference.tooltip }
}

export function createLinkStatusSource(
  resolve: (href: string, sourceMessageId?: string) => Promise<ResolvedLink>,
): LinkStatusSource & {
  refresh(): void
  record(href: string, reference: ResolvedLink, sourceMessageId?: string): void
} {
  const version = ref(0)
  let known = new Map<string, Promise<LinkStatus | null>>()
  let inFlight = 0
  const waiting: Array<() => void> = []

  async function limited<T>(task: () => Promise<T>): Promise<T> {
    if (inFlight >= MAX_IN_FLIGHT)
      await new Promise<void>((start) => waiting.push(start))
    inFlight += 1
    try {
      return await task()
    } finally {
      inFlight -= 1
      waiting.shift()?.()
    }
  }

  return {
    version,
    status(href, sourceMessageId) {
      const key = `${sourceMessageId ?? ''}\0${href}`
      let status = known.get(key)
      if (!status) {
        status = limited(() => resolve(href, sourceMessageId)).then(
          linkStatusOf,
          () => null,
        )
        known.set(key, status)
      }
      return status
    },
    refresh() {
      known = new Map()
      version.value += 1
    },
    record(href, reference, sourceMessageId) {
      known.set(
        `${sourceMessageId ?? ''}\0${href}`,
        Promise.resolve(linkStatusOf(reference)),
      )
      version.value += 1
    },
  }
}
