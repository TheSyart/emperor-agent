/**
 * Compactor — 历史压缩 (MIG-MEM-003)。对齐 Python `agent/compactor.py`。
 * 压缩 history[:-K](K=10)，更新 episode/MEMORY.local.md/USER.local.md；XML 标签解析逐字。
 * compact_prompt.md 由 docsDir 传入；解析失败走一次 repair；仍失败记 compact_diagnostics.jsonl。
 */
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ChatArgs, GenerationSettings, LLMProvider, LLMResponse } from '../providers/base'
import type { HistoryArchiveGate } from './history'
import type { TokenTracker } from './token-tracker'
import { nowIsoUtc8 } from './time-utc8'

const REQUIRED_TAGS = ['episode', 'updated_memory', 'updated_user'] as const
const COMPACTOR_TEXT_MESSAGE_LIMIT = 4000
const REPAIR_PROMPT = `The previous memory compaction response was invalid.
Return only the required XML blocks, with no commentary. Required tags:
<episode>...</episode>
<updated_memory>...</updated_memory>
<updated_user>...</updated_user>

Invalid response:
<invalid_response>
{invalid_response}
</invalid_response>
`

export interface CompactionResult {
  episode: string
  updatedMemory: string
  updatedUser: string
}

export class CompactionParseError extends Error {
  readonly missingTags: string[]
  readonly text: string
  constructor(missingTags: string[], text: string) {
    super(`memory compaction response missing tags: ${missingTags.join(', ')}`)
    this.name = 'CompactionParseError'
    this.missingTags = missingTags
    this.text = text
  }
}

function extract(tag: string, text: string): string | null {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(text)
  return m ? m[1]!.trim() : null
}

export function parseCompactionResult(text: string): CompactionResult {
  const values: Record<string, string | null> = {}
  for (const tag of REQUIRED_TAGS) values[tag] = extract(tag, text)
  const missing = REQUIRED_TAGS.filter((tag) => !values[tag])
  if (missing.length) throw new CompactionParseError(missing, text)
  return {
    episode: String(values.episode),
    updatedMemory: String(values.updated_memory),
    updatedUser: String(values.updated_user),
  }
}

export type RuntimeContextProvider = (messages: Array<Record<string, unknown>>) => Record<string, unknown> | string | null

export interface CompactorMemoryStore {
  readonly memoryDir: string
  readMemory(): string
  writeMemory(content: string): void
  readUser(): string
  writeUser(content: string): void
  readTodayEpisode(): string
  appendEpisode(content: string): void
  appendCompactMarker(activeHistory?: Array<Record<string, unknown>> | null, archiveGate?: HistoryArchiveGate | null): void
}

interface CompactionCall {
  provider: LLMProvider
  model: string
  providerName: string | null
  modelRole: string
  maxTokens: number
  temperature: number
  reasoningEffort: string | null
  routeReason: string
  usedFallback: boolean
  fallbackReason: string
}

export interface CompactorOptions {
  provider: LLMProvider
  model: string
  memoryStore: CompactorMemoryStore
  docsDir: string
  maxTokens?: number
  temperature?: number
  reasoningEffort?: string | null
  providerName?: string | null
  tokenTracker?: TokenTracker | null
  usageType?: string
  modelRole?: string
  fallbackProvider?: LLMProvider | null
  fallbackModel?: string | null
  fallbackProviderName?: string | null
  fallbackGeneration?: GenerationSettings | null
  fallbackModelRole?: string
  routeReason?: string
  fallbackRouteReason?: string
  runtimeContextProvider?: RuntimeContextProvider | null
}

export class Compactor {
  static readonly K = 10

  private readonly provider: LLMProvider
  private readonly model: string
  private readonly memory: CompactorMemoryStore
  private readonly promptTemplate: string
  private readonly maxTokens: number
  private readonly temperature: number
  private readonly reasoningEffort: string | null
  private readonly providerName: string | null
  private readonly tokenTracker: TokenTracker | null
  private readonly usageType: string
  private readonly modelRole: string
  private readonly fallbackProvider: LLMProvider | null
  private readonly fallbackModel: string | null
  private readonly fallbackProviderName: string | null
  private readonly fallbackGeneration: GenerationSettings | null
  private readonly fallbackModelRole: string
  private readonly routeReason: string
  private readonly fallbackRouteReason: string
  private readonly runtimeContextProvider: RuntimeContextProvider | null

