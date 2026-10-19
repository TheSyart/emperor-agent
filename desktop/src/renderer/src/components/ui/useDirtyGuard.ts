/**
 * Unsaved-edit guard (UI-S07, UI-6). A shell that can drop an editor — the
 * settings modal (close, another section or sub page), the 能力 page (another
 * tab) — provides a host; every editor registers what it would lose:
 *
 *   useDirtyGuard('长期记忆', () => draft.value !== saved.value)
 *
 * Before the shell drops its content it calls `host.confirmDiscard()`: with
 * nothing edited it resolves true at once, otherwise it asks once through
 * confirm() (「放弃」 / 「继续编辑」, naming every edited editor). An editor
 * stops counting when it unmounts.
 *
 * `useDraft(source)` is the other half: a draft that follows its source
 * (a background refresh, another window's save) only while the user has not
 * edited it.
 */
import {
  computed,
  getCurrentScope,
  inject,
  onScopeDispose,
  provide,
  ref,
  shallowRef,
  toValue,
  watch,
  type ComputedRef,
  type InjectionKey,
  type MaybeRefOrGetter,
  type Ref,
} from 'vue'
import { confirm } from './confirm'

interface DirtySource {
  id: number
  label: () => string
  dirty: () => boolean
}

export interface DirtyGuardHost {
  /** Some registered editor has unsaved edits. */
  dirty: ComputedRef<boolean>
  /** Labels of the editors with unsaved edits, in registration order. */
  labels: ComputedRef<string[]>
  register: (label: () => string, dirty: () => boolean) => () => void
  /** True when the content may go: nothing edited, or the user chose 放弃. */
  confirmDiscard: () => Promise<boolean>
}

export const DIRTY_GUARD_KEY: InjectionKey<DirtyGuardHost> =
  Symbol('dirty-guard')

async function askDiscard(labels: readonly string[]): Promise<boolean> {
  const names = labels.map((label) => `「${label}」`).join('')
  return confirm({
    title: '放弃未保存的修改？',
    body: `${names || '这里'}有未保存的修改，离开后会丢失。`,
    confirmLabel: '放弃',
    cancelLabel: '继续编辑',
    tone: 'danger',
  })
}

export function createDirtyGuard(): DirtyGuardHost {
  const sources = shallowRef<DirtySource[]>([])
  let seq = 0
  const labels = computed(() =>
    sources.value
      .filter((source) => source.dirty())
      .map((source) => source.label()),
  )
  const dirty = computed(() => labels.value.length > 0)
  return {
    dirty,
    labels,
    register(label, isDirty) {
      const entry = { id: ++seq, label, dirty: isDirty }
      sources.value = [...sources.value, entry]
      return () => {
        sources.value = sources.value.filter((source) => source !== entry)
      }
    },
    confirmDiscard: () =>
      dirty.value ? askDiscard(labels.value) : Promise.resolve(true),
  }
}

/** Shell side: create the host for the subtree. */
export function provideDirtyGuard(): DirtyGuardHost {
  const host = createDirtyGuard()
  provide(DIRTY_GUARD_KEY, host)
  return host
}

/**
 * Editor side: count `dirty` under `label` while the calling component
 * lives. Without a host (an editor outside a guarded shell) the returned
 * `confirmDiscard` still asks about this editor alone.
 */
export function useDirtyGuard(
  label: MaybeRefOrGetter<string>,
  dirty: MaybeRefOrGetter<boolean>,
): { confirmDiscard: () => Promise<boolean> } {
  const host = inject(DIRTY_GUARD_KEY, null)
  const readLabel = () => toValue(label)
  const readDirty = () => toValue(dirty)
  if (host) {
    const unregister = host.register(readLabel, readDirty)
    if (getCurrentScope()) onScopeDispose(unregister)
  }
  return {
    confirmDiscard: () =>
      readDirty() ? askDiscard([readLabel()]) : Promise.resolve(true),
  }
}

export interface Draft {
  /** The text being edited (v-model). */
  text: Ref<string>
  /** It differs from the latest source. */
  dirty: ComputedRef<boolean>
  /** Drop the edit: back to the latest source. */
  reset: () => void
}

/**
 * A draft of `source` that takes every new source value while it is
 * unedited and keeps the user's edit otherwise. Saving makes the source
 * catch up with the draft, which is then clean again.
 */
export function useDraft(source: () => string): Draft {
  const base = ref(source())
  const text = ref(base.value)
  watch(source, (next) => {
    if (text.value === base.value) text.value = next
    base.value = next
  })
  return {
    text,
    dirty: computed(() => text.value !== base.value),
    reset: () => {
      text.value = base.value
    },
  }
}
