import { describe, expect, it } from 'vitest'
import { DesktopComputerUsePort } from './port'

describe('DesktopComputerUsePort', () => {
  it('reports every driver, saying why a missing one is missing', async () => {
    // On macOS the desktop driver exists only when the Helper app does, so
    // a missing driver means a missing Helper.
    const mac = await new DesktopComputerUsePort({
      platform: 'darwin',
    }).capabilities()
    expect(
      mac.map(({ driver, stage, label, available, reason }) => [
        driver,
        stage,
        label,
        available,
        reason,
      ]),
    ).toEqual([
      [
        'embedded-browser',
        'unavailable',
        '内置浏览器',
        false,
        '内置浏览器驱动尚未就绪',
      ],
      [
        'external-browser',
        'unavailable',
        'Chrome/Edge 连接',
        false,
        '尚未开放',
      ],
      [
        'desktop',
        'unavailable',
        'macOS 桌面',
        false,
        '没有找到 Emperor Computer Helper',
      ],
    ])

    const linux = await new DesktopComputerUsePort({
      platform: 'linux',
    }).capabilities()
    expect(linux[2]).toMatchObject({
      driver: 'desktop',
      label: '桌面',
      reason: '尚未开放',
    })
  })
})
