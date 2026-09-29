/**
 * Semantic snapshot of an Agent tab (spec 00 §5.2–5.4, §7.3): the
 * accessibility tree of the main frame, its same-process frames and every
 * cross-origin (OOPIF) frame the driver attached to (E-B3: each OOPIF is a
 * CDP child session with its own frame tree and AX tree), walked in document
 * order, reduced to meaningful elements with unified roles,
 * `r<revision>.<n>` refs, states, page-relative bounds, and secret values
 * masked at extraction. An OOPIF the driver has no session for is noted.
 */

import { looksSensitive } from '@emperor/core/host-capabilities'
import type { UiElement, UiRole } from '@emperor/core/runtime-contract'
import type { IsolatedWorlds } from './isolated'
import type { CdpSession } from './session'

export interface AxValue {
  readonly type?: string
  readonly value?: unknown
}

export interface AxNode {
  readonly nodeId: string
  readonly ignored?: boolean
  readonly role?: AxValue
  readonly name?: AxValue
  readonly value?: AxValue
  readonly properties?: ReadonlyArray<{
    readonly name: string
    readonly value: AxValue
  }>
  readonly parentId?: string
  readonly childIds?: readonly string[]
  readonly backendDOMNodeId?: number
  readonly frameId?: string
}

/** What a ref points at, kept by the driver for the last few revisions. */
export interface RefTarget {
  readonly backendNodeId: number
  readonly frameId: string
  /** CDP child session of a cross-origin frame (absent: the page itself). */
  readonly sessionId?: string
  readonly role: UiRole
  readonly name: string
  readonly secret: boolean
  readonly select: boolean
}

export interface Candidate {
  readonly node: AxNode
  readonly frameId: string
  readonly role: UiRole
  readonly nativeRole: string
  readonly name: string
  readonly depth: number
  /** A `<select>`-style combobox (options under a MenuListPopup). */
  readonly select: boolean
}

const INTERACTIVE: ReadonlySet<UiRole> = new Set<UiRole>([
  'button',
  'link',
  'textbox',
  'searchbox',
  'checkbox',
  'radio',
  'combobox',
  'listbox',
  'option',
  'menuitem',
  'tab',
  'slider',
])

/** Roles listed by default besides the interactive ones. */
const STRUCTURAL: ReadonlySet<UiRole> = new Set<UiRole>([
  'heading',
  'dialog',
  'image',
])

export function mapRole(
  nativeRole: string,
  props: ReadonlyMap<string, unknown>,
): UiRole {
  switch (nativeRole) {
    case 'button':
    case 'PopUpButton':
      return 'button'
    case 'link':
      return 'link'
    case 'textbox':
    case 'TextField':
      return 'textbox'
    case 'searchbox':
      return 'searchbox'
    case 'checkbox':
    case 'switch':
    case 'menuitemcheckbox':
      return 'checkbox'
    case 'radio':
    case 'menuitemradio':
      return 'radio'
    case 'combobox':
    case 'ComboBoxSelect':
    case 'ComboBoxMenuButton':
      return 'combobox'
    case 'listbox':
      return 'listbox'
    case 'option':
      return 'option'
    case 'menu':
    case 'menubar':
      return 'menu'
    case 'menuitem':
      return 'menuitem'
    case 'tab':
      return 'tab'
    case 'slider':
    case 'spinbutton':
      return 'slider'
    case 'table':
    case 'grid':
    case 'treegrid':
      return 'table'
    case 'row':
      return 'row'
    case 'cell':
    case 'gridcell':
    case 'columnheader':
    case 'rowheader':
      return 'cell'
    case 'image':
    case 'img':
      return 'image'
    case 'heading':
      return 'heading'
    case 'dialog':
    case 'alertdialog':
      return 'dialog'
    case 'StaticText':
      return 'text'
    case 'group':
    case 'radiogroup':
      return 'group'
    case 'generic':
      return props.get('editable') !== undefined &&
        props.get('focusable') === true
        ? 'textbox'
        : 'other'
    default:
      return 'other'
  }
}

