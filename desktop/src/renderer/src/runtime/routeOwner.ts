import type { SessionLineage } from '@emperor/core/runtime-contract'

/** Native readonly views retain their readable top-level root as the control owner. */
export function routeOwnerFromLineage(
  target: string,
  lineage: SessionLineage,
  knownRoot: (id: string) => boolean,
): string | undefined {
  if (target.startsWith('dlg-') || target.startsWith('dgr-')) return undefined
  const chain = lineage.chain
  if (chain.length < 2 || chain[chain.length - 1]?.sessionId !== target)
    return undefined
  const ids = chain.map((entry) => entry.sessionId)
  if (new Set(ids).size !== ids.length) return undefined
  return knownRoot(ids[0]) ? ids[0] : undefined
}

/** Discard stale owner reads and serialize activation side effects across rapid navigation. */
export function createRouteOwnerController(input: {
  resolve: (id: string) => Promise<string | undefined>
  activate: (id: string) => Promise<void>
  isActive: (id: string) => boolean
}) {
  let revision = 0
  let tail = Promise.resolve()
  function cancel(): void {
    revision++
  }
  async function sync(id: string): Promise<void> {
    const request = ++revision
    let owner: string | undefined
    try {
      owner = await input.resolve(id)
    } catch {
      return
    }
    if (!owner || request !== revision) return
    tail = tail
      .catch(() => undefined)
      .then(async () => {
        if (request !== revision || !owner || input.isActive(owner)) return
        await input.activate(owner)
      })
    await tail
  }
  return { sync, cancel }
}
