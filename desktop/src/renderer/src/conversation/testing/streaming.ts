// Browser-safe fixtures for the streaming budgets (FIX-04), shared by the
// vitest suites and the Playwright `streaming.spec.ts`:
// - a long raw session log: N settled turns (plain answers, tool steps, a
//   todo list, an approved plan), then an open turn whose answer streams;
// - the live `assistant/chunk` events and `message_delta` runtime events of
//   that answer;
// - a long Markdown reply and the Markdown samples the block renderer is
//   checked against.
import type { WireSessionEvent } from '@emperor/core/runtime-contract'

const ANSWERS = [
  [
    '## 结论',
    '',
    '`src/app.ts` 里的初始化顺序没有问题，问题出在 **缓存失效** 的时机：写入之后没有清掉旧的索引。',
    '',
    '- 先在 `writeIndex` 结束时调用 `invalidate()`；',
    '- 再把读取路径改成每次比较版本号；',
    '- 最后补一条回归测试，覆盖并发写入。',
    '',
    '详见 [设计说明](docs/design/cache.md) 与 https://example.com/cache-notes 。',
  ].join('\n'),
  [
    '可以这样改：',
    '',
    '```ts',
    'export function invalidate(index: Index): void {',
    '  index.version += 1',
    '  index.entries.clear()',
    '}',
    '```',
    '',
    '改完之后运行 `npm test`，三个用例都应通过。',
  ].join('\n'),
  [
    '| 文件 | 改动 | 说明 |',
    '| --- | --- | --- |',
    '| `store.ts` | +12 −3 | 版本号 |',
    '| `reader.ts` | +4 −1 | 比较版本 |',
    '',
    '> 注意：旧版本的数据在升级后会重建一次索引。',
  ].join('\n'),
  [
    'The reader now compares the stored version before trusting the cache.',
    'A stale entry is dropped and read again, so a concurrent writer can no',
    'longer hand out the previous value.',
    '',
    '1. Read the version.',
    '2. Compare it with the cached one.',
    '3. Drop the entry on a mismatch.',
  ].join('\n'),
]

const PLAN = [
  '# 缓存重构计划',
  '',
  '1. 给索引加版本号。',
  '2. 读取时比较版本。',
  '3. 补回归测试。',
].join('\n')

/** One raw event (the wire shape the session window accepts). */
type RawEvent = WireSessionEvent

export interface LongSession {
  readonly events: RawEvent[]
  /** The open turn; its step 1 streams text block 0. */
  readonly openTurn: number
  /** Next seq and time after the log (live chunks continue from here). */
  nextSeq: number
  time: number
}

class Log {
  readonly events: RawEvent[] = []
  constructor(
    public seq: number,
    public time: number,
  ) {}

  add(
    type: string,
    data: unknown,
    extra: Record<string, unknown> = {},
  ): RawEvent {
    this.time += 50
    const event = {
      type,
      seq: this.seq++,
      time: this.time,
      data,
      ...extra,
    } as unknown as RawEvent
    this.events.push(event)
    return event
  }

  user(id: string, text: string): void {
    this.add(
      'user/message',
      {
        id,
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      },
      { surfaceOp: 'append' },
    )
  }

  request(): void {
    this.add('request/context', {
      provider: 'deepseek',
      model: 'deepseek-v4',
      contextWindow: 128_000,
    })
  }

  message(turn: number, step: number, content: unknown[]): void {
    this.add(
      'assistant/message',
      {
        turn,
        step,
        message: {
          id: `assistant-${turn}-${step}`,
          role: 'assistant',
          content,
          source: { kind: 'model', provider: 'deepseek', model: 'deepseek-v4' },
        },
        usage: { inputTokens: 1200 + turn * 40, outputTokens: 180 },
      },
      { surfaceOp: 'append' },
    )
  }

  tool(
    turn: number,
    step: number,
    callId: string,
    name: string,
    args: unknown,
    result: string,
    meta?: unknown,
  ): void {
    this.add('tool/call', {
      turn,
      step,
      callId,
      name,
      arguments: JSON.stringify(args),
    })
    this.add(
      'tool/result',
      {
        turn,
        step,
        message: {
          id: `result-${callId}`,
          role: 'user',
          source: { kind: 'tool', callId },
          content: [
            {
              type: 'tool-result',
              toolCallId: callId,
              content: [{ type: 'text', text: result }],
            },
          ],
        },
        ...(meta === undefined ? {} : { meta }),
      },
      { surfaceOp: 'append' },
    )
  }
}

/**
 * `turns` settled turns, then an open turn (`turns + 1`) streaming its
 * answer: every fourth turn has a tool step before the answer, turn 2 writes
 * a todo list, turn 3 presents an approved plan.
 */
