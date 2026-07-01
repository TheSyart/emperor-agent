export function composerSendDisabled(opts: { busy: boolean; content: string; attachmentCount: number }): boolean {
  if (opts.busy) return false
  return !opts.content.trim() && opts.attachmentCount === 0
}
