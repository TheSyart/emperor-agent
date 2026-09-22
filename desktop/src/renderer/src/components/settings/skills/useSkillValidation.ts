/**
 * Live SKILL.md validation: re-runs Core `skills.validate` (debounced) while
 * the input getter changes and keeps only the newest answer. A null input
 * clears the result (nothing to validate).
 */
import { onScopeDispose, ref, shallowRef, watch } from 'vue'
import { validateSkill, type SkillValidationResult } from '../../../api/skills'

export interface SkillValidationInput {
  content: string
  /** Intended folder name (a mismatch with the frontmatter warns). */
  name?: string | null
  sessionId?: string | null
}

export function useSkillValidation(
  input: () => SkillValidationInput | null,
  delay = 350,
) {
  const result = shallowRef<SkillValidationResult | null>(null)
  const pending = ref(false)
  const failure = ref('')
  let seq = 0
  let timer: ReturnType<typeof setTimeout> | null = null

  function clearTimer() {
    if (timer) clearTimeout(timer)
    timer = null
  }

  async function run(value: SkillValidationInput, id: number) {
    try {
      const next = await validateSkill(value)
      if (id !== seq) return
      result.value = next
      failure.value = ''
    } catch (error) {
      if (id !== seq) return
      result.value = null
      failure.value =
        error instanceof Error && error.message ? error.message : String(error)
    } finally {
      if (id === seq) pending.value = false
    }
  }

  watch(
    input,
    (value) => {
      clearTimer()
      const id = ++seq
      if (!value || !value.content.trim()) {
        result.value = null
        failure.value = ''
        pending.value = false
        return
      }
      pending.value = true
      timer = setTimeout(() => {
        timer = null
        void run(value, id)
      }, delay)
    },
    { immediate: true },
  )

  onScopeDispose(() => {
    clearTimer()
    seq += 1
  })

  return { result, pending, failure }
}
