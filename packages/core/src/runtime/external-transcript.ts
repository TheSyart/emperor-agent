export interface ExternalTranscriptEntry {
  role: string
  content: string
}
/** Presentation only; raw transcript entries retain their paging offsets. */
export function mergeExternalTranscript(
  entries: readonly ExternalTranscriptEntry[],
): ExternalTranscriptEntry[] {
  const merged: ExternalTranscriptEntry[] = []
  for (const entry of entries) {
    const previous = merged.at(-1)
    if (entry.role === 'assistant' && previous?.role === 'assistant')
      previous.content += entry.content
    else merged.push({ ...entry })
  }
  return merged
}
