export function mediaRawUrl(id: string): string {
  return `app://media/${encodeURIComponent(id)}/raw`
}
