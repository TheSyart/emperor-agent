import type { CoreOperationResult } from '@emperor/core/api'
export type ExternalHistoryPage = CoreOperationResult<'delegations.history'>
export type ExternalHistoryEntry = ExternalHistoryPage['entries'][number]
/** A route owns one feed; disposal fences every asynchronous result. */
export function createExternalHistoryFeed(options: {
  read: (input: {
    before?: string
    after?: string
  }) => Promise<ExternalHistoryPage>
  subscribe: (changed: () => void) => () => void
  update: (page: ExternalHistoryPage) => void
  error: (cause: unknown) => void
}) {
  let alive = true,
    dirty = false,
    scheduled = false,
    off = () => {},
    queue = Promise.resolve()
  let page: ExternalHistoryPage = {
    entries: [],
    before: null,
    after: null,
    hasBefore: false,
    hasAfter: false,
  }
  function apply(next: ExternalHistoryPage, older = false) {
    const unique = new Map<string, ExternalHistoryEntry>()
    for (const entry of older
      ? [...next.entries, ...page.entries]
      : [...page.entries, ...next.entries])
      unique.set(entry.id, entry)
    const entries = [...unique.values()]
    page = {
      entries,
      before: older || !page.before ? next.before : page.before,
      after: older ? page.after : (next.after ?? page.after),
      hasBefore: older || !page.before ? next.hasBefore : page.hasBefore,
      hasAfter: older ? page.hasAfter : next.hasAfter,
    }
    options.update(page)
  }
  function serial(task: () => Promise<void>) {
    queue = queue
      .then(async () => {
        if (alive) await task()
      })
      .catch((cause) => {
        if (alive) options.error(cause)
      })
    return queue
  }
  async function catchup() {
    do {
      dirty = false
      const next = await options.read(page.after ? { after: page.after } : {})
      if (!alive) return
      apply(next)
      if (next.hasAfter) dirty = true
    } while (alive && dirty)
  }
  function changed() {
    if (!alive) return
    dirty = true
    if (scheduled) return
    scheduled = true
    void serial(async () => {
      try {
        await catchup()
      } finally {
        scheduled = false
      }
    })
  }
  return {
    start() {
      off = options.subscribe(changed)
      return serial(async () => {
        const initial = await options.read({})
        if (!alive) return
        page = initial
        options.update(page)
        // A durable read after the first snapshot closes the subscribe/read race,
        // including a persisted append whose notification arrived during IPC.
        await catchup()
      })
    },
    older() {
      return serial(async () => {
        if (!page.hasBefore || !page.before) return
        const next = await options.read({ before: page.before })
        if (alive) apply(next, true)
      })
    },
    refresh() {
      return serial(catchup)
    },
    dispose() {
      alive = false
      off()
    },
  }
}