export function longSessionLog(
  turns = 500,
  start = { seq: 0, time: 1_760_000_000_000 },
): LongSession {
  const log = new Log(start.seq, start.time)
  for (let turn = 1; turn <= turns; turn++) {
    log.add('turn/start', { turn })
    log.user(
      `user-${turn}`,
      `第 ${turn} 轮：检查 src/module-${turn}.ts 的缓存逻辑`,
    )
    let step = 1
    if (turn === 3) {
      log.add('step/start', { turn, step })
      log.request()
      log.message(turn, step, [
        {
          type: 'tool-call',
          id: 'call_plan',
          name: 'exit_plan_mode',
          arguments: JSON.stringify({ plan: PLAN }),
        },
      ])
      log.tool(
        turn,
        step,
        'call_plan',
        'exit_plan_mode',
        { plan: PLAN },
        'Plan approved.',
        { approved: true, title: '缓存重构计划' },
      )
      log.add('step/end', { turn, step })
      step++
    } else if (turn % 4 === 0) {
      const callId = `call_read_${turn}`
      log.add('step/start', { turn, step })
      log.request()
      log.message(turn, step, [
        { type: 'text', text: '先读一下实现。' },
        {
          type: 'tool-call',
          id: callId,
          name: 'read',
          arguments: JSON.stringify({ file_path: `src/module-${turn}.ts` }),
        },
      ])
      log.tool(
        turn,
        step,
        callId,
        'read',
        { file_path: `src/module-${turn}.ts` },
        `export const value${turn} = ${turn}\n`,
      )
      log.add('step/end', { turn, step })
      step++
    }
    if (turn === 2)
      log.add('todo/write', {
        todos: [
          { content: '加版本号', status: 'completed' },
          { content: '比较版本', status: 'in_progress' },
          { content: '回归测试', status: 'pending' },
        ],
      })
    log.add('step/start', { turn, step })
    log.request()
    log.message(turn, step, [
      { type: 'text', text: ANSWERS[turn % ANSWERS.length] },
    ])
    log.add('step/end', { turn, step })
    log.add('turn/end', { turn, reason: { kind: 'completed' } })
  }
  const openTurn = turns + 1
  log.add('turn/start', { turn: openTurn })
  log.user(`user-${openTurn}`, '把这些改动整理成一份说明')
  log.add('step/start', { turn: openTurn, step: 1 })
  log.request()
  log.add('assistant/chunk', {
    turn: openTurn,
    step: 1,
    chunk: { type: 'block-start', index: 0, blockType: 'text' },
  })
  return { events: log.events, openTurn, nextSeq: log.seq, time: log.time }
}

/**
 * The open turn's streamed answer as `assistant/chunk` text deltas of
 * `size` characters, continuing the session's seq and time.
 */
export function streamChunks(
  session: LongSession,
  text: string,
  size = 4,
): RawEvent[] {
  const log = new Log(session.nextSeq, session.time)
  for (let index = 0; index < text.length; index += size)
    log.add('assistant/chunk', {
      turn: session.openTurn,
      step: 1,
      chunk: {
        type: 'text-delta',
        index: 0,
        text: text.slice(index, index + size),
      },
    })
  session.nextSeq = log.seq
  session.time = log.time
  return log.events
}

/** The runtime `message_delta` the projector emits for one text chunk. */
export function messageDelta(
  sessionId: string,
  chunk: RawEvent,
  turn: number,
): Record<string, unknown> {
  const data = (chunk as unknown as { data: { chunk: { text: string } } }).data
  return {
    event: 'message_delta',
    seq: chunk.seq * 16,
    ts: new Date(chunk.time).toISOString(),
    session_id: sessionId,
    turn_id: `${sessionId}:${turn}`,
    delta: data.chunk.text,
  }
}

const REPLY_SECTIONS = [
  (n: number) =>
    `## 第 ${n} 部分：缓存与索引\n\n这一部分说明为什么写入之后要立即让旧索引失效。Emperor 在 \`src/store/index-${n}.ts\` 里维护一个按会话分片的索引，读取路径会先比较版本号，再决定是否信任缓存的结果；如果版本落后，就丢掉这一项重新读取。`,
  (n: number) =>
    `- 第一步：在 \`writeIndex()\` 结束时调用 \`invalidate()\`，并记录新的版本号 v${n}；\n- 第二步：读取时先比较版本，落后就重读；\n  - 嵌套说明：并发写入时以最后一次提交为准；\n- 第三步：补一条回归测试，覆盖 ${n} 个并发写入者。`,
  (n: number) =>
    `\`\`\`ts\nexport function invalidate${n}(index: Index): void {\n  index.version += 1\n  index.entries.clear()\n  log.debug('invalidated', { version: index.version })\n}\n\`\`\``,
  (n: number) =>
    `| 指标 | 改动前 | 改动后 |\n| --- | --- | --- |\n| 命中率 | ${60 + (n % 30)}% | ${90 + (n % 9)}% |\n| 平均延迟 | ${(n % 50) + 20} ms | ${(n % 7) + 3} ms |`,
  (n: number) =>
    `> 注意：升级到第 ${n} 版之后，旧数据会在第一次读取时重建索引，这一步可能需要几秒钟。\n> 期间界面保持可用。`,
  (n: number) =>
    `The reader compares the stored version (v${n}) before it trusts the cache. A stale entry is dropped and read again, so a concurrent writer can no longer hand out the previous value. See [the notes](https://example.com/notes/${n}) and [reader.ts](src/reader.ts).`,
  (n: number) =>
    `1. 读取版本号；\n2. 与缓存里的版本比较；\n3. 不一致时丢弃并重读 **第 ${n} 项**；\n4. 一致时直接返回。`,
]

