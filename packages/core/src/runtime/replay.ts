import { cleanString } from '../util/strings'

type RuntimeReplayRow = Record<string, unknown>

/**
 * Compacts only adjacent high-frequency projection events. Canonical journals
 * remain unchanged; unrelated events always break a compactable run.
 */
export function compactReplayEvents<Row extends RuntimeReplayRow>(
  rows: Row[],
): Row[] {
  const out: Row[] = []
  for (const row of rows) {
    const previous = out[out.length - 1]
    if (
      row.event === 'goal_runtime_update' &&
      previous?.event === 'goal_runtime_update' &&
      cleanString(previous.goal_id) === cleanString(row.goal_id)
    ) {
      out[out.length - 1] = row
      continue
    }
    if (
      row.event === 'plan_draft_delta' &&
      previous?.event === 'plan_draft_delta' &&
      planDeltaStreamKey(previous) === planDeltaStreamKey(row) &&
      String(previous.turn_id ?? '') === String(row.turn_id ?? '')
    ) {
      out[out.length - 1] = row
      continue
    }
    if (
      row.event === 'message_delta' &&
      previous?.event === 'message_delta' &&
      String(previous.turn_id ?? '') === String(row.turn_id ?? '')
    ) {
      out[out.length - 1] = {
        ...previous,
        delta: String(previous.delta ?? '') + String(row.delta ?? ''),
      } as Row
      continue
    }
    out.push(row)
  }
  return out
}

function planDeltaStreamKey(row: RuntimeReplayRow): string {
  const interaction = isRecord(row.interaction) ? row.interaction : {}
  const meta = isRecord(interaction.meta) ? interaction.meta : {}
  return (
    cleanString(meta.plan_stream_id) ||
    cleanString(interaction.parent_call_id) ||
    cleanString(row.tool_call_id) ||
    cleanString(interaction.id)
  )
}

function isRecord(value: unknown): value is RuntimeReplayRow {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
