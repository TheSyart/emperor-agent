/**
 * The contacts and groups as the Group mode shows them (GRP-05): one list
 * per window for the Group sidebar, the Group home, a contact's profile and
 * a single chat. Read from Core (`contacts.list`, `groups.list`) when the
 * first of them appears, and read again — a moment after the last change —
 * on `contacts_changed` and `groups_changed`, for as long as one of them is
 * on screen. Nothing here writes.
 */
import {
  getCurrentInstance,
  onBeforeUnmount,
  readonly,
  ref,
  shallowRef,
  type Ref,
} from 'vue'
import type {
  Contact,
  ContactsListing,
  CoreOperationResult,
} from '@emperor/core/api'
import { onCoreEvent } from '../../api/backend'
import { core } from '../../api/http'

export type GroupSummary = CoreOperationResult<'groups.list'>[number]
type ContactsReadOnly = NonNullable<ContactsListing['readOnly']>

/** How long a burst of changes waits before the lists are read again. */
const REFRESH_DELAY_MS = 60

const contacts = shallowRef<Contact[]>([])
const groups = shallowRef<GroupSummary[]>([])
const readOnlyState = shallowRef<ContactsReadOnly | null>(null)
const loaded = ref(false)
const failed = ref('')
let users = 0
let unsubscribe: (() => void) | null = null
let timer: ReturnType<typeof setTimeout> | null = null
let reading: Promise<void> | null = null
let generation = 0

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Each list on its own: groups that cannot be read leave the contacts. */
async function read(): Promise<void> {
  const run = ++generation
  const [listing, summaries] = await Promise.allSettled([
    core('contacts.list'),
    core('groups.list'),
  ])
  if (run !== generation) return
  if (listing.status === 'fulfilled') {
    const value = listing.value
    contacts.value = Array.isArray(value?.contacts) ? value.contacts : []
    readOnlyState.value = value?.readOnly ?? null
  }
  if (summaries.status === 'fulfilled')
    groups.value = Array.isArray(summaries.value)
      ? [...summaries.value].sort(
          (a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0),
        )
      : []
  const failure = [listing, summaries].find(
    (result) => result.status === 'rejected',
  )
  failed.value = failure ? errorText(failure.reason) : ''
  loaded.value = true
}

/** Read the lists now (one read at a time; a later call waits for it). */
function refresh(): Promise<void> {
  reading = (reading ?? Promise.resolve()).then(read, read)
  return reading
}

function schedule(): void {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = null
    void refresh()
  }, REFRESH_DELAY_MS)
}

function listen(): void {
  if (unsubscribe) return
  unsubscribe = onCoreEvent((input) => {
    const event = (input as { event?: unknown } | null)?.event
    if (event === 'contacts_changed' || event === 'groups_changed') schedule()
  })
}

function release(): void {
  users = Math.max(0, users - 1)
  if (users > 0) return
  unsubscribe?.()
  unsubscribe = null
  if (timer) clearTimeout(timer)
  timer = null
}

export interface ContactDirectory {
  contacts: Readonly<Ref<readonly Contact[]>>
  groups: Readonly<Ref<readonly GroupSummary[]>>
  readOnly: Readonly<Ref<ContactsReadOnly | null>>
  /** The lists were read once (even when that failed). */
  loaded: Readonly<Ref<boolean>>
  failed: Readonly<Ref<string>>
  refresh(): Promise<void>
  /** Read the lists unless they were read (or are being read). */
  ensure(): void
  find(id: string): Contact | undefined
}

function ensure(): void {
  if (!loaded.value && !reading) void refresh()
}

/**
 * The window's contacts and groups. Inside a component's setup it keeps
 * them fresh while the component lives; the first one reads them, unless
 * it is `lazy` (it reads them with `ensure()` once it needs them — the
 * conversation view, which shows a contact only in a single chat).
 */
export function useContactDirectory(
  options: { lazy?: boolean } = {},
): ContactDirectory {
  if (getCurrentInstance()) {
    users += 1
    listen()
    if (!options.lazy) ensure()
    onBeforeUnmount(release)
  }
  // The plain refs (no readonly proxy): what they hold may go to Core,
  // which cannot clone a proxy.
  return {
    contacts,
    groups,
    readOnly: readOnlyState,
    loaded: readonly(loaded),
    failed: readonly(failed),
    refresh,
    ensure,
    find: (id) => contacts.value.find((contact) => contact.id === id),
  }
}

/** Tests: forget everything, as a new window would. */
export function resetContactDirectoryForTest(): void {
  unsubscribe?.()
  unsubscribe = null
  if (timer) clearTimeout(timer)
  timer = null
  users = 0
  reading = null
  generation += 1
  contacts.value = []
  groups.value = []
  readOnlyState.value = null
  loaded.value = false
  failed.value = ''
}