/** A long Markdown reply of at least `chars` characters (headings, lists, code, tables, quotes). */
export function longMarkdownReply(chars = 50_000): string {
  const parts: string[] = []
  let length = 0
  for (let index = 0; length < chars; index++) {
    const section = REPLY_SECTIONS[index % REPLY_SECTIONS.length]!(
      Math.floor(index / REPLY_SECTIONS.length) + 1,
    )
    parts.push(section)
    length += section.length + 2
  }
  return parts.join('\n\n')
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

/** Block templates the Markdown samples are drawn from. */
const SAMPLE_BLOCKS: readonly ((n: number) => string)[] = [
  (n) => `普通段落 ${n}，带 **粗体**、*斜体*、\`code\` 与中文标点。`,
  (n) =>
    `A paragraph ${n} with a soft\nline break and trailing spaces  \nhard break.`,
  (n) => `# 标题 ${n}`,
  (n) => `### Heading ${n} ###`,
  (n) => `Setext heading ${n}\n===`,
  (n) => `Setext two ${n}\n---`,
  (n) => `- item ${n}\n- item two\n- item three`,
  (n) => `- loose ${n}\n\n- loose two\n\n  continued paragraph`,
  (n) => `* nested ${n}\n  * child\n    * grandchild\n* back`,
  (n) => `3. third ${n}\n4. fourth\n5. fifth`,
  (n) => `1. step ${n}\n\n   \`\`\`sh\n   npm test\n   \`\`\`\n2. next`,
  (n) => `> quote ${n}\nlazy continuation\n> > nested`,
  (n) => `> - quoted list ${n}\n> - two`,
  (n) => '```ts\nconst value = ' + n + '\nconsole.log(value)\n```',
  (n) => '~~~\nplain fence ' + n + '\n~~~',
  (n) => `    indented code ${n}\n    second line`,
  (n) =>
    `| a | b | c |\n| --- | :---: | ---: |\n| ${n} | x | y |\n| 2 | **z** | \`w\` |`,
  () => `---`,
  () => `***`,
  (n) =>
    `链接 [文件](src/file-${n}.ts)、[目录](docs/)、[网页](https://example.com/p?q=${n}#h)。`,
  (n) => `Bare URL https://example.com/path/${n}?x=1, and www.example.org too.`,
  (n) =>
    `Image ![本地](assets/pic-${n}.png) and ![远程](https://example.com/i/${n}.png).`,
  (n) => `HTML is text: <div class="x">${n}</div> &amp; &copy; \\*not em\\*`,
  (n) => `- [ ] task ${n}\n- [x] done`,
  (n) => `Paragraph ${n}\n- list interrupts\n- the paragraph`,
  (n) => `Para ${n}\n2. does not interrupt`,
  (n) =>
    `中文混排 English ${n} 与数字 42，路径 /Users/me/project/file.md 结尾。`,
  (n) => `**emphasis across\nlines ${n}** and _underscores_ here.`,
]

/** Reference-definition blocks (the renderer falls back to whole documents). */
const REFERENCE_BLOCKS: readonly ((n: number) => string)[] = [
  (n) =>
    `See [the guide][g${n}] for details.\n\n[g${n}]: https://example.com/guide`,
  (n) => `[ref ${n}]: src/ref.ts\n\nUses [ref ${n}] later.`,
]

/**
 * `count` deterministic Markdown documents mixing every block kind with
 * blank-line and line-break joins; a few end inside an open fence and a few
 * carry reference definitions.
 */
export function markdownSamples(count = 100, seed = 4): string[] {
  const random = mulberry32(seed)
  const pick = <T>(items: readonly T[]): T =>
    items[Math.floor(random() * items.length)] as T
  const samples: string[] = []
  for (let index = 0; index < count; index++) {
    const blocks = 3 + Math.floor(random() * 6)
    const parts: string[] = []
    for (let block = 0; block < blocks; block++) {
      parts.push(pick(SAMPLE_BLOCKS)(index * 10 + block))
      parts.push(random() < 0.8 ? '\n\n' : '\n')
    }
    if (index % 12 === 5) parts.push(pick(REFERENCE_BLOCKS)(index), '\n\n')
    if (index % 9 === 4) parts.push('```js\nconst open = true\nstill open')
    samples.push(parts.join('').replace(/\n+$/u, index % 2 ? '\n' : ''))
  }
  return samples
}
