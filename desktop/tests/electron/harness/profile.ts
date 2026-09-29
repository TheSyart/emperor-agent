/** E-B4 process phase, bundled and launched by the progress experiment. */
import { app } from 'electron'
import { EmbeddedBrowserDriver } from '../../../src/main/computer-use/embedded-browser-driver'
import { electronBrowserFactory } from '../../../src/main/computer-use/electron-factory'
import { nativeImageCodec } from '../../../src/main/computer-use/images'

const id = 'p_0123456789ab'
const phase = process.env.EB4_PHASE ?? ''
const root = process.env.EB4_PROFILE_ROOT ?? ''
const url = process.env.EB4_URL ?? ''

app.on('window-all-closed', () => undefined)
app
  .whenReady()
  .then(async () => {
    const driver = new EmbeddedBrowserDriver({
      electron: electronBrowserFactory(),
      images: nativeImageCodec,
      platform: 'macos',
      profilesRoot: root,
    })
    driver.setNavigationPolicy(() => 'allow')
    try {
      if (phase === 'clear' || phase === 'delete') {
        await driver.clearProfile(id, { remove: phase === 'delete' })
      } else {
        const target = await driver.open(
          {
            profile: {
              kind: 'persistent',
              profileId: phase === 'sweep' ? 'p_aaaaaaaaaaaa' : id,
            },
            url,
            ownerSessionId: 'e-b4',
          },
          new AbortController().signal,
        )
        const tab = driver.manager.get(target.targetId)!
        if (phase === 'write') {
          await tab.session.cookies.set({
            url,
            name: 'eb4',
            value: 'saved',
            expirationDate: Math.floor(Date.now() / 1000) + 86400,
          })
          await tab.contents.executeJavaScript(
            "localStorage.setItem('eb4', 'saved')",
          )
          await tab.session.flushStorageData()
        } else if (phase === 'read' || phase === 'verify') {
          const cookies = await tab.session.cookies.get({ url, name: 'eb4' })
          const localStorage = await tab.contents.executeJavaScript(
            "localStorage.getItem('eb4')",
          )
          process.stdout.write(
            `E-B4 ${JSON.stringify({ phase, cookie: cookies[0]?.value ?? null, localStorage })}\n`,
          )
        }
      }
    } finally {
      await driver.shutdown()
      app.quit()
    }
  })
  .catch((error: unknown) => {
    console.error(error)
    app.exit(1)
  })
