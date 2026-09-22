/**
 * Field → control channel. <Field> provides the control id, the ids that
 * describe it (hint / error) and the invalid flag; TextField, TextArea,
 * CodeEditor, Select and SearchField inject it so a label, hint and error
 * wire up (for / aria-describedby / aria-invalid) without manual ids.
 */
import { computed, inject, type ComputedRef, type InjectionKey } from 'vue'

export interface FieldContext {
  controlId: ComputedRef<string>
  describedBy: ComputedRef<string | undefined>
  invalid: ComputedRef<boolean>
}

export const FIELD_CONTEXT: InjectionKey<FieldContext> =
  Symbol('settings-field')

let seq = 0

/** Unique DOM id for settings controls (stable per component instance). */
export function settingsId(prefix: string): string {
  seq += 1
  return `${prefix}-${seq}`
}

/**
 * Control side: resolve the effective id / aria wiring from explicit props
 * first, then the surrounding <Field>, then a generated id.
 */
export function useFieldControl(
  props: { id?: string; invalid?: boolean },
  prefix: string,
) {
  const field = inject(FIELD_CONTEXT, null)
  const fallback = settingsId(prefix)
  const id = computed(() => props.id ?? field?.controlId.value ?? fallback)
  const describedBy = computed(() => field?.describedBy.value)
  const invalid = computed(() => Boolean(props.invalid || field?.invalid.value))
  return { id, describedBy, invalid }
}
