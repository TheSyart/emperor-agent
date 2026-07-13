import type { DiscoveredModel, ModelEntry } from '../../../types'

export interface ModelPickerOption extends DiscoveredModel {
  custom?: boolean
}

export interface ModelPickerAnchorRect {
  left: number
  top: number
  right: number
  bottom: number
  width: number
}

export interface ModelPickerPlacementInput {
  anchor: ModelPickerAnchorRect
  contentHeight: number
  viewportWidth: number
  viewportHeight: number
  gap?: number
  margin?: number
  maxPopoverHeight?: number
  minWidth?: number
}

export interface ModelPickerPlacement {
  placement: 'top' | 'bottom'
  top: number
  left: number
  width: number
  maxHeight: number
}

export function computeModelPickerPlacement({
  anchor,
  contentHeight,
  viewportWidth,
  viewportHeight,
  gap = 6,
  margin = 8,
  maxPopoverHeight = 260,
  minWidth = 220,
}: ModelPickerPlacementInput): ModelPickerPlacement {
  const viewportContentWidth = Math.max(0, viewportWidth - margin * 2)
  const width = Math.min(viewportContentWidth, Math.max(minWidth, anchor.width))
  const left = Math.min(
    Math.max(margin, anchor.left),
    Math.max(margin, viewportWidth - margin - width),
  )
  const spaceBelow = Math.max(0, viewportHeight - margin - anchor.bottom - gap)
  const spaceAbove = Math.max(0, anchor.top - margin - gap)
  const desiredHeight = Math.min(maxPopoverHeight, Math.max(0, contentHeight))
  const placement =
    spaceBelow >= desiredHeight || spaceBelow >= spaceAbove ? 'bottom' : 'top'
  const available = placement === 'bottom' ? spaceBelow : spaceAbove
  const maxHeight = Math.min(desiredHeight, available)
  const top =
    placement === 'bottom' ? anchor.bottom + gap : anchor.top - gap - maxHeight

  return { placement, top, left, width, maxHeight }
}

export function normalizeModelOptions(
  options: DiscoveredModel[],
  currentValue = '',
): ModelPickerOption[] {
  const result: ModelPickerOption[] = []
  const seen = new Set<string>()
  const current = currentValue.trim()

  if (current && !options.some((option) => option.id.trim() === current)) {
    result.push({ id: current, custom: true })
    seen.add(current)
  }

  for (const option of options) {
    const id = option.id.trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    result.push(id === option.id ? option : { ...option, id })
  }

  return result
}

export function filterModelOptions(
  options: ModelPickerOption[],
  query: string,
): ModelPickerOption[] {
  const normalizedQuery = query.trim().toLocaleLowerCase()
  if (!normalizedQuery) return options
  return options.filter(
    (option) =>
      !option.custom &&
      (option.id.toLocaleLowerCase().includes(normalizedQuery) ||
        String(option.ownedBy || '')
          .toLocaleLowerCase()
          .includes(normalizedQuery)),
  )
}

export function applyModelSelection(
  entry: ModelEntry,
  role: 'main' | 'secondary',
  value: string,
): ModelEntry {
  if (role === 'main') {
    return { ...entry, id: value, mainModelId: value }
  }
  return { ...entry, secondaryModelId: value }
}
