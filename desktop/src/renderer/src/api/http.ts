export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    ...options,
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    const message = typeof data?.error === 'string' ? data.error : response.statusText
    throw new Error(message)
  }
  return data as T
}

export function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}
