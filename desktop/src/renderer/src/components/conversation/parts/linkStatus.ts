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
  id?: string
  kind: 'project_file' | 'external_file' | 'web'
  available: boolean
  directory?: boolean
  tooltip: string
  relativePath?: string
}

export interface LinkStatusSource {
  /** Bumps when statuses may have changed: rendered links check again. */
  readonly version: Readonly<Ref<number>>
  /** The status of a file link; null when Core cannot tell. */
  status(href: string, sourceMessageId?: string): Promise<LinkStatus | null>
  /** A data URL for an image file link the session owns; null otherwise. */
  image?(href: string, sourceMessageId?: string): Promise<string | null>
}

export const LINK_STATUS_KEY: InjectionKey<LinkStatusSource> =
  Symbol('link-status')

const MAX_IN_FLIGHT = 4
const MAX_IMAGES = 24

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
  readImage?: (reference: ResolvedLink) => Promise<string | null>,
): LinkStatusSource & {
  image(href: string, sourceMessageId?: string): Promise<string | null>
  refresh(): void
  record(href: string, reference: ResolvedLink, sourceMessageId?: string): void
} {
  const version = ref(0)
  // Keyed by message and href: the same path in two messages is two
  // references, each bound to its own source.
  let known = new Map<string, Promise<ResolvedLink>>()
  let images = new Map<string, Promise<string | null>>()
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

  const keyOf = (href: string, sourceMessageId?: string) =>
    `${sourceMessageId ?? ''}\0${href}`
  function reference(href: string, sourceMessageId?: string) {
    const key = keyOf(href, sourceMessageId)
    let pending = known.get(key)
    if (!pending) {
      pending = limited(() => resolve(href, sourceMessageId))
      known.set(key, pending)
    }
    return pending
  }

  return {
    version,
    status(href, sourceMessageId) {
      return reference(href, sourceMessageId).then(linkStatusOf, () => null)
    },
    image(href, sourceMessageId) {
      const key = keyOf(href, sourceMessageId)
      let pending = images.get(key)
      if (!pending) {
        const generation = version.value
        pending = reference(href, sourceMessageId)
          .then(async (value) => {
            if (
              generation !== version.value ||
              !readImage ||
              !value.available ||
              value.directory ||
              value.kind === 'web'
            )
              return null
            const src = await limited(() => readImage(value))
            return generation === version.value ? src : null
          })
          .catch(() => null)
        images.set(key, pending)
        while (images.size > MAX_IMAGES)
          images.delete(images.keys().next().value!)
      }
      return pending
    },
    refresh() {
      known = new Map()
      images = new Map()
      version.value += 1
    },
    record(href, reference, sourceMessageId) {
      known.set(keyOf(href, sourceMessageId), Promise.resolve(reference))
      images = new Map()
      version.value += 1
    },
  }
}