function propsOf(node: AxNode): Map<string, unknown> {
  const map = new Map<string, unknown>()
  for (const prop of node.properties ?? [])
    map.set(prop.name, prop.value?.value)
  return map
}

function text(value: AxValue | undefined): string {
  return typeof value?.value === 'string' || typeof value?.value === 'number'
    ? String(value.value).replace(/\s+/g, ' ').trim()
    : ''
}

export function statesOf(node: AxNode): string[] {
  const props = propsOf(node)
  const states: string[] = []
  if (props.get('focused') === true) states.push('focused')
  if (props.get('disabled') === true) states.push('disabled')
  const checked = props.get('checked')
  if (checked === 'true' || checked === true) states.push('checked')
  if (checked === 'mixed') states.push('mixed')
  if (props.get('expanded') === true) states.push('expanded')
  if (props.get('selected') === true) states.push('selected')
  if (props.get('pressed') === 'true' || props.get('pressed') === true)
    states.push('pressed')
  if (props.get('required') === true) states.push('required')
  if (props.get('readonly') === true) states.push('readonly')
  const invalid = props.get('invalid')
  if (invalid !== undefined && invalid !== 'false' && invalid !== false)
    states.push('invalid')
  return states
}

export function actionsOf(role: UiRole, select: boolean): string[] {
  switch (role) {
    case 'textbox':
    case 'searchbox':
      return ['fill', 'type']
    case 'combobox':
      return select ? ['select'] : ['fill', 'click']
    case 'slider':
      return ['press']
    case 'button':
    case 'link':
    case 'checkbox':
    case 'radio':
    case 'option':
    case 'menuitem':
    case 'tab':
    case 'listbox':
      return ['click']
    default:
      return []
  }
}

export interface WalkOptions {
  /** Include this role even when it is not listed by default. */
  readonly role?: UiRole
  readonly nameContains?: string
  readonly frameId?: string
  readonly maxDepth: number
}

/**
 * Walk one frame's AX nodes in document order. `childFrames` maps an
 * iframe's backend node id to that frame's walk (spliced in place).
 */
export function walkFrame(
  nodes: readonly AxNode[],
  frameId: string,
  options: WalkOptions,
  childFrame: (iframe: AxNode, depth: number) => Candidate[] | null,
  notes: string[],
): Candidate[] {
  const byId = new Map(nodes.map((node) => [node.nodeId, node]))
  const root = nodes.find(
    (node) => node.parentId === undefined || !byId.has(node.parentId),
  )
  if (root === undefined) return []
  const out: Candidate[] = []
  const needle = options.nameContains?.toLowerCase()
  const visit = (node: AxNode, depth: number, inSelect: boolean): void => {
    const nativeRole = String(node.role?.value ?? '')
    const props = propsOf(node)
    let nextDepth = depth
    let childInSelect = inSelect
    if (!node.ignored) {
      if (nativeRole === 'Iframe') {
        const spliced = childFrame(node, depth)
        if (spliced !== null) out.push(...spliced)
        return
      }
      if (nativeRole === 'MenuListPopup') childInSelect = true
      const role = mapRole(nativeRole, props)
      const name = text(node.name)
      const select =
        role === 'combobox' &&
        (node.childIds ?? []).some(
          (id) => String(byId.get(id)?.role?.value ?? '') === 'MenuListPopup',
        )
      const listed =
        options.role !== undefined
          ? role === options.role
          : (INTERACTIVE.has(role) && !(role === 'option' && inSelect)) ||
            (STRUCTURAL.has(role) && (role !== 'image' || name !== ''))
      const matchesName =
        needle === undefined || name.toLowerCase().includes(needle)
      const matchesFrame =
        options.frameId === undefined || options.frameId === frameId
      if (
        listed &&
        matchesName &&
        matchesFrame &&
        depth <= options.maxDepth * 4
      ) {
        out.push({ node, frameId, role, nativeRole, name, depth, select })
        nextDepth = depth + 1
      }
    }
    for (const id of node.childIds ?? []) {
      const child = byId.get(id)
      if (child !== undefined) visit(child, nextDepth, childInSelect)
    }
  }
  visit(root, 0, false)
  void notes
  return out
}

