/**
 * Composer 附件管道（W6：从 Composer.vue 下沉）。
 * 负责草稿附件列表、上传进度与拖放交互；组件只保留模板绑定。
 */
import { ref } from 'vue'
import { uploadAttachment } from '../api/attachments'
import type { AttachmentRef } from '../types'

export const MAX_ATTACHMENT_DRAFTS = 5

export function useAttachments(options: { isBusy: () => boolean; onError: (message: string) => void }) {
  const drafts = ref<AttachmentRef[]>([])
  const uploading = ref<Set<string>>(new Set())
  const dragActive = ref(false)

  async function handleFiles(files: FileList | File[] | null) {
    if (!files) return
    const slots = MAX_ATTACHMENT_DRAFTS - drafts.value.length
    if (slots <= 0) {
      options.onError(`最多 ${MAX_ATTACHMENT_DRAFTS} 个附件，请先发送或移除已有的`)
      return
    }
    const list = Array.from(files).slice(0, slots)
    for (const f of list) {
      uploading.value.add(f.name)
      try {
        const ref = await uploadAttachment(f)
        drafts.value.push(ref)
      } catch (err) {
        options.onError(err instanceof Error ? err.message : String(err))
      } finally {
        uploading.value.delete(f.name)
      }
    }
  }

  function onFileInput(e: Event) {
    const target = e.target as HTMLInputElement
    void handleFiles(target.files)
    target.value = ''
  }

  function onDragEnter(e: DragEvent) {
    if (options.isBusy()) return
    if (!hasFiles(e.dataTransfer)) return
    e.preventDefault()
    dragActive.value = true
  }

  function onDragOver(e: DragEvent) {
    if (options.isBusy()) return
    if (!hasFiles(e.dataTransfer)) return
    e.preventDefault()
    dragActive.value = true
  }

  function onDragLeave(e: DragEvent) {
    // 只有真正离开 composer-shell 时才取消高亮
    if (e.target === e.currentTarget) dragActive.value = false
  }

  function onDrop(e: DragEvent) {
    if (options.isBusy()) return
    e.preventDefault()
    dragActive.value = false
    if (!e.dataTransfer?.files?.length) return
    void handleFiles(e.dataTransfer.files)
  }

  function removeDraft(index: number) {
    drafts.value.splice(index, 1)
  }

  function takeDrafts(): AttachmentRef[] {
    const taken = [...drafts.value]
    drafts.value = []
    return taken
  }

  return { drafts, uploading, dragActive, handleFiles, onFileInput, onDragEnter, onDragOver, onDragLeave, onDrop, removeDraft, takeDrafts }
}

function hasFiles(dt: DataTransfer | null): boolean {
  if (!dt) return false
  return Array.from(dt.types || []).includes('Files')
}
