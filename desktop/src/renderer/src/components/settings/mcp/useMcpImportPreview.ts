/**
 * Debounced dry-run of `mcp.importServers` for the 「添加」 dialog: every
 * change of the pasted text / form object re-plans the import (stale replies
 * dropped), the per-conflict 「覆盖」 choice is kept as `overwrite` names, and
 * `commit()` performs the real import with exactly those names.
 *
 * The preview asks Core with `overwrite: true` so a conflicting server that
 * would change reports `update` (overwritable) while an identical one still
 * reports `skip`; see mcpPreviewRows.
 */
import { computed, onScopeDispose, ref, shallowRef, watch } from 'vue'
import {
  importMcpServers,
  previewMcpImport,
  type McpImportRaw,
  type McpImportResult,
} from '../../../api/mcp'
import { mcpImportableCount, mcpPreviewRows, pruneOverwrite } from './mcpModel'

export const MCP_PREVIEW_DEBOUNCE_MS = 350

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  return typeof error === 'string' && error ? error : '无法识别 MCP 配置'
}

function keyOf(raw: McpImportRaw): string {
  return typeof raw === 'string' ? `text:${raw}` : `json:${JSON.stringify(raw)}`
}

export function useMcpImportPreview(
  source: () => McpImportRaw | null,
  options: { debounceMs?: number } = {},
) {
  const debounceMs = options.debounceMs ?? MCP_PREVIEW_DEBOUNCE_MS
  const plan = shallowRef<McpImportResult | null>(null)
  const error = ref('')
  const pending = ref(false)
  const importing = ref(false)
  const overwrite = ref<string[]>([])
  let timer: ReturnType<typeof setTimeout> | undefined
  let seq = 0
  let lastKey = ''

  function clear() {
    clearTimeout(timer)
    timer = undefined
    seq += 1
    lastKey = ''
    plan.value = null
    error.value = ''
    pending.value = false
  }

  async function run(raw: McpImportRaw) {
    const id = ++seq
    pending.value = true
    try {
      const result = await previewMcpImport(raw, { overwrite: true })
      if (id !== seq) return
      plan.value = result
      error.value = ''
      overwrite.value = pruneOverwrite(result, overwrite.value)
    } catch (cause) {
      if (id !== seq) return
      plan.value = null
      error.value = errorMessage(cause)
    } finally {
      if (id === seq) pending.value = false
    }
  }

  function schedule(raw: McpImportRaw | null, immediate = false) {
    if (raw === null) {
      clear()
      return
    }
    // An equal raw (e.g. an empty header row added) keeps the pending run.
    const key = keyOf(raw)
    if (key === lastKey && !immediate) return
    clearTimeout(timer)
    timer = undefined
    lastKey = key
    seq += 1
    pending.value = true
    if (immediate) void run(raw)
    else timer = setTimeout(() => void run(raw), debounceMs)
  }

  watch(source, (raw) => schedule(raw), { immediate: true })
  onScopeDispose(() => clearTimeout(timer))

  const rows = computed(() => mcpPreviewRows(plan.value, overwrite.value))
  const importable = computed(() => mcpImportableCount(rows.value))
  const warnings = computed(() => plan.value?.warnings ?? [])
  const canImport = computed(
    () =>
      !pending.value &&
      !importing.value &&
      !error.value &&
      importable.value > 0 &&
      source() !== null,
  )

  function setOverwrite(name: string, value: boolean) {
    const next = overwrite.value.filter((item) => item !== name)
    if (value) next.push(name)
    overwrite.value = next
  }

  /** Re-plan now (skipping the debounce), e.g. after the stored config changed. */
  function refresh() {
    schedule(source(), true)
  }

  /** Real import with the chosen overwrite names. */
  async function commit(): Promise<McpImportResult> {
    const raw = source()
    if (raw === null) throw new Error('没有可导入的 MCP 配置')
    importing.value = true
    try {
      return await importMcpServers(
        raw,
        overwrite.value.length ? { overwrite: [...overwrite.value] } : {},
      )
    } finally {
      importing.value = false
    }
  }

  function reset() {
    clear()
    overwrite.value = []
    importing.value = false
  }

  return {
    plan,
    rows,
    warnings,
    error,
    pending,
    importing,
    importable,
    canImport,
    overwrite,
    setOverwrite,
    refresh,
    commit,
    reset,
  }
}

export type McpImportPreviewState = ReturnType<typeof useMcpImportPreview>