export interface SnapshotInput {
  readonly revision: number
  readonly maxElements: number
  readonly maxTextBytes: number
  readonly maxDepth: number
  readonly timeoutMs: number
  readonly includeText: boolean
  readonly query?: {
    role?: string
    nameContains?: string
    frameId?: string
    visibleOnly?: boolean
  }
  readonly signal?: AbortSignal
  /** OOPIF root frame id → its CDP child session (from Target.attachedToTarget). */
  readonly oopifs?: ReadonlyMap<string, string>
  /**
   * Hide every field value (a credential was filled in this document: page
   * script can turn the password field into plain text or copy it).
   */
  readonly maskValues?: boolean
}

export interface SnapshotResult {
  readonly title: string
  readonly url: string
  readonly viewport: { width: number; height: number; scale: number }
  /** Every listed element of this revision (paging slices this list). */
  readonly all: readonly UiElement[]
  readonly refs: ReadonlyMap<string, RefTarget>
  readonly textExcerpt?: string
  readonly redactions: number
  readonly notes: readonly string[]
  readonly timedOut: boolean
  readonly focus: boolean
  /** Every frame inside an OOPIF → the session that owns it. */
  readonly frameSessions: ReadonlyMap<string, string>
}

interface FrameTree {
  frame: { id: string; url: string; parentId?: string }
  childFrames?: FrameTree[]
}

function flattenFrames(
  tree: FrameTree,
  out: Map<string, string> = new Map(),
): Map<string, string> {
  out.set(tree.frame.id, tree.frame.url)
  for (const child of tree.childFrames ?? []) flattenFrames(child, out)
  return out
}

/** `<input type>` values reported on text boxes (credential field checks). */
const INPUT_TYPES: ReadonlySet<string> = new Set([
  'text',
  'password',
  'email',
  'tel',
  'number',
  'search',
  'url',
])

function originOf(url: string | undefined): string | null {
  if (url === undefined) return null
  try {
    const origin = new URL(url).origin
    return origin === 'null' ? null : origin
  } catch {
    return null
  }
}

function attributes(list: readonly string[] | undefined): Map<string, string> {
  const map = new Map<string, string>()
  for (let index = 0; list !== undefined && index + 1 < list.length; index += 2)
    map.set(list[index]!.toLowerCase(), list[index + 1]!)
  return map
}

function isSecretField(attrs: Map<string, string>): boolean {
  const type = (attrs.get('type') ?? '').toLowerCase()
  const autocomplete = (attrs.get('autocomplete') ?? '').toLowerCase()
  return (
    type === 'password' ||
    type === 'hidden' ||
    autocomplete === 'one-time-code' ||
    autocomplete === 'current-password' ||
    autocomplete === 'new-password' ||
    autocomplete.startsWith('cc-')
  )
}

// Masking only (a revealed password, a one-time code in a plain text box);
// typing into such a field is still allowed.
function looksSensitiveField(
  attrs: Map<string, string>,
  name: string,
): boolean {
  return looksSensitive(
    attrs.get('name'),
    attrs.get('id'),
    attrs.get('placeholder'),
    attrs.get('aria-label'),
    attrs.get('autocomplete'),
    name,
  )
}

const UI_ROLES_SET: ReadonlySet<string> = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'checkbox',
  'radio',
  'combobox',
  'listbox',
  'option',
  'menu',
  'menuitem',
  'tab',
  'slider',
  'table',
  'row',
  'cell',
  'image',
  'heading',
  'text',
  'window',
  'dialog',
  'group',
  'other',
])

