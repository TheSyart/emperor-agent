export interface Point {
  x: number
  y: number
}
export function fitScale(
  width: number,
  height: number,
  availableWidth: number,
  availableHeight: number,
): number {
  return width > 0 && height > 0
    ? Math.min(1, availableWidth / width, availableHeight / height)
    : 1
}
export function panBounds(
  width: number,
  height: number,
  scale: number,
  rotation: number,
  availableWidth: number,
  availableHeight: number,
): Point {
  const swap = Math.abs(rotation % 180) === 90
  return {
    x: Math.max(0, ((swap ? height : width) * scale - availableWidth) / 2),
    y: Math.max(0, ((swap ? width : height) * scale - availableHeight) / 2),
  }
}
export function zoomAt(
  pan: Point,
  previous: number,
  next: number,
  anchor: Point,
): Point {
  const ratio = next / previous
  return {
    x: anchor.x - (anchor.x - pan.x) * ratio,
    y: anchor.y - (anchor.y - pan.y) * ratio,
  }
}
