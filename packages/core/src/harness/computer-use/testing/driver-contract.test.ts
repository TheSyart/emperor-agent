import { describe, it } from 'vitest'
import { DRIVER_CONTRACT_CASES } from './driver-contract'
import { FakeBrowserDriver } from './fake-browser-driver'
import { OTHER_ORIGIN } from './fixture-pages'

describe('browser driver contract · fake driver', () => {
  it.each(
    DRIVER_CONTRACT_CASES.map((contract) => [contract.name, contract] as const),
  )('%s', async (_name, contract) => {
    const driver = new FakeBrowserDriver()
    await contract.run({
      driver,
      url: (path) => driver.url(path),
      otherUrl: (path) => new URL(path, OTHER_ORIGIN).toString(),
    })
  })
})
