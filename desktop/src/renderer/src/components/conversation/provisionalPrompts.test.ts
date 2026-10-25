/**
 * BUG-07: a message inserted into the running turn shows at once, as a
 * provisional bubble, until its user message arrives; the queue dock no
 * longer lists it. Nothing reaches Core from here.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { nextTick, ref } from 'vue'
import type { QueuedPromptItem } from '../../types'
import {
  createProvisionalPrompts,
  type ProvisionalPrompts,
} from './provisionalPrompts'

function queued(
  id: string,
  content: string,
  patch: Partial<QueuedPromptItem> = {},
): QueuedPromptItem {
  return {
    id,
    turnId: '',
    clientMessageId: id,
    content,
    delivery: 'queue',
    status: 'queued',
    supportsInterjection: true,
    createdOrder: 1,
    attachmentCount: 0,
    requestedSkillNames: [],
    hasCapabilityRefs: false,
    ...patch,
  }
}

let store: ProvisionalPrompts | null = null
afterEach(() => {
  store?.dispose()
  store = null
})

function setup() {
  const queuedPrompts = ref<QueuedPromptItem[]>([])
  const busy = ref(true)
  const sessionId = ref('s1')
  let listener: ((event: unknown) => void) | null = null
  store = createProvisionalPrompts({
    queuedPrompts,
    busy,
    sessionId,
    subscribe: (fn) => {
      listener = fn
      return () => {
        listener = null
      }
    },
  })
  const emit = (event: Record<string, unknown>) =>
    listener?.({ session_id: 's1', ...event })
  const texts = () => store!.shown.value.map((p) => p.content)
  return { store, queuedPrompts, busy, sessionId, emit, texts }
}

describe('provisional prompts (BUG-07)', () => {
  it('1 · 插入当前执行 shows the message at once and keeps it out of the dock', async () => {
    const f = setup()
    const item = queued('p1', '只统计 src 目录')
    f.queuedPrompts.value = [item]
    // manageQueuedPrompt took it out of the queue; the view then reports it.
    f.queuedPrompts.value = []
    f.store.interjected(item)
    await nextTick()
    expect(f.texts()).toEqual(['只统计 src 目录'])
    expect(f.store.dock.value).toEqual([])
  })

  it('2 · stays through prompt_interjected and the step taking it; leaves with its user message', async () => {
    const f = setup()
    f.store.interjected(queued('p1', '只统计 src 目录'))
    f.emit({
      event: 'prompt_interjected',
      prompt_id: 'p1',
      content: '只统计 src 目录',
    })
    f.emit({ event: 'queue_item_state', prompt_id: 'p1', state: 'sending' })
    await nextTick()
    expect(f.texts()).toEqual(['只统计 src 目录'])
    f.emit({ event: 'user_message', client_message_id: 'p1' })
    expect(f.texts()).toEqual([])
  })

  it('3 · a message sent straight as 插话 shows at once, also after the runtime drops it from the queue', async () => {
    const f = setup()
    f.queuedPrompts.value = [
      queued('p2', '换个思路', {
        delivery: 'interject',
        status: 'interjecting',
      }),
    ]
    await nextTick()
    expect(f.texts()).toEqual(['换个思路'])
    expect(f.store.dock.value).toEqual([])
    // useRuntime removes it on prompt_interjected before this store hears it.
    f.queuedPrompts.value = []
    f.emit({
      event: 'prompt_interjected',
      prompt_id: 'p2',
      content: '换个思路',
    })
    await nextTick()
    expect(f.texts()).toEqual(['换个思路'])
  })

  it('4 · a discarded insertion leaves', () => {
    const f = setup()
    f.store.interjected(queued('p1', '算了'))
    f.emit({ event: 'queue_item_state', prompt_id: 'p1', state: 'discarded' })
    expect(f.texts()).toEqual([])
  })

  it('5 · an interjection event without text for an unknown prompt shows nothing', () => {
    const f = setup()
    f.emit({ event: 'prompt_interjected', prompt_id: 'px' })
    expect(f.texts()).toEqual([])
  })

  it('6 · belongs to its session', async () => {
    const f = setup()
    f.store.interjected(queued('p1', '只统计 src 目录'))
    f.sessionId.value = 's2'
    await nextTick()
    expect(f.texts()).toEqual([])
    f.sessionId.value = 's1'
    await nextTick()
    expect(f.texts()).toEqual(['只统计 src 目录'])
  })

  it('7 · when the turn ends first, Core queues it again: the bubble goes, the dock lists it', async () => {
    const f = setup()
    f.store.interjected(queued('p1', '只统计 src 目录'))
    f.busy.value = false
    f.queuedPrompts.value = [queued('p1', '只统计 src 目录')]
    await nextTick()
    expect(f.texts()).toEqual([])
    expect(f.store.dock.value.map((p) => p.id)).toEqual(['p1'])
  })

  it('8 · a message queued with Enter stays in the dock only', async () => {
    const f = setup()
    f.queuedPrompts.value = [queued('p1', '顺便按行数排序')]
    await nextTick()
    expect(f.texts()).toEqual([])
    expect(f.store.dock.value.map((p) => p.id)).toEqual(['p1'])
  })

  it('9 · gone from the queue once nothing runs: no bubble left behind', async () => {
    const f = setup()
    f.store.interjected(queued('p1', '只统计 src 目录'))
    await nextTick()
    expect(f.texts()).toEqual(['只统计 src 目录'])
    f.busy.value = false
    await nextTick()
    expect(f.texts()).toEqual([])
  })
})
