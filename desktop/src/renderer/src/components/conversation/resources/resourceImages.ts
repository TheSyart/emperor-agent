import { attachmentRawUrl } from '../../../api/attachments'
import { openImageViewer } from '../../ui/imageViewer'
import type { DisplayResource } from './resourceModel'

export function openResourceImages(
  resource: DisplayResource,
  owner: string,
  group: readonly DisplayResource[] = [resource],
): void {
  const images = group.filter(
    (item) =>
      item.kind === 'image' &&
      item.attachmentId &&
      item.sourceMessageId === resource.sourceMessageId,
  )
  if (!images.some((item) => item.id === resource.id)) images.push(resource)
  openImageViewer({
    owner,
    index: Math.max(
      0,
      images.findIndex((item) => item.id === resource.id),
    ),
    items: images.flatMap((item) =>
      item.attachmentId
        ? [
            {
              id: item.id,
              src: attachmentRawUrl(item.attachmentId),
              name: item.label,
              file: {
                owner,
                target: {
                  source: 'attachment' as const,
                  attachmentId: item.attachmentId,
                },
              },
            },
          ]
        : [],
    ),
  })
}
