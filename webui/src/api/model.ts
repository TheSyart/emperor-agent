import type { ModelTestResult } from '../types'

export async function testModelEntry(
  entryName: string,
  kind: 'text' | 'vision',
): Promise<ModelTestResult> {
  const r = await fetch('/api/model-test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entryName, kind }),
  })
  // 后端在测试失败时仍返回 200 + ok:false；非 2xx 才走 throw
  if (!r.ok && r.status >= 500) {
    let message = `HTTP ${r.status}`
    try {
      const data = await r.json()
      if (data && typeof data.error === 'string') message = data.error
    } catch {
      // ignore parse errors
    }
    throw new Error(message)
  }
  return (await r.json()) as ModelTestResult
}
