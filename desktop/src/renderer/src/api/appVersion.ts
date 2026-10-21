// REL-05: the running app's version over the preload bridge. Main answers
// app.getVersion() (desktop/package.json in the package); the preload holds
// no version of its own. Null outside the desktop app.

interface AppVersionBridge {
  appVersion?: () => Promise<unknown>
}

function bridge(): AppVersionBridge | undefined {
  return (globalThis as unknown as { window?: { emperor?: AppVersionBridge } })
    .window?.emperor
}

export async function readAppVersion(): Promise<string | null> {
  const read = bridge()?.appVersion
  if (typeof read !== 'function') return null
  try {
    const version = await read()
    return typeof version === 'string' && version.trim() ? version : null
  } catch {
    return null
  }
}