  constructor(opts: CompactorOptions) {
    this.provider = opts.provider
    this.model = opts.model
    this.memory = opts.memoryStore
    this.promptTemplate = readFileSync(join(opts.docsDir, 'agent', 'compact_prompt.md'), 'utf8')
    this.maxTokens = opts.maxTokens ?? 4000
    this.temperature = opts.temperature ?? 0.1
    this.reasoningEffort = opts.reasoningEffort ?? null
    this.providerName = opts.providerName ?? null
    this.tokenTracker = opts.tokenTracker ?? null
    this.usageType = opts.usageType ?? 'memory_compaction'
    this.modelRole = opts.modelRole ?? 'main'
    this.fallbackProvider = opts.fallbackProvider ?? null
    this.fallbackModel = opts.fallbackModel ?? null
    this.fallbackProviderName = opts.fallbackProviderName ?? null
    this.fallbackGeneration = opts.fallbackGeneration ?? null
    this.fallbackModelRole = opts.fallbackModelRole ?? 'main'
    this.routeReason = opts.routeReason ?? 'memory_compaction'
    this.fallbackRouteReason = opts.fallbackRouteReason || `${this.routeReason}:fallback_main`
    this.runtimeContextProvider = opts.runtimeContextProvider ?? null
  }

  async compactAsync(history: Array<Record<string, unknown>>): Promise<Array<Record<string, unknown>>> {
    if (history.length <= Compactor.K) return history
    const old = history.slice(0, -Compactor.K)
    const recent = history.slice(-Compactor.K)
    if (!(await this.compactMessages(old))) return history
    this.memory.appendCompactMarker(recent)
    return recent
  }

  async compactStartupAsync(history: Array<Record<string, unknown>>): Promise<boolean> {
    if (history.length < 2) return false
    if (!(await this.compactMessages(history))) return false
    this.memory.appendCompactMarker([])
    return true
  }

  private async compactMessages(messages: Array<Record<string, unknown>>): Promise<boolean> {
    const prompt = formatTemplate(this.promptTemplate, {
      old_conversation: messagesToText(messages, this.runtimeContextProvider),
      current_memory: this.memory.readMemory() || '(空)',
      current_user: this.memory.readUser() || '(空)',
      today_episode: this.memory.readTodayEpisode() || '(空)',
      now_hhmm: nowHhmm(),
    })
    const [call, resp] = await this.callWithFallback(prompt)
    const text = resp.content ?? ''
    let parsed: CompactionResult
    try {
      parsed = parseCompactionResult(text)
    } catch (exc) {
      if (!(exc instanceof CompactionParseError)) throw exc
      const repairPrompt = formatTemplate(REPAIR_PROMPT, { invalid_response: text.slice(0, 12_000) })
      const repairResp = await this.chat(call, repairPrompt)
      this.recordUsage(call, repairResp.usage, repairPrompt)
      try {
        parsed = parseCompactionResult(repairResp.content ?? '')
      } catch (repairExc) {
        if (!(repairExc instanceof CompactionParseError)) throw repairExc
        this.recordDiagnostic(repairExc)
        return false
      }
    }
    this.memory.appendEpisode(parsed.episode)
    this.memory.writeMemory(parsed.updatedMemory)
    this.memory.writeUser(parsed.updatedUser)
    return true
  }

  private async callWithFallback(prompt: string): Promise<[CompactionCall, LLMResponse]> {
    const call: CompactionCall = {
      provider: this.provider,
      model: this.model,
      providerName: this.providerName,
      modelRole: this.modelRole,
      maxTokens: this.maxTokens,
      temperature: this.temperature,
      reasoningEffort: this.reasoningEffort,
      routeReason: this.routeReason,
      usedFallback: false,
      fallbackReason: '',
    }
    try {
      const resp = await this.chat(call, prompt)
      this.recordUsage(call, resp.usage, prompt)
      return [call, resp]
    } catch (exc) {
      if (!(this.fallbackProvider && this.fallbackModel)) throw exc
      const generation = this.fallbackGeneration
      const fallbackCall: CompactionCall = {
        provider: this.fallbackProvider,
        model: this.fallbackModel,
        providerName: this.fallbackProviderName,
        modelRole: this.fallbackModelRole,
        maxTokens: Math.min(this.maxTokens, Number(generation?.maxTokens ?? this.maxTokens) || this.maxTokens),
        temperature: generation?.temperature ?? this.temperature,
        reasoningEffort: generation?.reasoningEffort ?? this.reasoningEffort,
        routeReason: this.fallbackRouteReason,
        usedFallback: true,
        fallbackReason: String(exc),
      }
      const resp = await this.chat(fallbackCall, prompt)
      this.recordUsage(fallbackCall, resp.usage, prompt)
      return [fallbackCall, resp]
    }
  }

