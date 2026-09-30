/**
 * The GUI tools as the Computer Use plugin's detail lists them (plugin
 * contract §6.2): the four factories' own definitions — name, description,
 * argument schema — taken with a runtime that never runs anything, so they
 * are listed while computer use is off too. `readOnly` follows the catalog:
 * a plan-safe tool that only looks, lists or waits.
 */

import type { ToolDefinition } from '../../tools/definition'
import type { ComputerUseService } from '../service/service'
import type { GateDeps } from '../gate'
import { createBrowserTools } from './browser-tools'
import { GUI_TOOL_CATALOG } from './catalog'
import { createDesktopTools } from './desktop-tools'
import { createExternalTools } from './external-tools'
import type { ToolRuntime } from './runtime'
import { createUiTools } from './ui-tools'

/** `ui`: the tools of every driver; the others name the driver they drive. */
export type GuiToolFamily =
  'ui' | 'embedded-browser' | 'external-browser' | 'desktop'

export interface GuiToolListing {
  readonly family: GuiToolFamily
  readonly tools: ReadonlyArray<{
    readonly name: string
    readonly description: string
    readonly parameters: Record<string, unknown>
    readonly readOnly: boolean
  }>
}

const FAMILIES: ReadonlyArray<
  readonly [GuiToolFamily, (runtime: ToolRuntime) => ToolDefinition[]]
> = [
  ['ui', createUiTools],
  ['embedded-browser', createBrowserTools],
  ['external-browser', createExternalTools],
  ['desktop', createDesktopTools],
]

/** Any use of it throws: listing reads definitions and runs nothing. */
function inert<T extends object>(what: string): T {
  return new Proxy({} as T, {
    get() {
      throw new Error(`the GUI tool listing never uses the ${what}`)
    },
  })
}

function refuse(): never {
  throw new Error('the GUI tool listing never runs a tool')
}

let listing: readonly GuiToolListing[] | null = null

/** The GUI tools by family, in driver order (they never change, so once). */
export function listGuiTools(): readonly GuiToolListing[] {
  if (listing !== null) return listing
  const runtime: ToolRuntime = {
    service: inert<ComputerUseService>('computer use service'),
    gate: inert<GateDeps>('gate'),
    identity: refuse,
    vision: refuse,
  }
  listing = FAMILIES.map(([family, create]) => ({
    family,
    tools: create(runtime).map((tool) => {
      const entry = GUI_TOOL_CATALOG[tool.name]
      return {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        readOnly: entry?.planSafe === true && entry.kind !== 'control',
      }
    }),
  }))
  return listing
}