export async function takeSnapshot(
  cdp: CdpSession,
  worlds: IsolatedWorlds,
  input: SnapshotInput,
): Promise<SnapshotResult> {
  const deadline = Date.now() + input.timeoutMs
  const remaining = (): number => Math.max(50, deadline - Date.now())
  const send = <T>(method: string, params: object = {}, sessionId?: string) =>
    cdp.send<T>(method, params, {
      timeoutMs: remaining(),
      ...(input.signal ? { signal: input.signal } : {}),
      ...(sessionId === undefined ? {} : { sessionId }),
    })
  const notes: string[] = []
  const { frameTree } = await send<{ frameTree: FrameTree }>(
    'Page.getFrameTree',
  )
  const frames = flattenFrames(frameTree)
  const mainFrameId = frameTree.frame.id
  // Frames of each OOPIF (its root and same-process children) → session.
  const frameSessions = new Map<string, string>()
  const oopifParent = new Map<string, string>()
  for (const [rootId, sessionId] of input.oopifs ?? []) {
    try {
      const child = await send<{ frameTree: FrameTree }>(
        'Page.getFrameTree',
        {},
        sessionId,
      )
      const childFrames = flattenFrames(child.frameTree)
      for (const [id, url] of childFrames) {
        frames.set(id, url)
        frameSessions.set(id, sessionId)
      }
      if (child.frameTree.frame.parentId !== undefined)
        oopifParent.set(rootId, child.frameTree.frame.parentId)
    } catch {
      // the frame went away; it is noted below if still on the page
    }
  }
  const sessionOf = (frameId: string): string | undefined =>
    frameSessions.get(frameId)
  const queryRole =
    input.query?.role !== undefined && UI_ROLES_SET.has(input.query.role)
      ? (input.query.role as UiRole)
      : undefined
  const walkOptions: WalkOptions = {
    ...(queryRole === undefined ? {} : { role: queryRole }),
    ...(input.query?.nameContains === undefined
      ? {}
      : { nameContains: input.query.nameContains }),
    ...(input.query?.frameId === undefined
      ? {}
      : { frameId: input.query.frameId }),
    maxDepth: input.maxDepth,
  }
  const axFor = async (frameId: string): Promise<AxNode[] | null> => {
    const sessionId = sessionOf(frameId)
    try {
      const params =
        sessionId !== undefined && input.oopifs?.has(frameId) ? {} : { frameId }
      const result = await send<{ nodes: AxNode[] }>(
        'Accessibility.getFullAXTree',
        params,
        sessionId,
      )
      return result.nodes
    } catch {
      return null
    }
  }
  const mainNodes = (await axFor(mainFrameId)) ?? []
  const childNodes = new Map<string, AxNode[] | null>()
  for (const frameId of frames.keys())
    if (frameId !== mainFrameId) childNodes.set(frameId, await axFor(frameId))

  const frameOfIframe = async (
    iframe: AxNode,
    inFrame: string,
  ): Promise<{ frameId?: string; src?: string }> => {
    if (iframe.backendDOMNodeId === undefined) return {}
    try {
      const { node } = await send<{
        node: { frameId?: string; attributes?: string[] }
      }>(
        'DOM.describeNode',
        { backendNodeId: iframe.backendDOMNodeId },
        sessionOf(inFrame),
      )
      return {
        ...(node.frameId === undefined ? {} : { frameId: node.frameId }),
        ...(attributes(node.attributes).get('src') === undefined
          ? {}
          : { src: attributes(node.attributes).get('src')! }),
      }
    } catch {
      return {}
    }
  }
  // Resolve iframe → frame ids up front (walkFrame is synchronous).
  const iframeFrames = new Map<string, { frameId?: string; src?: string }>()
  const collectIframes = async (
    nodes: readonly AxNode[],
    inFrame: string,
  ): Promise<void> => {
    for (const node of nodes)
      if (String(node.role?.value ?? '') === 'Iframe' && !node.ignored)
        iframeFrames.set(
          `${inFrame}:${node.nodeId}`,
          await frameOfIframe(node, inFrame),
        )
  }
  await collectIframes(mainNodes, mainFrameId)
  for (const [frameId, nodes] of childNodes)
    if (nodes !== null) await collectIframes(nodes, frameId)

  const walked = (
    nodes: readonly AxNode[],
    frameId: string,
    depth0: number,
  ): Candidate[] =>
    walkFrame(
      nodes,
      frameId,
      walkOptions,
      (iframe, depth) => {
        const info = iframeFrames.get(`${frameId}:${iframe.nodeId}`)
        const childId = info?.frameId
        const child =
          childId === undefined ? undefined : childNodes.get(childId)
        if (childId === undefined || child === undefined || child === null) {
          let origin = info?.src ?? ''
          try {
            origin = new URL(origin, frames.get(frameId) ?? undefined).origin
          } catch {
            // keep the raw value
          }
          notes.push(`cross-origin frame ${origin || '(unknown)'} not expanded`)
          return []
        }
        return walked(child, childId, depth0 + depth)
      },
      notes,
    ).map((candidate) => ({ ...candidate, depth: candidate.depth + depth0 }))

  const candidates = walked(mainNodes, mainFrameId, 0)

  // Page offset of each OOPIF session's viewport: its owner <iframe> content
  // box in the parent's session, plus the parent's own offset.
  const offsets = new Map<string, { x: number; y: number }>()
  const offsetOf = async (
    sessionId: string | undefined,
    hops = 0,
  ): Promise<{ x: number; y: number }> => {
    if (sessionId === undefined || hops > 8) return { x: 0, y: 0 }
    const known = offsets.get(sessionId)
    if (known !== undefined) return known
    let offset = { x: 0, y: 0 }
    const rootId = [...(input.oopifs ?? [])].find(
      ([, session]) => session === sessionId,
    )?.[0]
    const parentFrame =
      rootId === undefined ? undefined : oopifParent.get(rootId)
    if (rootId !== undefined && parentFrame !== undefined) {
      const parentSession = sessionOf(parentFrame)
      try {
        const owner = await send<{ backendNodeId: number }>(
          'DOM.getFrameOwner',
          { frameId: rootId },
          parentSession,
        )
        const { quads } = await send<{ quads: number[][] }>(
          'DOM.getContentQuads',
          { backendNodeId: owner.backendNodeId },
          parentSession,
        )
        const quad = quads[0]
        const base = await offsetOf(parentSession, hops + 1)
        if (quad !== undefined)
          offset = {
            x: base.x + Math.min(quad[0]!, quad[6]!),
            y: base.y + Math.min(quad[1]!, quad[3]!),
          }
      } catch {
        // unknown position: bounds stay frame-local
      }
    }
    offsets.set(sessionId, offset)
    return offset
  }

  const metrics = await send<{
    cssVisualViewport?: {
      clientWidth: number
      clientHeight: number
      pageX: number
      pageY: number
    }
    cssLayoutViewport?: { clientWidth: number; clientHeight: number }
  }>('Page.getLayoutMetrics')
  const viewport = {
    width: Math.round(
      metrics.cssVisualViewport?.clientWidth ??
        metrics.cssLayoutViewport?.clientWidth ??
        0,
    ),
    height: Math.round(
      metrics.cssVisualViewport?.clientHeight ??
        metrics.cssLayoutViewport?.clientHeight ??
        0,
    ),
    scale: 1,
  }

  const mainOrigin = originOf(frames.get(mainFrameId))
  const foreignOrigin = (url: string | undefined): string | null => {
    const origin = originOf(url)
    // about:blank, srcdoc and data: frames hold what their parent wrote.
    return origin === null || origin === mainOrigin ? null : origin
  }
  const refs = new Map<string, RefTarget>()
  const all: UiElement[] = []
  let redactions = 0
  let timedOut = false
  let focus = false
  for (const [index, candidate] of candidates.entries()) {
    if (Date.now() > deadline) {
      timedOut = true
      notes.push('snapshot time budget reached; the list is incomplete')
      break
    }
    const backendNodeId = candidate.node.backendDOMNodeId
    if (backendNodeId === undefined) continue
    const sessionId = sessionOf(candidate.frameId)
    // A frame of another origin: grants are checked against its origin.
    const frameOrigin =
      candidate.frameId === mainFrameId
        ? null
        : foreignOrigin(frames.get(candidate.frameId))
    const ref = `r${input.revision}.${index + 1}`
    const states = statesOf(candidate.node)
    if (states.includes('focused')) focus = true
    let value: string | undefined
    let secret = false
    let inputType: string | undefined
    if (candidate.role === 'textbox' || candidate.role === 'searchbox') {
      // Unreadable attributes: mask the value rather than guess.
      let masked = true
      try {
        const { node } = await send<{ node: { attributes?: string[] } }>(
          'DOM.describeNode',
          { backendNodeId },
          sessionId,
        )
        const attrs = attributes(node.attributes)
        secret = isSecretField(attrs)
        inputType = INPUT_TYPES.has((attrs.get('type') ?? '').toLowerCase())
          ? (attrs.get('type') ?? '').toLowerCase()
          : undefined
        masked =
          secret ||
          input.maskValues === true ||
          looksSensitiveField(attrs, candidate.name)
      } catch {
        secret = false
      }
      const raw = text(candidate.node.value)
      if (masked) {
        redactions += 1
        value = raw === '' ? '' : '[has content]'
      } else value = raw
    } else if (candidate.role === 'combobox' || candidate.role === 'slider') {
      const raw = text(candidate.node.value)
      value =
        input.maskValues === true && raw !== '' && candidate.role === 'combobox'
          ? '[has content]'
          : raw
    }
    let bounds: UiElement['bounds']
    try {
      // Viewport-relative CSS pixels: the "target" coordinate space (§5.3).
      const { quads } = await send<{ quads: number[][] }>(
        'DOM.getContentQuads',
        { backendNodeId },
        sessionId,
      )
      const quad = quads[0]
      if (quad === undefined) throw new Error('no quads')
      const offset = await offsetOf(sessionId)
      const xs = [quad[0]!, quad[2]!, quad[4]!, quad[6]!].map(
        (value) => value + offset.x,
      )
      const ys = [quad[1]!, quad[3]!, quad[5]!, quad[7]!].map(
        (value) => value + offset.y,
      )
      const x = Math.min(...xs)
      const y = Math.min(...ys)
      bounds = {
        x: Math.round(x),
        y: Math.round(y),
        width: Math.round(Math.max(...xs) - x),
        height: Math.round(Math.max(...ys) - y),
      }
      if (
        viewport.width > 0 &&
        (bounds.y + bounds.height < 0 ||
          bounds.y > viewport.height ||
          bounds.x > viewport.width)
      )
        states.push('offscreen')
    } catch {
      states.push('hidden')
    }
    if (
      input.query?.visibleOnly === true &&
      (states.includes('offscreen') || states.includes('hidden'))
    )
      continue
    refs.set(ref, {
      backendNodeId,
      frameId: candidate.frameId,
      ...(sessionId === undefined ? {} : { sessionId }),
      role: candidate.role,
      name: candidate.name,
      secret,
      select: candidate.select,
    })
    all.push({
      ref,
      role: candidate.role,
      nativeRole: candidate.nativeRole,
      ...(candidate.name === ''
        ? {}
        : { name: candidate.name.slice(0, 1_024) }),
      ...(value === undefined ? {} : { value: value.slice(0, 4_096) }),
      ...(states.length === 0 ? {} : { states }),
      ...(bounds === undefined ? {} : { bounds }),
      actions: actionsOf(candidate.role, candidate.select),
      ...(candidate.frameId === mainFrameId
        ? {}
        : { frameId: candidate.frameId }),
      ...(frameOrigin === null ? {} : { frameOrigin }),
      ...(inputType === undefined ? {} : { inputType }),
      depth: candidate.depth,
    })
  }

  const root = mainNodes.find(
    (node) => String(node.role?.value ?? '') === 'RootWebArea',
  )
  let textExcerpt: string | undefined
  if (input.includeText && Date.now() < deadline) {
    try {
      const value = await worlds.callInFrame<unknown>(
        mainFrameId,
        'textExcerpt',
        [Math.floor(input.maxTextBytes)],
        input.signal,
      )
      if (typeof value === 'string') textExcerpt = value
    } catch {
      notes.push('page text could not be read')
    }
  }
  return {
    title: text(root?.name),
    url: frames.get(mainFrameId) ?? '',
    viewport,
    all,
    refs,
    ...(textExcerpt === undefined ? {} : { textExcerpt }),
    redactions,
    notes: [...new Set(notes)],
    timedOut,
    focus,
    frameSessions,
  }
}