  private async chat(call: CompactionCall, prompt: string): Promise<LLMResponse> {
    const args: ChatArgs = {
      model: call.model,
      maxTokens: call.maxTokens,
      temperature: call.temperature,
      reasoningEffort: call.reasoningEffort,
      messages: [{ role: 'user', content: prompt }],
      tools: null,
    }
    return call.provider.chat(args)
  }

  private recordUsage(call: CompactionCall, usage: Record<string, number> | undefined, prompt: string): void {
    if (!(this.tokenTracker && usage && Object.keys(usage).length)) return
    this.tokenTracker.record(call.model, usage, {
      provider: call.providerName,
      usageType: this.usageType,
      modelRole: call.modelRole,
      routeReason: call.routeReason,
      usedFallback: call.usedFallback,
      fallbackReason: call.fallbackReason,
      estimatedInputTokens: Math.max(1, Math.trunc(prompt.length / 3)),
    })
  }

  private recordDiagnostic(exc: CompactionParseError): void {
    const payload = {
      ts: nowIsoUtc8(),
      event: 'compact_parse_failed',
      missing_tags: exc.missingTags,
      response_snippet: exc.text.slice(0, 2000),
    }
    try {
      const path = join(this.memory.memoryDir, 'compact_diagnostics.jsonl')
      mkdirSync(this.memory.memoryDir, { recursive: true })
      appendFileSync(path, JSON.stringify(payload) + '\n', 'utf8')
    } catch {
      /* tolerate */
    }
  }
}

// ── helpers ──

/** Python str.format()：仅替换已知键，未知 {x} 原样保留。 */
function formatTemplate(template: string, vars: Record<string, string>): string {
  let out = template
  for (const [key, value] of Object.entries(vars)) {
    out = out.split(`{${key}}`).join(value)
  }
  return out
}

function nowHhmm(): string {
  return nowIsoUtc8().slice(11, 16)
}

export function messagesToText(messages: Array<Record<string, unknown>>, runtimeContextProvider: RuntimeContextProvider | null): string {
  const parts: string[] = []
  const runtimeContext = runtimeContextProvider ? runtimeContextProvider(messages) : null
  if (runtimeContext) {
    const content = typeof runtimeContext === 'object' ? (runtimeContext as Record<string, unknown>).content : runtimeContext
    if (content) parts.push(`[system:runtime_context] ${String(content).slice(0, 4000)}`)
  }
  for (const msg of messages) {
    const role = String(msg.role ?? '?')
    const content = msg.content ?? ''
    if (role === 'tool') {
      const snippet = String(content ?? '').slice(0, 500)
      const name = msg.name ?? msg.tool_call_id ?? 'tool'
      parts.push(`[tool_result:${name}] ${snippet}`)
      continue
    }
    if (typeof content === 'string' && content) {
      parts.push(`[${role}] ${capCompactorText(content)}`)
    } else if (Array.isArray(content)) {
      parts.push(...contentBlocksToText(role, content))
    }
    for (const toolCall of (msg.tool_calls as Array<Record<string, unknown>>) ?? []) {
      const fn = (toolCall.function as Record<string, unknown>) ?? {}
      const name = fn.name ?? ''
      const args = fn.arguments ?? '{}'
      parts.push(`[assistant:tool_call] ${name} ${args}`)
    }
  }
  return parts.join('\n')
}

function contentBlocksToText(role: string, blocks: unknown[]): string[] {
  const parts: string[] = []
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue
    const b = block as Record<string, unknown>
    const btype = b.type
    if (btype === 'text') {
      parts.push(`[${role}] ${capCompactorText(String(b.text ?? ''))}`)
    } else if (btype === 'tool_use' || btype === 'tool_call') {
      parts.push(`[${role}:tool_call] ${b.name ?? ''}`)
    } else if (btype === 'tool_result') {
      let c = b.content ?? ''
      if (Array.isArray(c)) {
        c = c.map((x) => (x && typeof x === 'object' ? (x as Record<string, unknown>).text ?? '' : String(x))).join(' ')
      }
      parts.push(`[${role}:tool_result] ${String(c).slice(0, 500)}`)
    }
  }
  return parts
}

function capCompactorText(text: string): string {
  if (text.length <= COMPACTOR_TEXT_MESSAGE_LIMIT) return text
  return `${text.slice(0, COMPACTOR_TEXT_MESSAGE_LIMIT)}\n[truncated, total ${text.length} chars]`
}
