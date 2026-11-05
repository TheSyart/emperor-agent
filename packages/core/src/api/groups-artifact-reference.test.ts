// CG-04: immutable public group artifacts use the existing owned-reference
// path for text and images; another session cannot resolve the same ref.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { invokeCoreOperation } from './operations'
import { makeApi, type ApiFixture } from './test-helpers'

const fixtures: ApiFixture[] = []
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.api.close()
})

describe('CG-04 public artifact references', () => {
  it('reads a public text file and image in their group, and nowhere else', async () => {
    const fixture = await makeApi()
    fixtures.push(fixture)
    const contact = await invokeCoreOperation(fixture.api, 'contacts.create', [
      { name: '执行者', intro: '公开文件与图片' },
    ])
    const group = await invokeCoreOperation(fixture.api, 'groups.create', [
      { title: '公开成果', members: [contact.id] },
    ])
    const own = fixture.api.groupService.memberWorkspace(
      group.id,
      contact.id,
    ).workspaceRoot
    writeFileSync(join(own, 'report.md'), '# 公开报告\n')
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j98sAAAAASUVORK5CYII=',
      'base64',
    )
    writeFileSync(join(own, 'pixel.png'), png)
    const report = await invokeCoreOperation(
      fixture.api,
      'groups.publishArtifact',
      [
        {
          id: group.id,
          contactId: contact.id,
          sourcePath: join(own, 'report.md'),
          taskId: 'gt-public',
        },
      ],
    )
    const image = await invokeCoreOperation(
      fixture.api,
      'groups.publishArtifact',
      [
        {
          id: group.id,
          contactId: contact.id,
          sourcePath: join(own, 'pixel.png'),
        },
      ],
    )
    expect(report).toMatchObject({
      contactId: contact.id,
      taskId: 'gt-public',
      mimeType: 'text/markdown',
      size: Buffer.byteLength('# 公开报告\n'),
    })
    expect(image.mimeType).toBe('image/png')

    const textReference = await invokeCoreOperation(
      fixture.api,
      'references.resolve',
      [
        {
          sessionId: group.id,
          sourceMessageId: 'gm-public',
          href: report.artifactRef,
          label: report.name,
        },
      ],
    )
    expect(textReference).toMatchObject({
      kind: 'external_file',
      available: true,
      actions: ['reveal', 'preview'],
    })
    expect(
      await invokeCoreOperation(fixture.api, 'files.preview', [
        {
          source: 'reference',
          sessionId: group.id,
          referenceId: textReference.id,
        },
      ]),
    ).toMatchObject({ content: '# 公开报告\n' })

    const imageReference = await invokeCoreOperation(
      fixture.api,
      'references.resolve',
      [
        {
          sessionId: group.id,
          sourceMessageId: 'gm-public',
          href: image.artifactRef,
          label: image.name,
        },
      ],
    )
    expect(
      await fixture.api.references.image({
        sessionId: group.id,
        referenceId: imageReference.id,
      }),
    ).toMatchObject({ dataBase64: png.toString('base64') })

    const memberSessionId = group.members[0]!.memberSessionId!
    const memberReference = await invokeCoreOperation(
      fixture.api,
      'references.resolve',
      [
        {
          sessionId: memberSessionId,
          sourceMessageId: 'gm-public',
          href: report.artifactRef,
          label: report.name,
        },
      ],
    )
    expect(memberReference.available).toBe(true)

    const other = fixture.api.sessions.create({ title: '别的会话' })
    await expect(
      invokeCoreOperation(fixture.api, 'references.resolve', [
        {
          sessionId: String(other.id),
          sourceMessageId: 'gm-other',
          href: report.artifactRef,
          label: report.name,
        },
      ]),
    ).rejects.toThrow()
  })
})
