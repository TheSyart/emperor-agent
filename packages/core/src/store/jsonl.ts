import { existsSync } from 'node:fs'
import {
  appendFile,
  mkdir,
  readFile,
  rename,
  writeFile,
} from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * JSONL append-only 日志 + 归档。`memory` HistoryLog、runtime events 和
 * Team inbox 共享逐行 JSON 格式；读时隔离坏行（不整体失败）；热段超阈值轮转到归档。
 */

/** 追加一行 JSON。 */
export async function appendJsonl(
  path: string,
  record: unknown,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await appendFile(path, `${JSON.stringify(record)}\n`, 'utf8')
}

export interface ReadJsonlResult<T> {
  records: T[]
  /** 解析失败被跳过的坏行（原文 + 行号），供 diagnostics。 */
  badLines: { line: number; raw: string }[]
}

/** 读取全部行，跳过并收集坏行。 */
export async function readJsonl<T>(path: string): Promise<ReadJsonlResult<T>> {
  if (!existsSync(path)) return { records: [], badLines: [] }
  const raw = await readFile(path, 'utf8')
  const records: T[] = []
  const badLines: { line: number; raw: string }[] = []
  const lines = raw.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i]
    if (!text || !text.trim()) continue
    try {
      records.push(JSON.parse(text) as T)
    } catch {
      badLines.push({ line: i + 1, raw: text })
    }
  }
  return { records, badLines }
}

/**
 * 把热段整体轮转到归档文件（追加），并清空热段。返回是否轮转。
 * 当热段行数 >= keepThreshold 时触发，保留 0 行（全部归档）——具体保留策略由各子系统在其波次细化。
 */
export async function rotateToArchive(
  hotPath: string,
  archivePath: string,
  opts: { keepThreshold: number },
): Promise<boolean> {
  if (!existsSync(hotPath)) return false
  const raw = await readFile(hotPath, 'utf8')
  const lineCount = raw.split('\n').filter((l) => l.trim()).length
  if (lineCount < opts.keepThreshold) return false
  await mkdir(dirname(archivePath), { recursive: true })
  await appendFile(
    archivePath,
    raw.endsWith('\n') || raw === '' ? raw : `${raw}\n`,
    'utf8',
  )
  // 原子清空热段
  const tmp = `${hotPath}.tmp-${process.pid}`
  await writeFile(tmp, '', 'utf8')
  await rename(tmp, hotPath)
  return true
}
